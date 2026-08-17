// Organizational Context Graph (first layer): unit hierarchy, scopes and
// goals with inheritance. ONE BUSINESS → ONE REALITY MODEL → MANY VIEWS.

import { all, get, run, uuid, now } from '../db';

export interface UnitNode {
  id: string; name: string; kind: string; parent_id: string | null;
  children: UnitNode[];
}

export const UNIT_KINDS = ['company', 'business_unit', 'facility', 'department', 'team', 'unit'];

export function unitTree(orgId: string): UnitNode[] {
  const rows = all<{ id: string; name: string; kind: string; parent_id: string | null }>(
    'SELECT id, name, kind, parent_id FROM business_units WHERE org_id = ? ORDER BY name', orgId);
  const nodes = new Map<string, UnitNode>(rows.map(r => [r.id, { ...r, children: [] }]));
  const roots: UnitNode[] = [];
  for (const n of nodes.values()) {
    if (n.parent_id && nodes.has(n.parent_id)) nodes.get(n.parent_id)!.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** A user's scope = their unit + all descendants. Null unit = whole organization. */
export function scopeUnitIds(orgId: string, unitId: string | null): string[] | null {
  if (!unitId) return null; // whole org
  const rows = all<{ id: string; parent_id: string | null }>(
    'SELECT id, parent_id FROM business_units WHERE org_id = ?', orgId);
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parent_id) {
      if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, []);
      childrenOf.get(r.parent_id)!.push(r.id);
    }
  }
  const out: string[] = [];
  const stack = [unitId];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const c of childrenOf.get(cur) ?? []) stack.push(c);
  }
  return out;
}

export function createUnit(orgId: string, name: string, kind: string, parentId: string | null): string {
  const id = uuid();
  run('INSERT INTO business_units (id, org_id, name, kind, parent_id) VALUES (?,?,?,?,?)',
    id, orgId, name, UNIT_KINDS.includes(kind) ? kind : 'unit', parentId);
  return id;
}

// --- Goals with inheritance ---

export interface GoalRow {
  id: string; org_id: string; key: string; label: string; target_value: number;
  period: string; unit_id: string | null; metric: string | null;
  period_start: string | null; period_end: string | null; parent_goal_id: string | null;
  owner: string | null; source: string | null; source_document_id: string | null;
  status: string; created_at: string;
}

export function createGoal(orgId: string, g: {
  label: string; metric: string; target_value: number; period: 'yearly' | 'quarterly' | 'monthly';
  period_start: string; period_end: string; unit_id?: string | null; owner?: string;
  source?: string; source_document_id?: string; parent_goal_id?: string; status?: string;
}): string {
  const id = uuid();
  run(`INSERT INTO goals (id, org_id, key, label, target_value, period, unit_id, metric, period_start, period_end,
        parent_goal_id, owner, source, source_document_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, orgId, g.metric, g.label, g.target_value, g.period, g.unit_id ?? null, g.metric,
    g.period_start, g.period_end, g.parent_goal_id ?? null, g.owner ?? null,
    g.source ?? 'manual', g.source_document_id ?? null, g.status ?? 'active', now());
  return id;
}

/** Break a yearly goal down to monthly child goals (even split, overridable later). */
export function breakdownGoal(orgId: string, goalId: string): number {
  const g = get<GoalRow>('SELECT * FROM goals WHERE id = ? AND org_id = ?', goalId, orgId);
  if (!g || g.period !== 'yearly' || !g.period_start) return 0;
  const existing = get<{ c: number }>('SELECT COUNT(*) as c FROM goals WHERE parent_goal_id = ?', goalId);
  if (existing && existing.c > 0) return 0;
  const year = g.period_start.slice(0, 4);
  let created = 0;
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    createGoal(orgId, {
      label: `${g.label} — ${year}-${mm}`,
      metric: g.metric ?? g.key,
      target_value: Math.round(g.target_value / 12),
      period: 'monthly',
      period_start: `${year}-${mm}-01`,
      period_end: `${year}-${mm}-28`,
      unit_id: g.unit_id,
      owner: g.owner ?? undefined,
      source: 'breakdown',
      parent_goal_id: goalId
    });
    created++;
  }
  return created;
}

/** Find the active goal target for a metric in a given month (org scope by default). */
export function goalTargetForMonth(orgId: string, metric: string, month: string, unitId: string | null = null): { target: number; goal: GoalRow } | null {
  const monthStart = month + '-01';
  const candidates = all<GoalRow>(
    `SELECT * FROM goals WHERE org_id = ? AND status = 'active' AND (metric = ? OR key = ?)
     AND period_start IS NOT NULL AND period_start <= ? AND period_end >= ?
     AND ${unitId ? 'unit_id = ?' : 'unit_id IS NULL'}
     ORDER BY CASE period WHEN 'monthly' THEN 0 WHEN 'quarterly' THEN 1 ELSE 2 END`,
    ...(unitId
      ? [orgId, metric, metric, monthStart, monthStart, unitId]
      : [orgId, metric, metric, monthStart, monthStart]));
  const best = candidates[0];
  if (!best) return null;
  let target = best.target_value;
  if (best.period === 'yearly') target = best.target_value / 12;
  if (best.period === 'quarterly') target = best.target_value / 3;
  return { target, goal: best };
}

export function listGoals(orgId: string): GoalRow[] {
  return all<GoalRow>("SELECT * FROM goals WHERE org_id = ? AND status != 'rejected' ORDER BY period_start DESC, created_at DESC LIMIT 200", orgId);
}

/** Personal Management Context — who the user is, what they own, what applies. */
export function managementContext(orgId: string, userId: string): Record<string, unknown> {
  const user = get<{ id: string; name: string; role: string; unit_id: string | null; responsibilities: string | null }>(
    'SELECT id, name, role, unit_id, responsibilities FROM users WHERE id = ?', userId);
  const unit = user?.unit_id ? get<{ id: string; name: string; kind: string }>(
    'SELECT id, name, kind FROM business_units WHERE id = ?', user.unit_id) : null;
  const scopeIds = scopeUnitIds(orgId, user?.unit_id ?? null);
  const goals = scopeIds
    ? all<GoalRow>(`SELECT * FROM goals WHERE org_id = ? AND status='active' AND (unit_id IS NULL OR unit_id IN (${scopeIds.map(() => '?').join(',')})) AND period != 'monthly' ORDER BY period_start DESC LIMIT 10`, orgId, ...scopeIds)
    : all<GoalRow>("SELECT * FROM goals WHERE org_id = ? AND status='active' AND period != 'monthly' ORDER BY period_start DESC LIMIT 10", orgId);
  return {
    user: { name: user?.name, role: user?.role, responsibilities: user?.responsibilities },
    scope: unit ? { unit: unit.name, kind: unit.kind, includes_descendants: true } : { unit: null, kind: 'organization' },
    scope_unit_ids: scopeIds,
    goals: goals.map(g => ({ label: g.label, metric: g.metric ?? g.key, target: g.target_value, period: g.period, period_start: g.period_start, period_end: g.period_end, owner: g.owner, source: g.source }))
  };
}
