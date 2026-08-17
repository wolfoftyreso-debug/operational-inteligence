// Reasoning layer — model-agnostic. Providers are pluggable; the core never
// references a specific model name.
//
// Chat pipeline (the trust-critical part):
//   Question → intent/entity resolution → data retrieval →
//   deterministic calculations → evidence package → provider → answer.
// The model interprets and formulates; it never computes business numbers.

import { config } from '../config';
import { all, get, run, uuid, now } from '../db';
import type { FindingRow, MetricPack, OverallStatus } from '../domain/types';
import { computeMetrics, getProfile } from '../analysis/metrics';
import { computeLiquidity } from '../analysis/liquidity';
import { constitution, getSetting } from '../core/settings';
import { managementContext, goalTargetForMonth } from '../core/hierarchy';

export interface ReasoningProvider {
  name: string;
  model: string;
  available(): boolean;
  complete(system: string, user: string): Promise<string>;
}

class AnthropicProvider implements ReasoningProvider {
  name = 'anthropic';
  model = config.reasoning.model;
  available(): boolean {
    return Boolean(config.reasoning.anthropicApiKey);
  }
  async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${config.reasoning.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.reasoning.anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: config.reasoning.maxTokens,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    if (!res.ok) throw new Error(`Reasoning provider error: ${res.status} ${await res.text()}`);
    const j = await res.json() as { content: { type: string; text?: string }[] };
    return j.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  }
}

class DeterministicProvider implements ReasoningProvider {
  name = 'deterministic';
  model = 'deterministic-composer';
  available(): boolean { return true; }
  async complete(): Promise<string> { return ''; }
}

export function getProvider(): ReasoningProvider {
  if (config.reasoning.provider === 'anthropic') {
    const p = new AnthropicProvider();
    if (p.available()) return p;
  }
  return new DeterministicProvider();
}

// ---------------------------------------------------------------------------
// System prompt: built from the organization's System Constitution + tone.
// ---------------------------------------------------------------------------

function systemPrompt(orgId: string): string {
  const c = constitution(orgId);
  const tone = getSetting(orgId, 'tone.style');
  const toneCustom = getSetting(orgId, 'tone.custom');
  const proactivity = getSetting(orgId, 'guidance.proactivity');
  return `Du är analyskärnan i Operational Intelligence — ett lednings- och vägledningssystem.
Regler:
- Du får ett strukturerat dataunderlag där alla siffror redan är deterministiskt beräknade av systemet. Räkna aldrig om och hitta aldrig på siffror.
- Skilj på fakta, härledningar, bedömningar, prognoser och rekommendationer.
- Säg tydligt när underlaget är osäkert eller otillräckligt.
- Skriv på svenska.

Organisationens styrfilosofi (System Constitution):
- Primärt mål: ${c.primary_objective}
- Riskaptit: ${c.risk_tolerance}
- Ledningsstil: ${c.management_style}
- Alertfilosofi: ${c.alert_philosophy}
- Rapportfilosofi: ${c.reporting_philosophy}

Ton: ${tone}${toneCustom ? ` — ${toneCustom}` : ''}.
Proaktivitet: ${proactivity === 'observe' ? 'beskriv läget utan att föreslå åtgärder' : proactivity === 'drive' ? 'rekommendera åtgärder och var tydlig med uppföljning' : 'rekommendera åtgärder vid väsentliga avvikelser'}.`;
}

