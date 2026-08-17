// HTTP API — session-based for the web app, Bearer API keys for external
// consumers. All queries are tenant-scoped through req.user.org_id.

import { Router, type Request, type Response } from 'express';
import { all, get, run, uuid, now, today } from '../db';
import { hashPassword, verifyPassword, generateApiKey, randomToken } from '../core/crypto';
import { createSession, destroySession, requireAuth, requireAdmin, visibleSeverities, roleLevel } from '../core/auth';
import { audit } from '../core/audit';
import { computeMetrics, getProfile } from '../analysis/metrics';
import { computeLiquidity } from '../analysis/liquidity';
import { runAnalysis, latestRun, computeOverallStatus } from '../analysis/engine';
import { askBusiness } from '../reasoning';
import { generateReport, listReports, getReport, REPORT_TYPES, type ReportType } from '../reports/generator';
import { listAlerts, markAlertRead } from '../alerts/engine';
import {
  listConnectors, getConnector, createDataSource, getDataSource, listDataSources,
  readSourceConfig, makeContext, runSync, disconnectSource, purgeSource
} from '../connectors/registry';
import { ingestCsvContent } from '../connectors/csv';
import { ingestExcelContent } from '../connectors/excel';
import { fortnoxAuthorizeUrl, fortnoxExchangeCode } from '../connectors/fortnox';
import type { FindingRow, Role } from '../domain/types';

export const router = Router();

function bad(res: Response, msg: string, code = 400): void {
  res.status(code).json({ error: msg });
}

// ---------------------------------------------------------------------------
// Auth & bootstrap
// ---------------------------------------------------------------------------

router.post('/auth/register-org', (req: Request, res: Response) => {
  const { org_name, email, name, password, industry } = req.body ?? {};
  if (!org_name || !email || !password || !name) return bad(res, 'org_name, name, email och password krävs');
  if (String(password).length < 8) return bad(res, 'Lösenordet måste vara minst 8 tecken');
  if (get('SELECT id FROM users WHERE email = ?', String(email).toLowerCase())) return bad(res, 'E-postadressen används redan');
  const orgId = uuid();
  run('INSERT INTO organizations (id, name, industry, rss_token, created_at) VALUES (?,?,?,?,?)',
    orgId, org_name, industry || 'general', randomToken(), now());
  const userId = uuid();
  run('INSERT INTO users (id, org_id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, orgId, String(email).toLowerCase(), name, 'admin', hashPassword(password), now());
  run('INSERT INTO alert_prefs (user_id, channel, min_severity, enabled) VALUES (?,?,?,1)', userId, 'in_app', 'medium');
  const sid = createSession(userId);
  audit(orgId, userId, 'org.created', orgId, { org_name });
  res.cookie?.('oi_session', sid);
  res.setHeader('Set-Cookie', `oi_session=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=1209600`);
  res.json({ ok: true, org_id: orgId });
});

router.post('/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  const user = get<{ id: string; org_id: string; password_hash: string }>(
    'SELECT id, org_id, password_hash FROM users WHERE email = ?', String(email ?? '').toLowerCase());
  if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
    audit(null, null, 'auth.login_failed', String(email ?? ''));
    return bad(res, 'Fel e-post eller lösenord', 401);
  }
  const sid = createSession(user.id);
  audit(user.org_id, user.id, 'auth.login');
  res.setHeader('Set-Cookie', `oi_session=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=1209600`);
  res.json({ ok: true });
});

router.post('/auth/logout', requireAuth, (req: Request, res: Response) => {
  const sid = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('oi_session='))?.slice(11);
  if (sid) destroySession(sid);
  res.setHeader('Set-Cookie', 'oi_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const org = get<{ name: string; industry: string; rss_token: string }>(
    'SELECT name, industry, rss_token FROM organizations WHERE id = ?', req.user!.org_id);
  res.json({ user: req.user, org: { name: org?.name, industry: org?.industry }, rss_token: req.user!.role === 'admin' ? org?.rss_token : undefined });
});

// ---------------------------------------------------------------------------
// Business profile (manual data — always labeled as manual)
// ---------------------------------------------------------------------------

