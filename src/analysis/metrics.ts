// Deterministic metric computation. All economic numbers are produced here,
// by code — never by a language model.

import { all, get } from '../db';
import type { MetricPack, MonthPoint } from '../domain/types';
import { getSettingNumber } from '../core/settings';

function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function lastNMonths(n: number, ref?: string): string[] {
  const refDate = ref ? new Date(ref + '-01T00:00:00Z') : new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function seriesFor(months: string[], byMonth: Map<string, number>): MonthPoint[] {
  return months.map(m => ({ period: m, value: round2(byMonth.get(m) ?? 0) }));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeMetrics(orgId: string, opts: { months?: number; asOf?: string } = {}): MetricPack {
  const nMonths = opts.months ?? (getSettingNumber(orgId, 'intelligence.history_months') || 13);
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);

  const txs = all<{ date: string; amount: number; kind: string; category: string | null; unit_id: string | null }>(
    'SELECT date, amount, kind, category, unit_id FROM transactions WHERE org_id = ? AND date <= ? ORDER BY date', orgId, asOf
  );

  const range = get<{ min: string | null; max: string | null; cnt: number }>(
    'SELECT MIN(date) as min, MAX(date) as max, COUNT(*) as cnt FROM transactions WHERE org_id = ?', orgId
  );
  const refMonth = range?.max ? monthOf(range.max) : monthOf(asOf);
  const months = lastNMonths(nMonths, refMonth);
  const monthSet = new Set(months);

  const revByMonth = new Map<string, number>();
  const costByMonth = new Map<string, number>();
  const unitRev = new Map<string, Map<string, number>>();
  const catCost = new Map<string, Map<string, number>>();

  for (const t of txs) {
    const m = monthOf(t.date);
    if (!monthSet.has(m)) continue;
    if (t.kind === 'revenue') {
      revByMonth.set(m, (revByMonth.get(m) ?? 0) + t.amount);
      const key = t.unit_id ?? '__none__';
      if (!unitRev.has(key)) unitRev.set(key, new Map());
      unitRev.get(key)!.set(m, (unitRev.get(key)!.get(m) ?? 0) + t.amount);
    } else if (t.kind === 'cost') {
      costByMonth.set(m, (costByMonth.get(m) ?? 0) + t.amount);
      const cat = t.category ?? 'övrigt';
      if (!catCost.has(cat)) catCost.set(cat, new Map());
      catCost.get(cat)!.set(m, (catCost.get(cat)!.get(m) ?? 0) + t.amount);
    }
  }

  const unitNames = new Map<string, string>();
  for (const u of all<{ id: string; name: string }>('SELECT id, name FROM business_units WHERE org_id = ?', orgId)) {
    unitNames.set(u.id, u.name);
  }

  // Receivables
  const openInv = all<{ counterparty_name: string | null; amount: number; balance: number; due_date: string | null; issue_date: string | null; paid_date: string | null; status: string }>(
    "SELECT counterparty_name, amount, balance, due_date, issue_date, paid_date, status FROM invoices WHERE org_id = ? AND kind = 'customer'", orgId
  );
  let openTotal = 0, openCount = 0, overdueTotal = 0, overdueCount = 0;
  const debtors = new Map<string, { open: number; overdue: number }>();
  for (const inv of openInv) {
    if (inv.status === 'open' || inv.status === 'overdue') {
      openTotal += inv.balance; openCount++;
      const isOverdue = inv.due_date !== null && inv.due_date < asOf;
      if (isOverdue) { overdueTotal += inv.balance; overdueCount++; }
      const name = inv.counterparty_name ?? 'Okänd kund';
      const d = debtors.get(name) ?? { open: 0, overdue: 0 };
      d.open += inv.balance;
      if (isOverdue) d.overdue += inv.balance;
      debtors.set(name, d);
    }
  }
  // DSO approximation: average days from issue to payment on paid invoices (last 6 months)
  const paid = openInv.filter(i => i.status === 'paid' && i.paid_date && i.issue_date && i.paid_date >= addMonths(asOf, -6));
  let dsoDays: number | null = null;
  if (paid.length >= 3) {
    const days = paid.map(i => (Date.parse(i.paid_date!) - Date.parse(i.issue_date!)) / 86400000);
    dsoDays = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
  }

  // Payables
  const pay = get<{ open: number | null; overdue: number | null }>(
    `SELECT SUM(CASE WHEN status IN ('open','overdue') THEN balance ELSE 0 END) as open,
            SUM(CASE WHEN status = 'overdue' OR (status='open' AND due_date < ?) THEN balance ELSE 0 END) as overdue
     FROM invoices WHERE org_id = ? AND kind = 'supplier'`, asOf, orgId
  );

  // Customer concentration: revenue by customer via invoices last 3 months
  const conc = all<{ name: string; total: number }>(
    `SELECT COALESCE(counterparty_name, 'Okänd kund') as name, SUM(amount) as total
     FROM invoices WHERE org_id = ? AND kind = 'customer' AND status != 'cancelled' AND issue_date >= ?
     GROUP BY COALESCE(counterparty_name, 'Okänd kund') ORDER BY total DESC LIMIT 8`, orgId, addMonths(asOf, -3)
  );
  const concTotal = conc.reduce((a, c) => a + c.total, 0);

  const invCount = get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM invoices WHERE org_id = ?', orgId);
  const sources = all<{ id: string; name: string; connector_key: string }>(
    "SELECT id, name, connector_key FROM data_sources WHERE org_id = ? AND status != 'disconnected'", orgId
  );

  const monthsOfHistory = range?.min && range?.max
    ? Math.max(1, monthDiff(monthOf(range.min), monthOf(range.max)) + 1)
    : 0;

  const revenueByMonth = seriesFor(months, revByMonth);
  const costsByMonth = seriesFor(months, costByMonth);

  return {
    months,
    revenueByMonth,
    costsByMonth,
    resultByMonth: months.map((m, i) => ({ period: m, value: round2(revenueByMonth[i].value - costsByMonth[i].value) })),
    revenueByUnit: [...unitRev.entries()].map(([unitId, mm]) => ({
      unit: unitId === '__none__' ? 'Ej angiven enhet' : (unitNames.get(unitId) ?? 'Okänd enhet'),
      unitId: unitId === '__none__' ? null : unitId,
      months: seriesFor(months, mm)
    })),
    costByCategory: [...catCost.entries()].map(([category, mm]) => ({ category, months: seriesFor(months, mm) })),
    receivables: {
      openTotal: round2(openTotal), openCount,
      overdueTotal: round2(overdueTotal), overdueCount,
      dsoDays,
      topDebtors: [...debtors.entries()].map(([name, d]) => ({ name, open: round2(d.open), overdue: round2(d.overdue) }))
        .sort((a, b) => b.open - a.open).slice(0, 5)
    },
    payables: { openTotal: round2(pay?.open ?? 0), overdueTotal: round2(pay?.overdue ?? 0) },
    customerConcentration: conc.map(c => ({ name: c.name, revenue: round2(c.total), share: concTotal > 0 ? round2(c.total / concTotal) : 0 })),
    dataCoverage: {
      sources: sources.map(s => ({ id: s.id, name: s.name, connector: s.connector_key })),
      firstDate: range?.min ?? null,
      lastDate: range?.max ?? null,
      txCount: range?.cnt ?? 0,
      invoiceCount: invCount?.cnt ?? 0,
      monthsOfHistory
    }
  };
}

export function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function addMonths(date: string, n: number): string {
  const d = new Date(date + (date.length === 7 ? '-01' : '') + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Average of the last n complete values excluding the final one (trailing baseline). */
export function trailingAvg(points: MonthPoint[], excludeLast = 1, window = 6): number | null {
  const usable = points.slice(0, points.length - excludeLast).filter(p => p.value !== 0);
  if (usable.length < 3) return null;
  const win = usable.slice(-window);
  return win.reduce((a, p) => a + p.value, 0) / win.length;
}

export function getProfile(orgId: string): Record<string, string> {
  const rows = all<{ key: string; value: string | null }>('SELECT key, value FROM business_profile WHERE org_id = ?', orgId);
  const out: Record<string, string> = {};
  for (const r of rows) if (r.value !== null) out[r.key] = r.value;
  return out;
}

export function profileNumber(profile: Record<string, string>, key: string): number | null {
  const v = profile[key];
  if (v === undefined || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
