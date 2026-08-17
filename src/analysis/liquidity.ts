// Liquidity forecast — deterministic 13-week cash projection built from
// open invoices, fixed costs, payroll and the manually stated cash position.

import { all } from '../db';
import type { LiquidityForecast, LiquidityWeek } from '../domain/types';
import { getProfile, profileNumber, round2 } from './metrics';

function weekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

export function computeLiquidity(orgId: string, opts: { weeks?: number; asOf?: string } = {}): LiquidityForecast {
  const nWeeks = opts.weeks ?? 13;
  const asOf = opts.asOf ? new Date(opts.asOf + 'T00:00:00Z') : new Date();
  const profile = getProfile(orgId);
  const startBalance = profileNumber(profile, 'cash_position');
  const bufferTarget = profileNumber(profile, 'liquidity_buffer');
  const monthlyFixed = profileNumber(profile, 'monthly_fixed_costs') ?? 0;
  const monthlyPayroll = profileNumber(profile, 'monthly_payroll') ?? 0;

  const assumptions: string[] = [];
  assumptions.push(startBalance !== null
    ? `Utgående kassaposition ${fmt(startBalance)} kr enligt verksamhetsprofilen (manuell uppgift).`
    : 'Ingen kassaposition angiven — prognosen visar nettoflöden, inte saldo.');
  if (monthlyFixed) assumptions.push(`Fasta kostnader ${fmt(monthlyFixed)} kr/mån fördelas jämnt per vecka (manuell uppgift).`);
  if (monthlyPayroll) assumptions.push(`Löner ${fmt(monthlyPayroll)} kr/mån belastar vecka med den 25:e (manuell uppgift).`);

  // Historical average payment delay on paid customer invoices → shift expected inflows.
  const paidDelays = all<{ d: number }>(
    `SELECT (julianday(paid_date) - julianday(due_date)) as d FROM invoices
     WHERE org_id = ? AND kind='customer' AND status='paid' AND paid_date IS NOT NULL AND due_date IS NOT NULL
     ORDER BY paid_date DESC LIMIT 100`, orgId
  );
  let avgDelay = 0;
  if (paidDelays.length >= 5) {
    avgDelay = Math.max(0, Math.round(paidDelays.reduce((a, r) => a + r.d, 0) / paidDelays.length));
    if (avgDelay > 0) assumptions.push(`Kunder betalar historiskt i snitt ${avgDelay} dagar efter förfallodatum — inflöden förskjuts motsvarande.`);
  }

  const weeks: LiquidityWeek[] = [];
  const start = weekStart(asOf);
  for (let i = 0; i < nWeeks; i++) {
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i * 7);
    weeks.push({ weekStart: d.toISOString().slice(0, 10), inflow: 0, outflow: 0, balance: 0, notes: [] });
  }
  const horizonEnd = new Date(weeks[weeks.length - 1].weekStart + 'T00:00:00Z');
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 7);

  function weekIndexFor(dateStr: string, shiftDays = 0): number {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + shiftDays);
    if (d < new Date(start + 'T00:00:00Z')) return 0; // overdue lands "now"
    const idx = Math.floor((d.getTime() - new Date(start + 'T00:00:00Z').getTime()) / (7 * 86400000));
    return idx;
  }

  // Inflows: open customer invoices at (due date + historical delay)
  const openCust = all<{ balance: number; due_date: string | null; counterparty_name: string | null }>(
    `SELECT balance, due_date, counterparty_name FROM invoices
     WHERE org_id = ? AND kind='customer' AND status IN ('open','overdue') AND balance > 0`, orgId
  );
  for (const inv of openCust) {
    const idx = weekIndexFor(inv.due_date ?? start, avgDelay);
    if (idx >= 0 && idx < nWeeks) {
      weeks[idx].inflow += inv.balance;
    }
  }

  // Outflows: open supplier invoices at due date
  const openSup = all<{ balance: number; due_date: string | null }>(
    `SELECT balance, due_date FROM invoices
     WHERE org_id = ? AND kind='supplier' AND status IN ('open','overdue') AND balance > 0`, orgId
  );
  for (const inv of openSup) {
    const idx = weekIndexFor(inv.due_date ?? start);
    if (idx >= 0 && idx < nWeeks) weeks[idx].outflow += inv.balance;
  }

  // Fixed costs spread weekly; payroll on the week containing the 25th.
  const weeklyFixed = (monthlyFixed * 12) / 52;
  for (let i = 0; i < nWeeks; i++) {
    weeks[i].outflow += weeklyFixed;
    const ws = new Date(weeks[i].weekStart + 'T00:00:00Z');
    for (let dd = 0; dd < 7; dd++) {
      const day = new Date(ws); day.setUTCDate(day.getUTCDate() + dd);
      if (day.getUTCDate() === 25 && monthlyPayroll > 0) {
        weeks[i].outflow += monthlyPayroll;
        weeks[i].notes.push('Löneutbetalning');
      }
    }
  }

  // Running balance
  let bal = startBalance ?? 0;
  let minBalance: number | null = null;
  let minWeek: string | null = null;
  for (const w of weeks) {
    bal = bal + w.inflow - w.outflow;
    w.inflow = round2(w.inflow); w.outflow = round2(w.outflow);
    w.balance = round2(bal);
    if (minBalance === null || w.balance < minBalance) { minBalance = w.balance; minWeek = w.weekStart; }
  }

  let riskLevel: LiquidityForecast['riskLevel'] = 'unknown';
  if (startBalance !== null && minBalance !== null) {
    if (minBalance < 0) riskLevel = 'critical';
    else if (bufferTarget !== null && minBalance < bufferTarget * 0.5) riskLevel = 'high';
    else if (bufferTarget !== null && minBalance < bufferTarget) riskLevel = 'medium';
    else riskLevel = 'low';
  }

  assumptions.push('Prognosen bygger endast på kända fakturor och angivna fasta belopp — framtida ny försäljning ingår inte.');

  return {
    startBalance,
    startBalanceSource: 'Verksamhetsprofil (manuell uppgift)',
    bufferTarget,
    weeks,
    minBalance,
    minWeek,
    riskLevel,
    assumptions
  };
}

function fmt(n: number): string {
  return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(n);
}