export const PROFILE_FIELDS = [
  { key: 'employee_count', label: 'Antal anställda', type: 'number' },
  { key: 'unit_count', label: 'Antal enheter/anläggningar', type: 'number' },
  { key: 'monthly_revenue_target', label: 'Omsättningsmål per månad (kr)', type: 'number' },
  { key: 'annual_budget', label: 'Årsbudget (kr)', type: 'number' },
  { key: 'cash_position', label: 'Aktuell kassaposition (kr)', type: 'number' },
  { key: 'liquidity_buffer', label: 'Önskad likviditetsbuffert (kr)', type: 'number' },
  { key: 'monthly_fixed_costs', label: 'Fasta kostnader per månad (kr)', type: 'number' },
  { key: 'monthly_payroll', label: 'Lönekostnad per månad (kr)', type: 'number' },
  { key: 'important_dates', label: 'Viktiga datum (fritext)', type: 'text' },
  { key: 'internal_goals', label: 'Interna mål (fritext)', type: 'text' },
  { key: 'kpi_definitions', label: 'Egna KPI:er och definitioner (fritext)', type: 'text' }
];

router.get('/profile', requireAuth, (req: Request, res: Response) => {
  const profile = getProfile(req.user!.org_id);
  res.json({ fields: PROFILE_FIELDS, values: profile, source: 'Manuell uppgift (verksamhetsprofil)' });
});

