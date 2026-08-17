// Reasoning layer — model-agnostic. Providers are pluggable; the core never
// references a specific model name. Deterministic calculations happen in the
// analysis layer; the model interprets and reasons about computed results.

import { config } from '../config';
import { all, get, run, uuid, now } from '../db';
import type { FindingRow, MetricPack, OverallStatus } from '../domain/types';
import { computeMetrics, getProfile } from '../analysis/metrics';
import { computeLiquidity } from '../analysis/liquidity';

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

/** Deterministic fallback — assembles a clear Swedish narrative without an LLM. */
class DeterministicProvider implements ReasoningProvider {
  name = 'deterministic';
  model = 'deterministic-composer';
  available(): boolean { return true; }
  async complete(_system: string, _user: string): Promise<string> {
    return ''; // narrative composition is handled by composeDeterministic()
  }
}

export function getProvider(): ReasoningProvider {
  if (config.reasoning.provider === 'anthropic') {
    const p = new AnthropicProvider();
    if (p.available()) return p;
  }
  return new DeterministicProvider();
}

// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Du är analyskärnan i Operational Intelligence — ett lednings- och vägledningssystem för små och medelstora företag.
Regler:
- Du får ett strukturerat dataunderlag (beräknade nyckeltal och findings). Alla siffror är redan deterministiskt beräknade av systemet.
- Räkna aldrig om siffror och hitta aldrig på siffror. Referera dem exakt som de anges.
- Skriv professionell, lugn, tydlig svenska. Ingen överdriven dramatik.
- Skilj på fakta, härledningar, bedömningar, prognoser och rekommendationer.
- Säg tydligt när underlaget är osäkert eller otillräckligt.
- Var konkret om vad ledningen bör göra och varför.`;

function contextPack(orgId: string, pack: MetricPack, findings: FindingRow[]): string {
  const profile = getProfile(orgId);
  const liq = computeLiquidity(orgId);
  const actions = all<{ title: string; status: string; effect_verified: string | null; expected_effect: string | null }>(
    'SELECT title, status, effect_verified, expected_effect FROM actions WHERE org_id = ? ORDER BY created_at DESC LIMIT 15', orgId);
  const decisions = all<{ title: string; decided_at: string; status: string; expected_result: string | null }>(
    'SELECT title, decided_at, status, expected_result FROM decisions WHERE org_id = ? ORDER BY decided_at DESC LIMIT 10', orgId);
  const observations = all<{ date: string; text: string }>(
    'SELECT date, text FROM observations WHERE org_id = ? ORDER BY date DESC LIMIT 10', orgId);

  return JSON.stringify({
    verksamhetsprofil: profile,
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
    return { text: composeDeterministic(input.overallStatus, input.findings), model: provider.model };
  }
  const user = `Här är aktuellt dataunderlag för verksamheten:\n${contextPack(orgId, input.pack, input.findings)}\n\nSkriv en kort ledningsbedömning (max 200 ord): övergripande läge, de 2–4 viktigaste observationerna och vad ledningen bör göra närmast. Utgå enbart från underlaget.`;
  const text = await provider.complete(SYSTEM_PROMPT, user);
  return text ? { text, model: provider.model } : null;
}

function composeDeterministic(status: OverallStatus, findings: FindingRow[]): string {
  const statusText: Record<OverallStatus, string> = {
    stable: 'Verksamheten uppvisar ett stabilt läge utifrån tillgänglig data.',
    attention: 'Läget är under kontroll men innehåller avvikelser som bör bevakas.',
    action_needed: 'Det finns avvikelser som kräver aktiva åtgärder från ledningen.',
    critical: 'Läget innehåller kritiska risker som kräver omedelbar hantering.'
  };
  const important = findings.filter(f => f.severity !== 'info').slice(0, 4);
  const lines = [statusText[status]];
  if (important.length) {
    lines.push('');
    lines.push('Viktigaste observationerna:');
    important.forEach((f, i) => lines.push(`${i + 1}. ${f.title}`));
    const recs = important.flatMap(f => {
      try { return JSON.parse(f.recommended_actions_json ?? '[]') as string[]; } catch { return []; }
    }).slice(0, 3);
    if (recs.length) {
      lines.push('');
      lines.push('Rekommenderade nästa steg: ' + recs.join('; ') + '.');
    }
  }
  lines.push('');
  lines.push('(Sammanställd deterministiskt — ingen språkmodell är konfigurerad. Alla underliggande siffror och findings är oförändrade.)');
  return lines.join('\n');
}

// --- Ask the Business ---

export async function askBusiness(orgId: string, userId: string | null, question: string): Promise<{ answer: string; model: string; evidence: unknown }> {
  const pack = computeMetrics(orgId);
  const findings = all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY detected_at DESC LIMIT 30", orgId);
  const provider = getProvider();

  let answer: string;
  if (provider.name === 'deterministic') {
    answer = deterministicAnswer(orgId, question, pack, findings);
  } else {
    const user = `Dataunderlag:\n${contextPack(orgId, pack, findings)}\n\nLedningens fråga: "${question}"\n\nSvara på svenska med: (1) direkt svar, (2) vilket underlag svaret bygger på, (3) vad som är osäkert. Om underlaget inte räcker för att svara — säg det tydligt.`;
    answer = await provider.complete(SYSTEM_PROMPT, user);
  }

  const evidence = {
    sources: pack.dataCoverage.sources.map(s => `${s.name} (${s.connector})`),
    period: `${pack.dataCoverage.firstDate ?? '–'} till ${pack.dataCoverage.lastDate ?? '–'}`,
    findings_considered: findings.length,
    datapoints: pack.dataCoverage.txCount + pack.dataCoverage.invoiceCount
  };
  run('INSERT INTO questions (id, org_id, user_id, question, answer, evidence_json, model, asked_at) VALUES (?,?,?,?,?,?,?,?)',
    uuid(), orgId, userId, question, answer, JSON.stringify(evidence), provider.model, now());
  return { answer, model: provider.model, evidence };
}

function deterministicAnswer(orgId: string, question: string, pack: MetricPack, findings: FindingRow[]): string {
  const q = question.toLowerCase();
  const fmtKr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';
  const parts: string[] = [];

  const lastIdx = pack.revenueByMonth.length - 2;
  const lastRev = lastIdx >= 0 ? pack.revenueByMonth[lastIdx] : null;

  if (/likviditet|kassa|betalningsförmåga/.test(q)) {
    const liq = computeLiquidity(orgId);
    if (liq.riskLevel === 'unknown') parts.push('Likviditetsläget kan inte bedömas fullt ut eftersom kassaposition saknas i verksamhetsprofilen.');
    else parts.push(`Likviditetsrisken bedöms som ${liq.riskLevel === 'low' ? 'låg' : liq.riskLevel === 'medium' ? 'måttlig' : liq.riskLevel === 'high' ? 'hög' : 'kritisk'}. Lägsta prognostiserade saldo de kommande 13 veckorna är ${fmtKr(liq.minBalance ?? 0)} (vecka ${liq.minWeek}).`);
    const topOverdue = pack.receivables.topDebtors.filter(d => d.overdue > 0).slice(0, 3);
    if (topOverdue.length) parts.push(`Störst påverkan på likviditeten från kundsidan: ${topOverdue.map(d => `${d.name} (${fmtKr(d.overdue)} förfallet)`).join(', ')}.`);
  } else if (/risk/.test(q)) {
    const top = findings.filter(f => ['critical', 'high', 'medium'].includes(f.severity))[0];
    parts.push(top ? `Den största identifierade risken just nu: ${top.title}. ${top.description}` : 'Inga väsentliga risker är identifierade i nuvarande data.');
  } else if (/beslut/.test(q)) {
    const ds = all<{ title: string; decided_at: string; expected_result: string | null }>(
      'SELECT title, decided_at, expected_result FROM decisions WHERE org_id = ? ORDER BY decided_at DESC LIMIT 5', orgId);
    parts.push(ds.length ? 'Senaste beslut: ' + ds.map(d => `${d.decided_at.slice(0, 10)}: ${d.title}`).join('; ') + '.' : 'Inga beslut finns registrerade.');
  } else if (/åtgärd|effekt/.test(q)) {
    const as = all<{ title: string; status: string; effect_verified: string | null }>(
      'SELECT title, status, effect_verified FROM actions WHERE org_id = ? ORDER BY created_at DESC LIMIT 8', orgId);
    if (!as.length) parts.push('Inga åtgärder finns registrerade.');
    else {
      const eff = as.filter(a => a.effect_verified === 'effective');
      const ineff = as.filter(a => a.effect_verified === 'ineffective');
      parts.push(`Registrerade åtgärder: ${as.length}.` +
        (eff.length ? ` Med observerad effekt: ${eff.map(a => a.title).join(', ')}.` : '') +
        (ineff.length ? ` Utan observerad effekt hittills: ${ineff.map(a => a.title).join(', ')}.` : ''));
    }
  } else if (/förändra|hänt|sedan förra/.test(q)) {
    const recent = findings.slice(0, 4);
    parts.push(recent.length ? 'Senaste väsentliga observationer: ' + recent.map(f => f.title).join('; ') + '.' : 'Inga nya väsentliga förändringar har identifierats.');
  } else if (/omsättning|resultat|försäljning/.test(q)) {
    if (lastRev) {
      parts.push(`Omsättningen senaste kompletta månad (${lastRev.period}) var ${fmtKr(lastRev.value)}.`);
      const relevant = findings.filter(f => f.category === 'revenue');
      relevant.forEach(f => parts.push(f.description));
    } else parts.push('Det finns ännu inte tillräcklig intäktsdata för att besvara frågan.');
  } else {
    const top = findings.filter(f => f.severity !== 'info').slice(0, 3);
    parts.push(top.length
      ? 'Utifrån aktuellt läge är detta viktigast: ' + top.map(f => f.title).join('; ') + '.'
      : 'Verksamheten uppvisar ett stabilt läge; inga väsentliga avvikelser identifierade.');
  }

  parts.push('');
  parts.push('(Svaret är deterministiskt sammanställt från systemets beräknade nyckeltal och findings. Konfigurera en språkmodell för friare analys.)');
  return parts.join('\n');
}