function contextPack(orgId: string, pack: MetricPack, findings: FindingRow[]): string {
  const profile = getProfile(orgId);
  const liq = computeLiquidity(orgId);
  const actions = all<{ title: string; status: string; effect_verified: string | null; expected_effect: string | null }>(
    'SELECT title, status, effect_verified, expected_effect FROM actions WHERE org_id = ? ORDER BY created_at DESC LIMIT 15', orgId);
  const decisions = all<{ title: string; decided_at: string; status: string; expected_result: string | null }>(
    'SELECT title, decided_at, status, expected_result FROM decisions WHERE org_id = ? ORDER BY decided_at DESC LIMIT 10', orgId);
  const observations = all<{ date: string; text: string }>(
    'SELECT date, text FROM observations WHERE org_id = ? ORDER BY date DESC LIMIT 10', orgId);
  const goals = all<{ label: string; target_value: number; period: string; period_start: string | null; status: string }>(
    "SELECT label, target_value, period, period_start, status FROM goals WHERE org_id = ? AND status='active' AND period != 'monthly' LIMIT 15", orgId);
  const risks = all<{ title: string; severity: string; status: string }>(
    "SELECT title, severity, status FROM risks WHERE org_id = ? AND status='active' LIMIT 10", orgId);

  return JSON.stringify({
    verksamhetsprofil: profile,
    aktiva_mal: goals,
    aktiva_risker: risks,
    nyckeltal: {
      omsattning_per_manad: pack.revenueByMonth,
      kostnader_per_manad: pack.costsByMonth,
      resultat_per_manad: pack.resultByMonth,
      omsattning_per_enhet: pack.revenueByUnit,
      kundfordringar: pack.receivables,
      leverantorsskulder: pack.payables,
      kundkoncentration: pack.customerConcentration,
      datatackning: pack.dataCoverage
    },
    likviditetsprognos: { risk: liq.riskLevel, minsaldo: liq.minBalance, minvecka: liq.minWeek, antaganden: liq.assumptions },
    aktiva_findings: findings.map(f => ({
      severity: f.severity, kategori: f.category, epistemisk_status: f.epistemic,
      titel: f.title, beskrivning: f.description, confidence: f.confidence, status: f.status
    })),
    atgarder: actions,
    beslut: decisions,
    manuella_observationer: observations
  }, null, 1);
}

export async function generateNarrative(
  orgId: string,
  input: { overallStatus: OverallStatus; findings: FindingRow[]; pack: MetricPack }
): Promise<{ text: string; model: string } | null> {
  const provider = getProvider();
  if (provider.name === 'deterministic') {
    return { text: composeDeterministic(orgId, input.overallStatus, input.findings), model: provider.model };
  }
  const user = `Här är aktuellt dataunderlag för verksamheten:\n${contextPack(orgId, input.pack, input.findings)}\n\nSkriv en kort ledningsbedömning (max 200 ord): övergripande läge, de 2–4 viktigaste observationerna och vad ledningen bör göra närmast. Utgå enbart från underlaget.`;
  const text = await provider.complete(systemPrompt(orgId), user);
  return text ? { text, model: provider.model } : null;
}