router.put('/profile', requireAuth, (req: Request, res: Response) => {
  const values = req.body?.values ?? {};
  const orgId = req.user!.org_id;
  for (const [key, value] of Object.entries(values)) {
    run(`INSERT INTO business_profile (org_id, key, value, updated_at, updated_by) VALUES (?,?,?,?,?)
         ON CONFLICT (org_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      orgId, key, String(value ?? ''), now(), req.user!.id);
  }
  audit(orgId, req.user!.id, 'profile.updated', undefined, { keys: Object.keys(values) });
  res.json({ ok: true });
});

// Observations (manual)
router.get('/observations', requireAuth, (req: Request, res: Response) => {
  res.json(all('SELECT id, date, category, text, created_at FROM observations WHERE org_id = ? ORDER BY date DESC LIMIT 100', req.user!.org_id));
});

router.post('/observations', requireAuth, (req: Request, res: Response) => {
  const { text, category, date } = req.body ?? {};
  if (!text) return bad(res, 'text krävs');
  run('INSERT INTO observations (id, org_id, user_id, date, category, text, created_at) VALUES (?,?,?,?,?,?,?)',
    uuid(), req.user!.org_id, req.user!.id, date || today(), category || null, text, now());
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Status / dashboard / metrics
// ---------------------------------------------------------------------------

router.get('/status', requireAuth, (req: Request, res: Response) => {
  const orgId = req.user!.org_id;
  const runInfo = latestRun(orgId);
  const sevs = visibleSeverities(req.user!.role as Role);
  const findings = all<FindingRow>(
    `SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') AND severity IN (${sevs.map(() => '?').join(',')})
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, detected_at DESC`,
    orgId, ...sevs
  );
  const unread = get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM alerts WHERE org_id = ? AND read_at IS NULL', orgId);
  res.json({
    overall_status: runInfo?.overall_status ?? computeOverallStatus(findings),
    summary: runInfo?.summary ?? null,
    narrative: runInfo?.narrative ?? null,
    narrative_model: runInfo?.narrative_model ?? null,
    last_analysis_at: runInfo?.finished_at ?? null,
    findings: findings.map(mapFinding),
    unread_alerts: unread?.cnt ?? 0,
    role: req.user!.role
  });
});

router.get('/metrics', requireAuth, (req: Request, res: Response) => {
  res.json(computeMetrics(req.user!.org_id));
});

router.get('/kpis', requireAuth, (req: Request, res: Response) => {
  const pack = computeMetrics(req.user!.org_id);
  const lastIdx = pack.revenueByMonth.length - 2;
  res.json({
    period: lastIdx >= 0 ? pack.revenueByMonth[lastIdx].period : null,
    revenue: lastIdx >= 0 ? pack.revenueByMonth[lastIdx].value : null,
    costs: lastIdx >= 0 ? pack.costsByMonth[lastIdx].value : null,
    result: lastIdx >= 0 ? pack.resultByMonth[lastIdx].value : null,
    receivables_open: pack.receivables.openTotal,
    receivables_overdue: pack.receivables.overdueTotal,
    payables_open: pack.payables.openTotal,
    dso_days: pack.receivables.dsoDays,
    data_coverage: pack.dataCoverage
  });
});

router.post('/analyze', requireAuth, async (req: Request, res: Response) => {
  const result = await runAnalysis(req.user!.org_id);
  audit(req.user!.org_id, req.user!.id, 'analysis.run', result.runId);
  res.json({ ok: true, run_id: result.runId, overall_status: result.overallStatus, new_findings: result.newFindings.length, summary: result.summary });
});

// ---------------------------------------------------------------------------
// Findings & evidence
// ---------------------------------------------------------------------------

function mapFinding(f: FindingRow): Record<string, unknown> {
  return {
    id: f.id, severity: f.severity, category: f.category, epistemic: f.epistemic,
    title: f.title, description: f.description, confidence: f.confidence,
    affected_entities: JSON.parse(f.affected_entities_json ?? '[]'),
    recommended_actions: JSON.parse(f.recommended_actions_json ?? '[]'),
    expected_effect: f.expected_effect, period_start: f.period_start, period_end: f.period_end,
    detected_at: f.detected_at, updated_at: f.updated_at, status: f.status
  };
}

router.get('/findings', requireAuth, (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'open';
  const rows = status === 'all'
    ? all<FindingRow>('SELECT * FROM findings WHERE org_id = ? ORDER BY detected_at DESC LIMIT 200', req.user!.org_id)
    : all<FindingRow>("SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, detected_at DESC", req.user!.org_id);
  res.json(rows.map(mapFinding));
});

router.get('/findings/:id', requireAuth, (req: Request, res: Response) => {
  const f = get<FindingRow>('SELECT * FROM findings WHERE id = ? AND org_id = ?', req.params.id, req.user!.org_id);
  if (!f) return bad(res, 'Finding saknas', 404);
  const evidence = all('SELECT kind, label, value, period, source_label, calculation, data_json FROM evidence WHERE finding_id = ?', f.id);
  const related = all<FindingRow>(
    'SELECT * FROM findings WHERE org_id = ? AND fingerprint = ? AND id != ? ORDER BY detected_at DESC LIMIT 10',
    req.user!.org_id, f.fingerprint, f.id);
  const actions = all('SELECT id, title, owner, priority, due_date, status, expected_effect, completed_at, observed_effect, effect_verified FROM actions WHERE finding_id = ?', f.id);
  res.json({
    ...mapFinding(f),
    evidence: evidence.map((e: Record<string, unknown>) => ({ ...e, data: e.data_json ? JSON.parse(String(e.data_json)) : null, data_json: undefined })),
    history: related.map(r => ({ id: r.id, detected_at: r.detected_at, status: r.status, severity: r.severity })),
    occurrence_count: related.length + 1,
    actions
  });
});

router.post('/findings/:id/status', requireAuth, (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!['open', 'acknowledged', 'resolved', 'dismissed'].includes(status)) return bad(res, 'Ogiltig status');
  run('UPDATE findings SET status = ?, updated_at = ?, resolved_at = CASE WHEN ? IN (\'resolved\',\'dismissed\') THEN ? ELSE resolved_at END WHERE id = ? AND org_id = ?',
    status, now(), status, now(), req.params.id, req.user!.org_id);
  audit(req.user!.org_id, req.user!.id, 'finding.status', req.params.id, { status });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ask the Business
// ---------------------------------------------------------------------------

router.post('/ask', requireAuth, async (req: Request, res: Response) => {
  const { question } = req.body ?? {};
  if (!question) return bad(res, 'question krävs');
  try {
    const result = await askBusiness(req.user!.org_id, req.user!.id, String(question));
    res.json(result);
  } catch (e) {
    bad(res, 'Analysfrågan kunde inte besvaras: ' + String(e), 500);
  }
});

router.get('/ask/history', requireAuth, (req: Request, res: Response) => {
  res.json(all('SELECT id, question, answer, model, asked_at FROM questions WHERE org_id = ? ORDER BY asked_at DESC LIMIT 30', req.user!.org_id));
});

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

router.get('/liquidity', requireAuth, (req: Request, res: Response) => {
  res.json(computeLiquidity(req.user!.org_id));
});

router.get('/forecasts/liquidity', requireAuth, (req: Request, res: Response) => {
  res.json(computeLiquidity(req.user!.org_id));
});

// ---------------------------------------------------------------------------
// Actions & decisions (Management Memory)
// ---------------------------------------------------------------------------

router.get('/actions', requireAuth, (req: Request, res: Response) => {
  res.json(all('SELECT * FROM actions WHERE org_id = ? ORDER BY created_at DESC LIMIT 100', req.user!.org_id));
});

router.post('/actions', requireAuth, (req: Request, res: Response) => {
  const { title, owner, priority, due_date, expected_effect, finding_id } = req.body ?? {};
  if (!title) return bad(res, 'title krävs');
  const id = uuid();
  run('INSERT INTO actions (id, org_id, finding_id, title, owner, priority, due_date, expected_effect, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, req.user!.org_id, finding_id || null, title, owner || null, priority || 'medium', due_date || null, expected_effect || null, 'open', now());
  audit(req.user!.org_id, req.user!.id, 'action.created', id, { title });
  res.json({ ok: true, id });
});

router.post('/actions/:id/status', requireAuth, (req: Request, res: Response) => {
  const { status, observed_effect } = req.body ?? {};
  if (!['open', 'in_progress', 'done', 'cancelled'].includes(status)) return bad(res, 'Ogiltig status');
  run(`UPDATE actions SET status = ?, completed_at = CASE WHEN ? = 'done' THEN ? ELSE completed_at END,
       observed_effect = COALESCE(?, observed_effect),
       effect_verified = CASE WHEN ? = 'done' THEN COALESCE(effect_verified, 'pending') ELSE effect_verified END
       WHERE id = ? AND org_id = ?`,
    status, status, now(), observed_effect ?? null, status, req.params.id, req.user!.org_id);
  audit(req.user!.org_id, req.user!.id, 'action.status', req.params.id, { status });
  res.json({ ok: true });
});

router.get('/decisions', requireAuth, (req: Request, res: Response) => {
  res.json(all('SELECT * FROM decisions WHERE org_id = ? ORDER BY decided_at DESC LIMIT 100', req.user!.org_id));
});

router.post('/decisions', requireAuth, (req: Request, res: Response) => {
  const { title, rationale, owner, expected_result, finding_id } = req.body ?? {};
  if (!title) return bad(res, 'title krävs');
  const id = uuid();
  run('INSERT INTO decisions (id, org_id, finding_id, title, rationale, owner, decided_at, expected_result, status) VALUES (?,?,?,?,?,?,?,?,?)',
    id, req.user!.org_id, finding_id || null, title, rationale || null, owner || req.user!.name, now(), expected_result || null, 'active');
  audit(req.user!.org_id, req.user!.id, 'decision.created', id, { title });
  res.json({ ok: true, id });
});

router.post('/decisions/:id/outcome', requireAuth, (req: Request, res: Response) => {
  const { actual_result, status } = req.body ?? {};
  run('UPDATE decisions SET actual_result = COALESCE(?, actual_result), status = COALESCE(?, status) WHERE id = ? AND org_id = ?',
    actual_result ?? null, status ?? null, req.params.id, req.user!.org_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

router.get('/alerts', requireAuth, (req: Request, res: Response) => {
  res.json(listAlerts(req.user!.org_id));
});

router.post('/alerts/:id/read', requireAuth, (req: Request, res: Response) => {
  markAlertRead(req.user!.org_id, req.params.id);
  res.json({ ok: true });
});

router.get('/alert-prefs', requireAuth, (req: Request, res: Response) => {
  res.json(all('SELECT channel, min_severity, enabled, destination FROM alert_prefs WHERE user_id = ?', req.user!.id));
});

router.put('/alert-prefs', requireAuth, (req: Request, res: Response) => {
  const prefs = req.body?.prefs ?? [];
  for (const p of prefs) {
    if (!['in_app', 'email', 'sms', 'push'].includes(p.channel)) continue;
    run(`INSERT INTO alert_prefs (user_id, channel, min_severity, enabled, destination) VALUES (?,?,?,?,?)
         ON CONFLICT (user_id, channel) DO UPDATE SET min_severity=excluded.min_severity, enabled=excluded.enabled, destination=excluded.destination`,
      req.user!.id, p.channel, p.min_severity || 'high', p.enabled ? 1 : 0, p.destination || null);
  }
  res.json({ ok: true });
});

router.get('/notifications/outbox', requireAdmin, (req: Request, res: Response) => {
  res.json(all('SELECT channel, destination, title, status, detail, created_at FROM notifications_outbox WHERE org_id = ? ORDER BY created_at DESC LIMIT 50', req.user!.org_id));
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

router.get('/reports', requireAuth, (req: Request, res: Response) => {
  res.json({ types: REPORT_TYPES, reports: listReports(req.user!.org_id) });
});

router.post('/reports', requireAuth, async (req: Request, res: Response) => {
  const { type, custom_prompt } = req.body ?? {};
  if (!REPORT_TYPES.some(t => t.key === type)) return bad(res, 'Ogiltig rapporttyp');
  const result = await generateReport(req.user!.org_id, type as ReportType, req.user!.id, custom_prompt);
  audit(req.user!.org_id, req.user!.id, 'report.generated', result.id, { type });
  res.json({ ok: true, id: result.id, title: result.title, content: result.content });
});

router.get('/reports/:id', requireAuth, (req: Request, res: Response) => {
  const r = getReport(req.user!.org_id, req.params.id);
  if (!r) return bad(res, 'Rapport saknas', 404);
  res.json({ id: r.id, type: r.type, title: r.title, created_at: r.created_at, content: JSON.parse(r.content_json) });
});

// ---------------------------------------------------------------------------
// Integrations / connectors
// ---------------------------------------------------------------------------

router.get('/connectors', requireAuth, (req: Request, res: Response) => {
  res.json(listConnectors().map(c => ({
    key: c.key, name: c.name, description: c.description, auth_kind: c.authKind,
    datasets: c.datasets, config_fields: c.configFields.map(f => ({ ...f })),
    availability: c.available()
  })));
});

router.get('/sources', requireAuth, (req: Request, res: Response) => {
  res.json(listDataSources(req.user!.org_id).map(s => ({
    id: s.id, connector_key: s.connector_key, name: s.name, status: s.status,
    last_sync_at: s.last_sync_at, last_sync_status: s.last_sync_status, last_error: s.last_error,
    created_at: s.created_at, disconnected_at: s.disconnected_at
    // config_encrypted is deliberately never exposed
  })));
});

router.post('/sources', requireAdmin, (req: Request, res: Response) => {
  const { connector_key, name, config: cfg } = req.body ?? {};
  const connector = getConnector(connector_key);
  if (!connector) return bad(res, 'Okänd connector');
  const avail = connector.available();
  if (!avail.ok) return bad(res, avail.reason || 'Connectorn är inte tillgänglig i denna miljö');
  const src = createDataSource(req.user!.org_id, connector_key, name || connector.name, cfg ?? {});
  audit(req.user!.org_id, req.user!.id, 'source.created', src.id, { connector_key });
  res.json({ ok: true, id: src.id });
});

router.post('/sources/:id/test', requireAdmin, async (req: Request, res: Response) => {
  const src = getDataSource(req.user!.org_id, req.params.id);
  if (!src) return bad(res, 'Källa saknas', 404);
  const connector = getConnector(src.connector_key);
  if (!connector) return bad(res, 'Okänd connector');
  const status = await connector.testConnection(makeContext(src), readSourceConfig(src));
  res.json(status);
});

router.post('/sources/:id/sync', requireAdmin, async (req: Request, res: Response) => {
  const src = getDataSource(req.user!.org_id, req.params.id);
  if (!src) return bad(res, 'Källa saknas', 404);
  if (src.status === 'disconnected') return bad(res, 'Källan är bortkopplad');
  const result = await runSync(src);
  audit(req.user!.org_id, req.user!.id, 'source.synced', src.id, result.stats as object);
  res.json(result);
});

router.post('/sources/:id/upload', requireAdmin, (req: Request, res: Response) => {
  const src = getDataSource(req.user!.org_id, req.params.id);
  if (!src) return bad(res, 'Källa saknas', 404);
  const { filename, content, content_base64, dataset } = req.body ?? {};
  if (!filename) return bad(res, 'filename krävs');
  const ctx = makeContext(src);
  let result;
  if (src.connector_key === 'excel' || /\.xlsx?$/i.test(String(filename))) {
    if (!content_base64) return bad(res, 'content_base64 krävs för Excel');
    result = ingestExcelContent(ctx, { filename, contentBase64: content_base64, dataset });
  } else {
    const text = content ?? (content_base64 ? Buffer.from(content_base64, 'base64').toString('utf8') : null);
    if (!text) return bad(res, 'content krävs');
    result = ingestCsvContent(ctx, { filename, content: text, dataset });
  }
  run('UPDATE data_sources SET last_sync_at = ?, last_sync_status = ?, status = ?, last_error = ? WHERE id = ?',
    now(), result.ok ? 'ok' : 'error', result.ok ? 'connected' : 'error', result.error ?? null, src.id);
  audit(req.user!.org_id, req.user!.id, 'source.upload', src.id, { filename, datasets: result.datasets });
  res.json(result);
});

router.post('/sources/:id/disconnect', requireAdmin, (req: Request, res: Response) => {
  if (!disconnectSource(req.user!.org_id, req.params.id)) return bad(res, 'Källa saknas', 404);
  audit(req.user!.org_id, req.user!.id, 'source.disconnected', req.params.id);
  res.json({ ok: true });
});

router.delete('/sources/:id', requireAdmin, (req: Request, res: Response) => {
  if (!purgeSource(req.user!.org_id, req.params.id)) return bad(res, 'Källa saknas', 404);
  audit(req.user!.org_id, req.user!.id, 'source.purged', req.params.id);
  res.json({ ok: true });
});

// Fortnox OAuth flow
router.get('/connect/fortnox/start', requireAdmin, (req: Request, res: Response) => {
  const connector = getConnector('fortnox')!;
  const avail = connector.available();
  if (!avail.ok) return bad(res, avail.reason || 'Fortnox ej konfigurerad');
  const sourceId = typeof req.query.source_id === 'string' ? req.query.source_id : '';
  const src = getDataSource(req.user!.org_id, sourceId);
  if (!src) return bad(res, 'Skapa först en Fortnox-källa');
  const state = randomToken();
  run('UPDATE data_sources SET config_encrypted = ? WHERE id = ?', null, src.id);
  const cfg = { oauth_state: state };
  makeContext(src).saveConfig(cfg);
  res.json({ url: fortnoxAuthorizeUrl(`${src.id}.${state}`) });
});

// ---------------------------------------------------------------------------
// Admin: users, API keys, audit
// ---------------------------------------------------------------------------

router.get('/users', requireAuth, (req: Request, res: Response) => {
  if (roleLevel(req.user!.role as Role) < 3) return bad(res, 'Behörighet saknas', 403);
  res.json(all('SELECT id, email, name, role, created_at FROM users WHERE org_id = ?', req.user!.org_id));
});

router.post('/users', requireAdmin, (req: Request, res: Response) => {
  const { email, name, password, role } = req.body ?? {};
  if (!email || !name || !password) return bad(res, 'email, name och password krävs');
  const validRoles = ['technician', 'team_manager', 'department_manager', 'facility_manager', 'executive', 'admin'];
  if (!validRoles.includes(role)) return bad(res, 'Ogiltig roll');
  if (get('SELECT id FROM users WHERE email = ?', String(email).toLowerCase())) return bad(res, 'E-postadressen används redan');
  const id = uuid();
  run('INSERT INTO users (id, org_id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    id, req.user!.org_id, String(email).toLowerCase(), name, role, hashPassword(password), now());
  run('INSERT INTO alert_prefs (user_id, channel, min_severity, enabled) VALUES (?,?,?,1)', id, 'in_app', 'medium');
  audit(req.user!.org_id, req.user!.id, 'user.created', id, { email, role });
  res.json({ ok: true, id });
});

router.get('/api-keys', requireAdmin, (req: Request, res: Response) => {
  res.json(all('SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = ?', req.user!.org_id));
});

router.post('/api-keys', requireAdmin, (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  const { key, prefix, hash } = generateApiKey();
  const id = uuid();
  run('INSERT INTO api_keys (id, org_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)',
    id, req.user!.org_id, name || 'API-nyckel', prefix, hash, now());
  audit(req.user!.org_id, req.user!.id, 'api_key.created', id);
  // The full key is shown exactly once, never stored in plaintext.
  res.json({ ok: true, id, key });
});

router.post('/api-keys/:id/revoke', requireAdmin, (req: Request, res: Response) => {
  run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ?', now(), req.params.id, req.user!.org_id);
  audit(req.user!.org_id, req.user!.id, 'api_key.revoked', req.params.id);
  res.json({ ok: true });
});

router.get('/audit', requireAdmin, (req: Request, res: Response) => {
  res.json(all('SELECT user_id, action, target, detail_json, at FROM audit_log WHERE org_id = ? ORDER BY at DESC LIMIT 100', req.user!.org_id));
});

// GDPR-style org data purge
router.delete('/org/data', requireAdmin, (req: Request, res: Response) => {
  const orgId = req.user!.org_id;
  for (const table of ['transactions', 'invoices', 'raw_records', 'customers', 'suppliers', 'employees', 'findings', 'evidence', 'alerts', 'reports', 'observations', 'questions', 'actions', 'decisions', 'analysis_runs', 'sync_runs', 'notifications_outbox']) {
    run(`DELETE FROM ${table} WHERE org_id = ?`, orgId);
  }
  audit(orgId, req.user!.id, 'org.data_purged');
  res.json({ ok: true });
});
