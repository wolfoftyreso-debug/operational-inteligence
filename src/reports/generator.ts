// Report generator — reports are rendered from the same structured findings,
// metrics and memory that drive the dashboard. One data spine, many outputs.

import { all, get, run, uuid, now, today } from '../db';
import type { FindingRow } from '../domain/types';
import { computeMetrics, getProfile } from '../analysis/metrics';
import { computeLiquidity } from '../analysis/liquidity';
import { latestRun } from '../analysis/engine';
import { getProvider } from '../reasoning';

export type ReportType = 'daily_brief' | 'weekly_review' | 'financial' | 'operational' | 'risk' | 'management' | 'custom';

export const REPORT_TYPES: { key: ReportType; label: string; description: string }[] = [
  { key: 'daily_brief', label: 'Daily Brief', description: 'Kort aktuell lägesbild' },
  { key: 'weekly_review', label: 'Weekly Management Review', description: 'Veckans viktigaste förändringar' },
  { key: 'financial', label: 'Financial Situation', description: 'Ekonomiskt läge och utveckling' },
  { key: 'operational', label: 'Operational Situation', description: 'Operativ utveckling' },
  { key: 'risk', label: 'Risk Report', description: 'Identifierade risker' },
  { key: 'management', label: 'Management Report', description: 'Professionell ledningsrapport' },
  { key: 'custom', label: 'Custom Analysis', description: 'Beskriv vilken analys som behövs' }
];

interface Section { heading: string; body?: string; list?: string[]; table?: { headers: string[]; rows: (string | number)[][] } }
export interface ReportContent { sections: Section[]; meta: Record<string, unknown> }

const fmtKr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';

function activeFindings(orgId: string): FindingRow[] {
  return all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END",
    orgId
  );
}

function findingsSection(findings: FindingRow[], heading = 'Viktigaste observationerna'): Section {
  return {
    heading,
    list: findings.filter(f => f.severity !== 'info').slice(0, 8)
      .map(f => `[${f.severity.toUpperCase()}] ${f.title} — ${f.description} (confidence ${(f.confidence * 100).toFixed(0)} %)`)
  };
}

function kpiSection(orgId: string): Section {
  const pack = computeMetrics(orgId);
  const lastIdx = pack.revenueByMonth.length - 2;
  const rows: (string | number)[][] = [];
  if (lastIdx >= 0) {
    rows.push(['Omsättning ' + pack.revenueByMonth[lastIdx].period, fmtKr(pack.revenueByMonth[lastIdx].value)]);
    rows.push(['Kostnader ' + pack.costsByMonth[lastIdx].period, fmtKr(pack.costsByMonth[lastIdx].value)]);
    rows.push(['Resultat ' + pack.resultByMonth[lastIdx].period, fmtKr(pack.resultByMonth[lastIdx].value)]);
  }
  rows.push(['Utestående kundfordringar', fmtKr(pack.receivables.openTotal)]);
  rows.push(['Varav förfallet', fmtKr(pack.receivables.overdueTotal)]);
  rows.push(['Leverantörsskulder', fmtKr(pack.payables.openTotal)]);
  return { heading: 'Nyckeltal', table: { headers: ['Mått', 'Värde'], rows } };
}

function memorySection(orgId: string): Section {
  const actions = all<{ title: string; status: string; effect_verified: string | null }>(
    "SELECT title, status, effect_verified FROM actions WHERE org_id = ? ORDER BY created_at DESC LIMIT 10", orgId);
  const decisions = all<{ title: string; decided_at: string; status: string }>(
    'SELECT title, decided_at, status FROM decisions WHERE org_id = ? ORDER BY decided_at DESC LIMIT 5', orgId);
  const list = [
    ...decisions.map(d => `Beslut ${d.decided_at.slice(0, 10)}: ${d.title} (${d.status})`),
    ...actions.map(a => `Åtgärd: ${a.title} — ${a.status}${a.effect_verified ? `, effekt: ${a.effect_verified === 'effective' ? 'observerad' : a.effect_verified === 'ineffective' ? 'uteblivit' : 'ej verifierad'}` : ''}`)
  ];
  return { heading: 'Beslut och åtgärder (Management Memory)', list: list.length ? list : ['Inga beslut eller åtgärder registrerade.'] };
}

function coverageSection(orgId: string): Section {
  const pack = computeMetrics(orgId);
  return {
    heading: 'Underlag och begränsningar',
    list: [
      `Datakällor: ${pack.dataCoverage.sources.map(s => `${s.name} (${s.connector})`).join(', ') || 'endast manuell data'}`,
      `Period: ${pack.dataCoverage.firstDate ?? '–'} till ${pack.dataCoverage.lastDate ?? '–'} (${pack.dataCoverage.monthsOfHistory} månaders historik)`,
      `Datapunkter: ${pack.dataCoverage.txCount} transaktioner, ${pack.dataCoverage.invoiceCount} fakturor`,
      'Systemet redovisar endast vad som kan beläggas i underlaget; osäkerheter anges per observation.'
    ]
  };
}

