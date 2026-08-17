// Productivity — deterministic computation on granular time entries
// (person × day × work order). Aggregates upward: employee → unit → week →
// company, while the underlying evidence stays reachable.

import { all } from '../db';
import { round2 } from './metrics';

export interface ProductivityPack {
  hasData: boolean;
  weeks: { week: string; worked: number; billed: number; ratio: number | null }[];
  byUnit: { unit: string; unitId: string | null; recentRatio: number | null; baselineRatio: number | null; change: number | null; worked: number }[];
  byEmployee: { name: string; unit: string | null; recentRatio: number | null; baselineRatio: number | null; change: number | null; workedRecent: number }[];
  overall: {
    recentRatio: number | null;    // last 3 weeks
    baselineRatio: number | null;  // prior 6 weeks
    change: number | null;         // relative change
    workedRecent: number;
    workedBaseline: number;        // weekly average
    hoursNormal: boolean;          // recent worked volume within ±10% of baseline
  };
  recentWeeks: string[];
  baselineWeeks: string[];
}

function weekOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

export function computeProductivity(orgId: string): ProductivityPack {
  const rows = all<{ date: string; employee_name: string | null; unit_id: string | null; hours_worked: number; hours_billed: number | null }>(
    'SELECT date, employee_name, unit_id, hours_worked, hours_billed FROM time_entries WHERE org_id = ? ORDER BY date', orgId);
  if (rows.length === 0) {
    return { hasData: false, weeks: [], byUnit: [], byEmployee: [], overall: { recentRatio: null, baselineRatio: null, change: null, workedRecent: 0, workedBaseline: 0, hoursNormal: true }, recentWeeks: [], baselineWeeks: [] };
  }
  const unitNames = new Map<string, string>();
  for (const u of all<{ id: string; name: string }>('SELECT id, name FROM business_units WHERE org_id = ?', orgId)) unitNames.set(u.id, u.name);

  const byWeek = new Map<string, { worked: number; billed: number }>();
  for (const r of rows) {
    const w = weekOf(r.date);
    const agg = byWeek.get(w) ?? { worked: 0, billed: 0 };
    agg.worked += r.hours_worked;
    agg.billed += r.hours_billed ?? 0;
    byWeek.set(w, agg);
  }
  const weekKeys = [...byWeek.keys()].sort();
  const weeks = weekKeys.map(w => {
    const a = byWeek.get(w)!;
    return { week: w, worked: round2(a.worked), billed: round2(a.billed), ratio: a.worked > 0 ? round2(a.billed / a.worked * 100) / 100 : null };
  });

  // Recent = last 3 complete-ish weeks; baseline = the 6 weeks before that.
  const recentWeeks = weekKeys.slice(-3);
  const baselineWeeks = weekKeys.slice(-9, -3);
  const recentSet = new Set(recentWeeks);
  const baselineSet = new Set(baselineWeeks);

  function ratioFor(filter: (r: typeof rows[number]) => boolean, set: Set<string>): { worked: number; billed: number } {
    let worked = 0, billed = 0;
    for (const r of rows) {
      if (!filter(r)) continue;
      if (!set.has(weekOf(r.date))) continue;
      worked += r.hours_worked; billed += r.hours_billed ?? 0;
    }
    return { worked, billed };
  }

  function pack(recent: { worked: number; billed: number }, base: { worked: number; billed: number }) {
    const recentRatio = recent.worked > 0 ? recent.billed / recent.worked : null;
    const baselineRatio = base.worked > 0 ? base.billed / base.worked : null;
    const change = recentRatio !== null && baselineRatio !== null && baselineRatio > 0
      ? (recentRatio - baselineRatio) / baselineRatio : null;
    return { recentRatio: recentRatio !== null ? round2(recentRatio * 100) / 100 : null, baselineRatio: baselineRatio !== null ? round2(baselineRatio * 100) / 100 : null, change };
  }

  const allRecent = ratioFor(() => true, recentSet);
  const allBase = ratioFor(() => true, baselineSet);
  const overallPack = pack(allRecent, allBase);
  const weeklyBaseWorked = baselineWeeks.length ? allBase.worked / baselineWeeks.length : 0;
  const weeklyRecentWorked = recentWeeks.length ? allRecent.worked / recentWeeks.length : 0;
  const hoursNormal = weeklyBaseWorked > 0 ? Math.abs(weeklyRecentWorked - weeklyBaseWorked) / weeklyBaseWorked <= 0.10 : true;

  const unitIds = new Set(rows.map(r => r.unit_id ?? '__none__'));
  const byUnit = [...unitIds].map(uid => {
    const filter = (r: typeof rows[number]) => (r.unit_id ?? '__none__') === uid;
    const p = pack(ratioFor(filter, recentSet), ratioFor(filter, baselineSet));
    return {
      unit: uid === '__none__' ? 'Ej angiven enhet' : (unitNames.get(uid) ?? 'Okänd enhet'),
      unitId: uid === '__none__' ? null : uid,
      ...p,
      worked: round2(ratioFor(filter, recentSet).worked)
    };
  }).sort((a, b) => (a.change ?? 0) - (b.change ?? 0));

  const empNames = new Set(rows.map(r => r.employee_name ?? 'Okänd'));
  const byEmployee = [...empNames].map(name => {
    const filter = (r: typeof rows[number]) => (r.employee_name ?? 'Okänd') === name;
    const p = pack(ratioFor(filter, recentSet), ratioFor(filter, baselineSet));
    const unitId = rows.find(r => (r.employee_name ?? 'Okänd') === name)?.unit_id ?? null;
    return {
      name,
      unit: unitId ? (unitNames.get(unitId) ?? null) : null,
      ...p,
      workedRecent: round2(ratioFor(filter, recentSet).worked)
    };
  }).sort((a, b) => (a.change ?? 0) - (b.change ?? 0));

  return {
    hasData: true,
    weeks,
    byUnit,
    byEmployee,
    overall: {
      ...overallPack,
      workedRecent: round2(weeklyRecentWorked),
      workedBaseline: round2(weeklyBaseWorked),
      hoursNormal
    },
    recentWeeks,
    baselineWeeks
  };
}
