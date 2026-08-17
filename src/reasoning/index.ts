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
import { computeProductivity } from '../analysis/productivity';
import { investigationWithMessages, addInvestigationMessage, listOpportunities } from '../analysis/opportunities';

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
  | 'changes' | 'revenue_result' | 'costs' | 'customers' | 'goals'
  | 'affordability' | 'hiring' | 'owner_compensation' | 'pricing_scenario' | 'sales_target'
  | 'general';

export function classifyIntent(question: string): Intent {
  const q = question.toLowerCase();
  if (/ta ut (mer )?(lön|pengar)|utdelning|ägaruttag|eget uttag|lön till mig|dela ut/.test(q)) return 'owner_compensation';
  if (/anställa|rekrytera|nyanställ|fler (tekniker|mekaniker|montörer|personal)/.test(q)) return 'hiring';
  if (/har vi råd|råd att|råd med|kan (jag|vi) köpa|köpa .* på företaget|investera i (en|ett|ny|nytt)/.test(q)) return 'affordability';
  if (/höj(a|er)? pris|prishöjning|sänk(a|er)? pris|vad händer om .*(pris|%)/.test(q)) return 'pricing_scenario';
  if (/hur mycket måste vi sälja|kvar till (års)?målet|nå (årets |års)?mål/.test(q)) return 'sales_target';
  if (/fått betalt|obetal|betalat|betalning|matcha|förfall/.test(q)) return 'payments_reconciliation';
  if (/likviditet|kassa|betalningsförmåga|buffert/.test(q)) return 'liquidity';
  if (/risk/.test(q)) return 'risk';
  if (/beslut/.test(q)) return 'decisions';
  if (/åtgärd|effekt/.test(q)) return 'actions_effect';
  if (/förändra|hänt|sedan förra|förra veckan|förra månaden|vad händer/.test(q)) return 'changes';
  if (/mål|planen|ligger vi efter|budget|på rätt bana/.test(q)) return 'goals';
  if (/kostnad|lagt.*pengar|utgift|dyrast/.test(q)) return 'costs';
  if (/kund(er)?\b|lönsam|störst/.test(q)) return 'customers';
  if (/omsättning|resultat|försäljning|marginal|produktivitet|gick det/.test(q)) return 'revenue_result';
  return 'general';
}

export const INTENT_DOMAIN: Record<Intent, string> = {
  payments_reconciliation: 'ekonomi', liquidity: 'ekonomi', revenue_result: 'ekonomi', costs: 'ekonomi',
  risk: 'risk', decisions: 'mål', actions_effect: 'mål', goals: 'mål', changes: 'mål',
  customers: 'försäljning', sales_target: 'försäljning', pricing_scenario: 'försäljning',
  affordability: 'inköp', hiring: 'personal', owner_compensation: 'skatt_ägare', general: 'ekonomi'
};

/** Extract an amount like "180 000", "1,2 MSEK", "50 000 kr" from free text. */
export function extractAmount(q: string): number | null {
  const msek = q.match(/([0-9]+(?:[.,][0-9]+)?)\s*(msek|mkr|miljoner)/i);
  if (msek) return Math.round(Number(msek[1].replace(',', '.')) * 1_000_000);
  const tkr = q.match(/([0-9]+(?:[.,][0-9]+)?)\s*tkr/i);
  if (tkr) return Math.round(Number(tkr[1].replace(',', '.')) * 1_000);
  const plain = q.match(/([0-9][0-9\s]{2,12})(?:\s*(?:kr|sek|:-))?/i);
  if (plain) {
    const n = Number(plain[1].replace(/\s/g, ''));
    if (Number.isFinite(n) && n >= 1000) return n;
  }
  return null;
}

export function extractPercent(q: string): number | null {
  const m = q.match(/([0-9]+(?:[.,][0-9]+)?)\s*(%|procent)/i);
  return m ? Number(m[1].replace(',', '.')) / 100 : null;
}

interface EvidencePackage {
  intent: Intent;
  facts: Record<string, unknown>;
  deterministic_answer: string;
  sources: string[];
  period: string;
  datapoints: number;
  missing_data: string[];          // adaptive data acquisition: what's missing & how to provide it
  requires_human_review: boolean;  // tax/owner and similar decisions
  confidence: number;              // reasoning-contract confidence 0..1
}