function composeDeterministic(orgId: string, status: OverallStatus, findings: FindingRow[]): string {
  const statusText: Record<OverallStatus, string> = {
    stable: 'Verksamheten uppvisar ett stabilt läge utifrån tillgänglig data.',
    attention: 'Läget är under kontroll men innehåller avvikelser som bör bevakas.',
    action_needed: 'Det finns avvikelser som kräver aktiva åtgärder från ledningen.',
    critical: 'Läget innehåller kritiska risker som kräver omedelbar hantering.'
  };
  const proactivity = getSetting(orgId, 'guidance.proactivity');
  const important = findings.filter(f => f.severity !== 'info').slice(0, 4);
  const lines = [statusText[status]];
  if (important.length) {
    lines.push('');
    lines.push('Viktigaste observationerna:');
    important.forEach((f, i) => lines.push(`${i + 1}. ${f.title}`));
    if (proactivity !== 'observe') {
      const recs = important.flatMap(f => {
        try { return JSON.parse(f.recommended_actions_json ?? '[]') as string[]; } catch { return []; }
      }).slice(0, 3);
      if (recs.length) {
        lines.push('');
        lines.push('Rekommenderade nästa steg: ' + recs.join('; ') + '.');
      }
    }
  }
  lines.push('');
  lines.push('(Sammanställd deterministiskt — ingen språkmodell är konfigurerad. Alla underliggande siffror och findings är oförändrade.)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Ask the Business — intent-routed pipeline with evidence packages.
// ---------------------------------------------------------------------------

export type Intent =
  | 'payments_reconciliation' | 'liquidity' | 'risk' | 'decisions' | 'actions_effect'
  | 'changes' | 'revenue_result' | 'costs' | 'customers' | 'goals' | 'general';

export function classifyIntent(question: string): Intent {
  const q = question.toLowerCase();
  if (/fått betalt|obetal|betalat|betalning|matcha|förfall/.test(q)) return 'payments_reconciliation';
  if (/likviditet|kassa|betalningsförmåga|buffert/.test(q)) return 'liquidity';
  if (/risk/.test(q)) return 'risk';
  if (/beslut/.test(q)) return 'decisions';
  if (/åtgärd|effekt/.test(q)) return 'actions_effect';
  if (/förändra|hänt|sedan förra|förra veckan|förra månaden|vad händer/.test(q)) return 'changes';
  if (/mål|planen|ligger vi efter|budget|på rätt bana/.test(q)) return 'goals';
  if (/kostnad|lagt.*pengar|utgift|dyrast/.test(q)) return 'costs';
  if (/kund(er)?\b|lönsam|störst/.test(q)) return 'customers';
  if (/omsättning|resultat|försäljning|marginal|gick det/.test(q)) return 'revenue_result';
  return 'general';
}

interface EvidencePackage {
  intent: Intent;
  facts: Record<string, unknown>;
  deterministic_answer: string;
  sources: string[];
  period: string;
  datapoints: number;
}

const fmtKr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';

function buildEvidencePackage(orgId: string, userId: string | null, intent: Intent, question: string): EvidencePackage {
  const pack = computeMetrics(orgId);
  const findings = all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END LIMIT 30", orgId);
  const parts: string[] = [];
  const facts: Record<string, unknown> = {};
  const lastIdx = pack.revenueByMonth.length - 2;
  const lastRev = lastIdx >= 0 ? pack.revenueByMonth[lastIdx] : null;

  switch (intent) {
    case 'payments_reconciliation': {
      const supplierFocus = /köpte|inköp|leverantör/.test(question.toLowerCase());
      const kind = supplierFocus ? 'supplier' : 'customer';
      const rows = all<{ counterparty_name: string | null; amount: number; balance: number; status: string; due_date: string | null; paid_date: string | null }>(
        `SELECT counterparty_name, amount, balance, status, due_date, paid_date FROM invoices WHERE org_id = ? AND kind = ?`, orgId, kind);
      const total = rows.length;
      const paid = rows.filter(r => r.status === 'paid');
      const open = rows.filter(r => r.status === 'open' || r.status === 'overdue');
      const overdue = open.filter(r => r.due_date && r.due_date < new Date().toISOString().slice(0, 10));
      const outstanding = open.reduce((a, r) => a + r.balance, 0);
      facts.invoice_kind = kind;
      facts.total_invoices = total; facts.fully_paid = paid.length;
      facts.open = open.length; facts.overdue = overdue.length;
      facts.outstanding_amount = outstanding;
      facts.overdue_items = overdue.slice(0, 8).map(r => ({ motpart: r.counterparty_name, belopp: r.balance, förfall: r.due_date }));
      parts.push(kind === 'supplier'
        ? `Av ${total} leverantörsfakturor är ${paid.length} fullt betalda och ${open.length} öppna (${overdue.length} förfallna). Utestående: ${fmtKr(outstanding)}.`
        : `Av ${total} kundfakturor är ${paid.length} fullt betalda och ${open.length} öppna (${overdue.length} förfallna). Utestående: ${fmtKr(outstanding)}.`);
      if (overdue.length) {
        parts.push('Förfallna poster: ' + overdue.slice(0, 5).map(r => `${r.counterparty_name ?? 'Okänd'} — ${fmtKr(r.balance)} (förföll ${r.due_date})`).join('; ') + '.');
        parts.push(`Bedömning: ${overdue.length <= 2 ? 'Inget som tyder på ett större betalningsproblem, men de förfallna posterna bör kontrolleras.' : 'Antalet förfallna poster motiverar en aktiv genomgång.'}`);
      } else parts.push('Inga förfallna poster.');
      break;
    }
    case 'liquidity': {
      const liq = computeLiquidity(orgId);
      facts.risk_level = liq.riskLevel; facts.min_balance = liq.minBalance; facts.min_week = liq.minWeek;
      facts.top_overdue_debtors = pack.receivables.topDebtors.filter(d => d.overdue > 0).slice(0, 3);
      if (liq.riskLevel === 'unknown') parts.push('Likviditetsläget kan inte bedömas fullt ut eftersom kassaposition saknas i verksamhetsprofilen.');
      else parts.push(`Likviditetsrisken bedöms som ${liq.riskLevel === 'low' ? 'låg' : liq.riskLevel === 'medium' ? 'måttlig' : liq.riskLevel === 'high' ? 'hög' : 'kritisk'}. Lägsta prognostiserade saldo de kommande veckorna är ${fmtKr(liq.minBalance ?? 0)} (vecka ${liq.minWeek}).`);
      const topOverdue = pack.receivables.topDebtors.filter(d => d.overdue > 0).slice(0, 3);
      if (topOverdue.length) parts.push(`Störst påverkan från kundsidan: ${topOverdue.map(d => `${d.name} (${fmtKr(d.overdue)} förfallet)`).join(', ')}.`);
      break;
    }
    case 'risk': {
      const risks = all<{ title: string; severity: string }>("SELECT title, severity FROM risks WHERE org_id = ? AND status='active' ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 5", orgId);
      const top = findings.filter(f => ['critical', 'high', 'medium'].includes(f.severity))[0];
      facts.registered_risks = risks; facts.top_finding = top?.title ?? null;
      parts.push(top ? `Den största identifierade risken just nu: ${top.title}. ${top.description}` : 'Inga väsentliga risker identifierade i nuvarande data.');
      if (risks.length) parts.push('Registrerade risker ur styrande dokument: ' + risks.map(r => `${r.title} (${r.severity})`).join('; ') + '.');
      break;
    }
    case 'decisions': {
      const ds = all<{ title: string; decided_at: string; expected_result: string | null; actual_result: string | null; status: string }>(
        'SELECT title, decided_at, expected_result, actual_result, status FROM decisions WHERE org_id = ? ORDER BY decided_at DESC LIMIT 6', orgId);
      facts.decisions = ds;
      parts.push(ds.length ? 'Senaste beslut: ' + ds.map(d => `${d.decided_at.slice(0, 10)}: ${d.title}${d.actual_result ? ` (utfall: ${d.actual_result})` : ''}`).join('; ') + '.' : 'Inga beslut finns registrerade.');
      break;
    }
    case 'actions_effect': {
      const as = all<{ title: string; status: string; effect_verified: string | null }>(
        'SELECT title, status, effect_verified FROM actions WHERE org_id = ? ORDER BY created_at DESC LIMIT 10', orgId);
      facts.actions = as;
      if (!as.length) parts.push('Inga åtgärder finns registrerade.');
      else {
        const eff = as.filter(a => a.effect_verified === 'effective');
        const ineff = as.filter(a => a.effect_verified === 'ineffective');
        parts.push(`Registrerade åtgärder: ${as.length}.` +
          (eff.length ? ` Med observerad effekt: ${eff.map(a => a.title).join(', ')}.` : '') +
          (ineff.length ? ` Utan observerad effekt hittills: ${ineff.map(a => a.title).join(', ')}.` : ''));
      }
      break;
    }
    case 'changes': {
      const recent = findings.slice(0, 5);
      facts.recent_findings = recent.map(f => f.title);
      parts.push(recent.length ? 'Senaste väsentliga observationer: ' + recent.map(f => f.title).join('; ') + '.' : 'Inga nya väsentliga förändringar har identifierats.');
      break;
    }
    case 'goals': {
      const goals = all<{ label: string; target_value: number; period: string; period_start: string | null; metric: string | null }>(
        "SELECT label, target_value, period, period_start, metric FROM goals WHERE org_id = ? AND status='active' AND period != 'monthly' LIMIT 8", orgId);
      facts.active_goals = goals;
      if (lastRev) {
        const monthGoal = goalTargetForMonth(orgId, 'revenue', lastRev.period);
        if (monthGoal) {
          const dev = (lastRev.value - monthGoal.target) / monthGoal.target;
          facts.revenue_vs_goal = { month: lastRev.period, actual: lastRev.value, target: monthGoal.target, deviation: dev };
          parts.push(`Omsättningen ${lastRev.period} var ${fmtKr(lastRev.value)} mot målets ${fmtKr(monthGoal.target)} (${(dev * 100).toFixed(1).replace('.', ',')} %). Målet härrör från: ${monthGoal.goal.label}.`);
        }
      }
      if (goals.length) parts.push('Aktiva mål: ' + goals.map(g => `${g.label} (${fmtKr(g.target_value)}, ${g.period})`).join('; ') + '.');
      else parts.push('Inga aktiva mål är registrerade. Lägg till mål i Styrning eller importera ett styrande dokument.');
      break;
    }
    case 'costs': {
      const lastMonthIdx = pack.months.length - 2;
      const catTotals = pack.costByCategory.map(c => ({
        category: c.category,
        last: c.months[lastMonthIdx]?.value ?? 0,
        total3: c.months.slice(-4, -1).reduce((a, p) => a + p.value, 0)
      })).sort((a, b) => b.total3 - a.total3);
      facts.top_cost_categories = catTotals.slice(0, 5);
      parts.push('Största kostnadskategorier (senaste 3 mån): ' + catTotals.slice(0, 5).map(c => `${c.category} (${fmtKr(c.total3)})`).join(', ') + '.');
      const costFindings = findings.filter(f => f.category === 'costs');
      costFindings.forEach(f => parts.push(f.description));
      break;
    }
    case 'customers': {
      facts.customer_concentration = pack.customerConcentration;
      facts.top_debtors = pack.receivables.topDebtors;
      const top = pack.customerConcentration.slice(0, 3);
      parts.push(top.length ? 'Största kunder senaste 3 månaderna: ' + top.map(c => `${c.name} (${fmtKr(c.revenue)}, ${(c.share * 100).toFixed(0)} % av faktureringen)`).join('; ') + '.' : 'Ingen kundfaktureringsdata tillgänglig.');
      break;
    }
    case 'revenue_result': {
      if (lastRev) {
        facts.revenue = { month: lastRev.period, value: lastRev.value };
        facts.result = pack.resultByMonth[lastIdx];
        parts.push(`Omsättningen senaste kompletta månad (${lastRev.period}) var ${fmtKr(lastRev.value)}. Resultatet var ${fmtKr(pack.resultByMonth[lastIdx].value)}.`);
        findings.filter(f => f.category === 'revenue').forEach(f => parts.push(f.description));
      } else parts.push('Det finns ännu inte tillräcklig intäktsdata för att besvara frågan.');
      break;
    }
    default: {
      const top = findings.filter(f => f.severity !== 'info').slice(0, 3);
      facts.top_findings = top.map(f => f.title);
      parts.push(top.length
        ? 'Utifrån aktuellt läge är detta viktigast: ' + top.map(f => f.title).join('; ') + '.'
        : 'Verksamheten uppvisar ett stabilt läge; inga väsentliga avvikelser identifierade.');
    }
  }

  return {
    intent,
    facts,
    deterministic_answer: parts.join('\n'),
    sources: pack.dataCoverage.sources.map(s => `${s.name} (${s.connector})`),
    period: `${pack.dataCoverage.firstDate ?? '–'} till ${pack.dataCoverage.lastDate ?? '–'}`,
    datapoints: pack.dataCoverage.txCount + pack.dataCoverage.invoiceCount
  };
}

export async function askBusiness(orgId: string, userId: string | null, question: string): Promise<{ answer: string; model: string; intent: Intent; evidence: unknown }> {
  const intent = classifyIntent(question);
  const pkg = buildEvidencePackage(orgId, userId, intent, question);
  const provider = getProvider();

  let answer: string;
  if (provider.name === 'deterministic') {
    answer = pkg.deterministic_answer + '\n\n(Svaret är deterministiskt sammanställt från systemets beräknade underlag. Konfigurera en språkmodell för friare analys.)';
  } else {
    // Conversation context: the user's recent exchanges (business context, not chat fluff).
    const history = userId ? all<{ question: string; answer: string }>(
      'SELECT question, answer FROM questions WHERE org_id = ? AND user_id = ? ORDER BY asked_at DESC LIMIT 4', orgId, userId) : [];
    const mc = userId ? managementContext(orgId, userId) : null;
    const user = [
      mc ? `Användarens management-kontext:\n${JSON.stringify(mc)}` : '',
      history.length ? `Tidigare frågor i samtalet (senaste först):\n${history.map(h => `Q: ${h.question}\nA: ${h.answer.slice(0, 300)}`).join('\n')}` : '',
      `Deterministiskt beräknat evidenspaket för frågan (intent: ${intent}):\n${JSON.stringify(pkg.facts, null, 1)}`,
      `Systemets deterministiska sammanfattning: ${pkg.deterministic_answer}`,
      `Ledningens fråga: "${question}"`,
      'Svara med: (1) direkt svar byggt på evidenspaketet, (2) kort bedömning, (3) vad som är osäkert. Referera siffror exakt som i paketet.'
    ].filter(Boolean).join('\n\n');
    answer = await provider.complete(systemPrompt(orgId), user);
  }

  const evidence = {
    intent,
    sources: pkg.sources,
    period: pkg.period,
    datapoints: pkg.datapoints,
    facts: pkg.facts
  };
  run('INSERT INTO questions (id, org_id, user_id, question, answer, evidence_json, model, asked_at) VALUES (?,?,?,?,?,?,?,?)',
    uuid(), orgId, userId, question, answer, JSON.stringify(evidence), provider.model, now());
  return { answer, model: provider.model, intent, evidence };
}

// ---------------------------------------------------------------------------
// Morning brief — the chat's landing surface, scoped to the user.
// ---------------------------------------------------------------------------

export function morningBrief(orgId: string, userId: string): {
  greeting: string; status: string | null; items: { severity: string; title: string; id: string }[];
  assessment: string | null; mode: string;
} {
  const user = get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
  const runInfo = get<{ overall_status: string | null; summary: string | null; narrative: string | null }>(
    "SELECT overall_status, summary, narrative FROM analysis_runs WHERE org_id = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1", orgId);
  const mode = getSetting(orgId, 'reports.mode', userId);
  const findings = all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') AND severity != 'info' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 3", orgId);
  const hour = new Date().getHours();
  const greeting = `${hour < 10 ? 'God morgon' : hour < 18 ? 'God dag' : 'God kväll'}${user ? ' ' + user.name.split(' ')[0] : ''}.`;
  return {
    greeting,
    status: runInfo?.summary ?? null,
    items: findings.map(f => ({ severity: f.severity, title: f.title, id: f.id })),
    assessment: runInfo?.narrative ?? null,
    mode
  };
}