export async function generateReport(orgId: string, type: ReportType, userId: string | null, customPrompt?: string): Promise<{ id: string; content: ReportContent; title: string }> {
  const findings = activeFindings(orgId);
  const runInfo = latestRun(orgId);
  const sections: Section[] = [];
  const d = today();
  let title = '';

  const statusLine = runInfo?.summary ?? 'Ingen analys har körts ännu.';

  switch (type) {
    case 'daily_brief':
      title = `Daily Brief ${d}`;
      sections.push({ heading: 'Läget i korthet', body: statusLine });
      sections.push(findingsSection(findings));
      break;
    case 'weekly_review':
      title = `Weekly Management Review ${d}`;
      sections.push({ heading: 'Övergripande läge', body: statusLine });
      sections.push(findingsSection(findings, 'Veckans viktigaste observationer'));
      sections.push(kpiSection(orgId));
      sections.push(memorySection(orgId));
      break;
    case 'financial': {
      title = `Financial Situation ${d}`;
      sections.push(kpiSection(orgId));
      const liq = computeLiquidity(orgId);
      sections.push({
        heading: 'Likviditet',
        list: [
          liq.startBalance !== null ? `Kassaposition: ${fmtKr(liq.startBalance)} (${liq.startBalanceSource})` : 'Kassaposition ej angiven',
          liq.minBalance !== null ? `Lägsta prognostiserade saldo (13 v): ${fmtKr(liq.minBalance)} vecka ${liq.minWeek}` : 'Prognos ej tillgänglig',
          `Risknivå: ${liq.riskLevel}`,
          ...liq.assumptions
        ]
      });
      sections.push(findingsSection(findings.filter(f => ['revenue', 'costs', 'liquidity', 'receivables'].includes(f.category)), 'Ekonomiska observationer'));
      break;
    }
    case 'operational':
      title = `Operational Situation ${d}`;
      sections.push({ heading: 'Övergripande läge', body: statusLine });
      sections.push(findingsSection(findings.filter(f => !['liquidity', 'receivables'].includes(f.category)), 'Operativa observationer'));
      sections.push(memorySection(orgId));
      break;
    case 'risk':
      title = `Risk Report ${d}`;
      sections.push(findingsSection(findings.filter(f => ['critical', 'high', 'medium'].includes(f.severity)), 'Identifierade risker'));
      sections.push(coverageSection(orgId));
      break;
    case 'management':
      title = `Management Report ${d}`;
      sections.push({ heading: 'Ledningsbedömning', body: runInfo?.narrative ?? statusLine });
      sections.push(findingsSection(findings));
      sections.push(kpiSection(orgId));
      sections.push(memorySection(orgId));
      sections.push(coverageSection(orgId));
      break;
    case 'custom': {
      title = `Custom Analysis ${d}`;
      const provider = getProvider();
      if (provider.name !== 'deterministic' && customPrompt) {
        const { askBusiness } = await import('../reasoning');
        const res = await askBusiness(orgId, userId, customPrompt);
        sections.push({ heading: 'Analys', body: res.answer });
      } else {
        sections.push({ heading: 'Analys', body: customPrompt ? 'Ingen språkmodell är konfigurerad — nedan visas systemets strukturerade underlag för frågan.' : 'Ingen frågeställning angiven.' });
        sections.push(findingsSection(findings));
        sections.push(kpiSection(orgId));
      }
      break;
    }
  }
  sections.push(coverageSectionOnce(sections, orgId));

  const content: ReportContent = { sections: sections.filter(Boolean) as Section[], meta: { type, generated_at: now(), narrative_model: runInfo?.narrative_model ?? null } };
  const id = uuid();
  run('INSERT INTO reports (id, org_id, type, title, period_start, period_end, content_json, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    id, orgId, type, title, null, d, JSON.stringify(content), now(), userId);
  return { id, content, title };
}

function coverageSectionOnce(sections: Section[], orgId: string): Section {
  if (sections.some(s => s.heading === 'Underlag och begränsningar')) return null as unknown as Section;
  return coverageSection(orgId);
}

export function getReport(orgId: string, id: string): { id: string; type: string; title: string; content_json: string; created_at: string } | undefined {
  return get('SELECT id, type, title, content_json, created_at FROM reports WHERE id = ? AND org_id = ?', id, orgId);
}

export function listReports(orgId: string): unknown[] {
  return all('SELECT id, type, title, created_at, created_by FROM reports WHERE org_id = ? ORDER BY created_at DESC LIMIT 50', orgId);
}