export function confidenceTier(c: number): 'high' | 'moderate' | 'low' {
  return c >= 0.85 ? 'high' : c >= 0.6 ? 'moderate' : 'low';
}

const fmtKr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';

function buildEvidencePackage(orgId: string, userId: string | null, intent: Intent, question: string): EvidencePackage {
  const pack = computeMetrics(orgId);
  const findings = all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END LIMIT 30", orgId);
  const parts: string[] = [];
  const facts: Record<string, unknown> = {};
  const missing: string[] = [];
  let requiresHumanReview = false;
  // Reasoning contract: confidence starts from data coverage and is reduced
  // by every missing piece the answer would need.
  let confidence = pack.dataCoverage.monthsOfHistory >= 6 ? 0.85 : pack.dataCoverage.monthsOfHistory >= 3 ? 0.7 : 0.5;
  const profile = getProfile(orgId);
  const lastIdx = pack.revenueByMonth.length - 2;
  const lastRev = lastIdx >= 0 ? pack.revenueByMonth[lastIdx] : null;

  switch (intent) {
    case 'affordability': {
      const amount = extractAmount(question);
      const liq = computeLiquidity(orgId);
      facts.requested_amount = amount;
      if (amount === null) {
        parts.push('Jag kan bedöma detta, men ange beloppet (t.ex. "180 000 kr") så räknar jag på det.');
        missing.push('Belopp för inköpet/investeringen');
        confidence = 0.4;
        break;
      }
      if (liq.startBalance === null) {
        parts.push(`Jag kan bedöma om ni har råd med ${fmtKr(amount)}, men jag saknar aktuell banklikviditet.`);
        missing.push('Aktuell kassaposition — ange i verksamhetsprofilen eller koppla ekonomikällan/ladda upp ett kontoutdrag');
        confidence = 0.45;
        break;
      }
      const minAfter = (liq.minBalance ?? liq.startBalance) - amount;
      facts.liquidity = { start: liq.startBalance, min_before: liq.minBalance, min_week: liq.minWeek, min_after_purchase: minAfter, buffer_target: liq.bufferTarget };
      parts.push(`Inköp om ${fmtKr(amount)}: kassan är ${fmtKr(liq.startBalance)} och prognosens lägsta punkt kommande veckor är ${fmtKr(liq.minBalance ?? 0)} (vecka ${liq.minWeek}). Efter inköpet blir lägsta punkten cirka ${fmtKr(minAfter)}.`);
      if (minAfter < 0) {
        parts.push('BEDÖMNING: Med nuvarande prognos skulle inköpet leda till negativt kassasaldo. Jag avråder utan förändrad finansiering eller senareläggning.');
      } else if (liq.bufferTarget !== null && minAfter < liq.bufferTarget) {
        parts.push(`BEDÖMNING: Inköpet är möjligt men pressar likviditeten under er buffert (${fmtKr(liq.bufferTarget)}). Överväg delbetalning, leasing eller senareläggning — eller driv in förfallna fordringar först (${fmtKr(pack.receivables.overdueTotal)} förfallet).`);
      } else {
        parts.push('BEDÖMNING: Inköpet ryms inom likviditeten och bufferten. Jämför gärna totalkostnad över livslängden (inte bara inköpspris) mellan alternativ innan beslut.');
      }
      break;
    }
    case 'hiring': {
      const p = computeProductivity(orgId);
      if (!p.hasData || p.overall.recentRatio === null) {
        parts.push('Jag kan bedöma bemanningsbehovet, men jag saknar tidsdata (arbetade och debiterade timmar per person).');
        missing.push('Tidsposter — importera från verkstads-/fältsystemet eller via CSV (kolumner: datum, tekniker, arbetade timmar, debiterade timmar)');
        confidence = 0.4;
        break;
      }
      facts.productivity = p.overall;
      const utilization = Math.round(p.overall.recentRatio * 100);
      if (p.overall.baselineRatio !== null && p.overall.recentRatio < p.overall.baselineRatio * 0.95) {
        const headroom = Math.round((p.overall.baselineRatio / p.overall.recentRatio - 1) * 100);
        parts.push(`Jag skulle inte fatta det beslutet ännu. Kapaciteten utnyttjas till ${utilization} % (normalt ${Math.round(p.overall.baselineRatio * 100)} %) de senaste ${p.recentWeeks.length} veckorna.`);
        parts.push(`Om produktiviteten återgår till normalnivå kan nuvarande bemanning hantera ungefär ${headroom} % mer volym. BEDÖMNING: Utred först varför kapaciteten inte utnyttjas.`);
      } else {
        parts.push(`Kapacitetsutnyttjandet är ${utilization} % och ligger på eller över normalnivån. En rekrytering kan vara motiverad — kontrollera att orderingången bär den ökade lönekostnaden (${profile.monthly_payroll ? 'nuvarande lönekostnad ' + fmtKr(Number(profile.monthly_payroll)) + '/mån' : 'ange lönekostnad i profilen för fullständig kalkyl'}).`);
      }
      break;
    }
    case 'owner_compensation': {
      requiresHumanReview = true;
      const liq = computeLiquidity(orgId);
      const result12 = pack.resultByMonth.reduce((a, p2) => a + p2.value, 0);
      facts.result_last_12m = Math.round(result12);
      facts.liquidity = { start: liq.startBalance, min: liq.minBalance, buffer: liq.bufferTarget };
      if (liq.startBalance === null) missing.push('Aktuell kassaposition (verksamhetsprofilen eller kontoutdrag)');
      missing.push('Kommande skatter, moms och arbetsgivaravgifter — stäm av mot Skatteverkets konto innan beslut');
      const available = liq.startBalance !== null && liq.bufferTarget !== null
        ? Math.max(0, Math.round((liq.minBalance ?? liq.startBalance) - liq.bufferTarget)) : null;
      parts.push(`Resultatet senaste 12 månaderna är ${fmtKr(result12)}${liq.startBalance !== null ? ` och kassan ${fmtKr(liq.startBalance)}` : ''}.`);
      if (available !== null) parts.push(`Utrymme ovanför likviditetsbufferten vid prognosens lägsta punkt: cirka ${fmtKr(available)}.`);
      parts.push('Innan du tar ut ytterligare pengar bör tre saker kontrolleras: (1) kommande skatter och arbetsgivaravgifter, (2) den definierade likviditetsbufferten, (3) hur lön kontra utdelning påverkar din situation i år.');
      parts.push('Scenarier: A) Lön — påverkar arbetsgivaravgifter och din pensionsgrundande inkomst. B) Utdelning — styrs av regler som förändras (bl.a. gränsbelopp). C) Behåll kapital — stärker bufferten. D) Investera i verksamheten.');
      parts.push('BEDÖMNING: Detta är beslutsstöd, inte skatterådgivning. Skatteregler förändras — stäm av valet mellan lön och utdelning med er redovisningskonsult innan beslut.');
      confidence = Math.min(confidence, 0.65);
      break;
    }
    case 'pricing_scenario': {
      const pct = extractPercent(question) ?? 0.05;
      const rev12 = pack.revenueByMonth.reduce((a, p2) => a + p2.value, 0);
      const delta = Math.round(rev12 * pct);
      facts.scenario = { price_change: pct, revenue_last_12m: Math.round(rev12), effect_at_unchanged_volume: delta };
      parts.push(`Scenario: prishöjning ${(pct * 100).toFixed(0)} %. Med senaste 12 månadernas volym (${fmtKr(rev12)}) ger det cirka ${fmtKr(delta)} i ytterligare intäkt per år — om volymen är oförändrad.`);
      parts.push(`ANTAGANDE: Kalkylen antar oförändrad volym. Hur kunderna reagerar på priset (priselasticitet) finns inte i underlaget. Topp 3-kundernas andel är ${pack.customerConcentration.slice(0, 3).map(c => (c.share * 100).toFixed(0) + ' %').join(', ') || 'okänd'} — testa förändringen på nya offerter innan generell höjning.`);
      confidence = Math.min(confidence, 0.7);
      break;
    }
    case 'sales_target': {
      const year = String(new Date().getFullYear());
      const yearGoal = all<{ label: string; target_value: number }>(
        `SELECT label, target_value FROM goals WHERE org_id = ? AND status='active' AND period='yearly' AND (metric='revenue' OR key='revenue') AND period_start LIKE ?`, orgId, `${year}%`)[0];
      if (!yearGoal) {
        parts.push('Det finns inget aktivt omsättningsmål för i år. Skapa ett under Styrning eller importera verksamhetsplanen, så kan jag räkna på vad som krävs.');
        missing.push('Årsmål för omsättning (Styrning → Mål)');
        confidence = 0.4;
        break;
      }
      const ytd = pack.revenueByMonth.filter(p2 => p2.period.startsWith(year) && p2.period <= (lastRev?.period ?? '')).reduce((a, p2) => a + p2.value, 0);
      const monthsLeft = 12 - Number((lastRev?.period ?? `${year}-12`).slice(5, 7));
      const remaining = yearGoal.target_value - ytd;
      const perMonth = monthsLeft > 0 ? Math.round(remaining / monthsLeft) : remaining;
      facts.target = { goal: yearGoal.label, target: yearGoal.target_value, ytd: Math.round(ytd), remaining: Math.round(remaining), months_left: monthsLeft, required_per_month: perMonth };
      parts.push(`Mål: ${yearGoal.label} — ${fmtKr(yearGoal.target_value)}. Hittills i år: ${fmtKr(ytd)} (t.o.m. ${lastRev?.period}).`);
      parts.push(remaining <= 0
        ? 'Målet är redan nått.'
        : `Kvar: ${fmtKr(remaining)} på ${monthsLeft} månader — det kräver ${fmtKr(perMonth)}/månad, mot nuvarande nivå ${fmtKr(lastRev?.value ?? 0)}/månad.`);
      break;
    }
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

  if (missing.length) confidence = Math.min(confidence, 0.55);

  return {
    intent,
    facts,
    deterministic_answer: parts.join('\n'),
    sources: pack.dataCoverage.sources.map(s => `${s.name} (${s.connector})`),
    period: `${pack.dataCoverage.firstDate ?? '–'} till ${pack.dataCoverage.lastDate ?? '–'}`,
    datapoints: pack.dataCoverage.txCount + pack.dataCoverage.invoiceCount,
    missing_data: missing,
    requires_human_review: requiresHumanReview,
    confidence
  };
}

export interface AskResult {
  answer: string; model: string; intent: Intent; domain: string;
  confidence: number; confidence_tier: 'high' | 'moderate' | 'low';
  missing_data: string[]; requires_human_review: boolean; evidence: unknown;
}

export async function askBusiness(orgId: string, userId: string | null, question: string): Promise<AskResult> {
  const intent = classifyIntent(question);
  const pkg = buildEvidencePackage(orgId, userId, intent, question);
  const provider = getProvider();
  const tier = confidenceTier(pkg.confidence);

  let answer: string;
  if (provider.name === 'deterministic') {
    answer = pkg.deterministic_answer;
    if (tier === 'low') answer += '\n\nUNDERLAGET ÄR INTE TILLRÄCKLIGT — jag skulle inte fatta beslut på detta ännu.';
    answer += '\n\n(Svaret är deterministiskt sammanställt från systemets beräknade underlag. Konfigurera en språkmodell för friare analys.)';
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
      pkg.missing_data.length ? `Saknat underlag som måste redovisas för användaren: ${pkg.missing_data.join('; ')}` : '',
      pkg.requires_human_review ? 'OBS: Detta är ett känsligt beslutsområde (skatt/ägare eller liknande). Svaret ska vara beslutsstöd, aldrig definitiv rådgivning, och hänvisa till professionell kontroll.' : '',
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
  return {
    answer, model: provider.model, intent,
    domain: INTENT_DOMAIN[intent],
    confidence: pkg.confidence, confidence_tier: tier,
    missing_data: pkg.missing_data, requires_human_review: pkg.requires_human_review,
    evidence
  };
}

// ---------------------------------------------------------------------------
// Investigations — locked-context dialog. The thread is bound to one
// specific question with its own evidence; the user never has to re-explain.
// ---------------------------------------------------------------------------

export async function askInvestigation(orgId: string, investigationId: string, userId: string | null, question: string): Promise<{ answer: string; model: string }> {
  const { investigation, messages } = investigationWithMessages(orgId, investigationId);
  if (!investigation) throw new Error('Undersökningen finns inte');
  addInvestigationMessage(orgId, investigationId, 'user', question);

  const intent = classifyIntent(question);
  const pkg = buildEvidencePackage(orgId, userId, intent, question);
  const provider = getProvider();
  let answer: string;

  if (provider.name === 'deterministic') {
    const parts = [pkg.deterministic_answer];
    if (pkg.missing_data.length) parts.push('Saknat underlag: ' + pkg.missing_data.join('; '));
    parts.push(`(Svar inom undersökningen "${investigation.title}" — kontexten är låst till denna fråga. Deterministiskt sammanställt.)`);
    answer = parts.join('\n\n');
  } else {
    const user = [
      `LÅST UNDERSÖKNINGSKONTEXT — all dialog gäller denna specifika fråga:`,
      `Undersökning: ${investigation.title}`,
      investigation.question ? `Ursprunglig fråga: ${investigation.question}` : '',
      investigation.context_json ? `Underlag vid start: ${investigation.context_json}` : '',
      messages.length ? `Tidigare dialog:\n${messages.slice(-8).map(m => `${m.role === 'user' ? 'Ägaren' : 'Systemet'}: ${m.content.slice(0, 400)}`).join('\n')}` : '',
      `Aktuellt deterministiskt evidenspaket (intent ${intent}): ${JSON.stringify(pkg.facts)}`,
      `Ägarens nya inlägg: "${question}"`,
      'Resonera vidare INOM undersökningens fråga. Om ägaren tillför ny kontext (t.ex. en förklaring), justera bedömningen och säg vad som förändras. Avsluta med vad som återstår att klarlägga.'
    ].filter(Boolean).join('\n\n');
    answer = await provider.complete(systemPrompt(orgId), user);
  }

  addInvestigationMessage(orgId, investigationId, 'system', answer, provider.model);
  return { answer, model: provider.model };
}

// ---------------------------------------------------------------------------
// Morning brief — the chat's landing surface, scoped to the user.
// ---------------------------------------------------------------------------

export function morningBrief(orgId: string, userId: string): {
  greeting: string; intro: string; status: string | null;
  items: { severity: string; title: string; id: string; domain: string }[];
  opportunities: { id: string; title: string; domain: string; kind: string }[];
  assessment: string | null; mode: string;
} {
  const user = get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
  const runInfo = get<{ overall_status: string | null; summary: string | null; narrative: string | null }>(
    "SELECT overall_status, summary, narrative FROM analysis_runs WHERE org_id = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1", orgId);
  const mode = getSetting(orgId, 'reports.mode', userId);
  const findings = all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') AND severity != 'info' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 4", orgId);
  const hour = new Date().getHours();
  const greeting = `${hour < 10 ? 'God morgon' : hour < 18 ? 'God dag' : 'God kväll'}${user ? ' ' + user.name.split(' ')[0] : ''}.`;
  const { domainFor } = require('../analysis/engine') as { domainFor(c: string): string };
  const opportunities = listOpportunities(orgId).filter(o => o.status === 'proposed').slice(0, 3);
  // Honesty: when there's nothing, say exactly that — never invent an insight.
  const intro = findings.length || opportunities.length
    ? `Jag har gått igenom verksamheten sedan din senaste uppdatering. ${findings.length ? `${findings.length} ${findings.length === 1 ? 'sak förtjänar' : 'saker förtjänar'} din uppmärksamhet.` : ''}${opportunities.length ? ` Jag har också ${opportunities.length === 1 ? 'en möjlighet' : opportunities.length + ' möjligheter'} som kan vara ${opportunities.length === 1 ? 'värd' : 'värda'} att undersöka.` : ''}`
    : 'Jag har gått igenom verksamheten. Inga nya väsentliga avvikelser identifierades — läget ligger inom sina normala intervall.';
  return {
    greeting,
    intro,
    status: runInfo?.summary ?? null,
    items: findings.map(f => ({ severity: f.severity, title: f.title, id: f.id, domain: domainFor(f.category) })),
    opportunities: opportunities.map(o => ({ id: o.id, title: o.title, domain: o.domain, kind: o.kind })),
    assessment: runInfo?.narrative ?? null,
    mode
  };
}
