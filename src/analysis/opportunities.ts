// Background Intelligence — the system works when the owner isn't talking
// to it. Deterministic detectors scan the business for OPPORTUNITIES:
// things that could get better. Every detector produces a curious question,
// never a verdict. "The system must be capable of discovering questions the
// owner did not know to ask."
//
// Tax detectors follow LEGAL TAX EFFICIENCY: identify things worth
// investigating within the rules — never conceal, misclassify or construct.
// Tax rules are year- and situation-dependent; detectors therefore raise
// questions flagged for human/professional review, they never assert rules.

import { all, get, run, uuid, now } from '../db';
import { computeMetrics, trailingAvg, getProfile, profileNumber, round2 } from './metrics';
import { computeProductivity } from './productivity';
import { computeLiquidity } from './liquidity';

const fmtKr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';

export interface OpportunityDraft {
  fingerprint: string;
  kind: string;
  domain: string;
  title: string;
  rationale: string;
  potential_effect?: string;
  caution?: string;
  confidence: number;
  requires_human_review?: boolean;
  evidence?: unknown;
}

export interface OpportunityRow {
  id: string; org_id: string; fingerprint: string; kind: string; domain: string;
  title: string; rationale: string; potential_effect: string | null; caution: string | null;
  confidence: number; requires_human_review: number; status: string;
  evidence_json: string | null; detected_at: string; updated_at: string; dismissed_reason: string | null;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectPurchasing(orgId: string, drafts: OpportunityDraft[]): void {
  const pack = computeMetrics(orgId);
  const lastIdx = pack.months.length - 2;
  if (lastIdx < 3) return;
  const recent = pack.costByCategory.map(c => ({
    category: c.category,
    total3: c.months.slice(lastIdx - 2, lastIdx + 1).reduce((a, p) => a + p.value, 0)
  }));
  const totalCosts = recent.reduce((a, c) => a + c.total3, 0);
  if (totalCosts <= 0) return;
  for (const c of recent) {
    const share = c.total3 / totalCosts;
    const yearly = Math.round(c.total3 * 4);
    if (share >= 0.25 && yearly >= 500000 && !/löner|hyra|lokal/.test(c.category)) {
      drafts.push({
        fingerprint: `purchasing:${c.category}`,
        kind: 'purchasing',
        domain: 'inköp',
        title: `Inköpsmöjlighet: ${c.category} står för ${(share * 100).toFixed(0)} % av kostnaderna`,
        rationale: `Ni köper cirka ${fmtKr(yearly)}/år i kategorin "${c.category}". Vid volymer i den storleken kan det vara värt att jämföra direktinköp från producent eller större distributör mot nuvarande leverantörsled, alternativt omförhandla villkor.`,
        potential_effect: 'Lägre inköpskostnad vid oförändrad kvalitet.',
        caution: 'Kontrollera först: frakt, tull, garanti, ledtider, kapitalbindning och produktansvar. Nuvarande leverantörsval kan vara avsiktligt.',
        confidence: 0.7,
        evidence: { category: c.category, three_month_total: round2(c.total3), share_of_costs: round2(share), estimated_yearly: yearly }
      });
    }
  }
}

function detectTaxInvestment(orgId: string, drafts: OpportunityDraft[]): void {
  const sixMonthsAgo = new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10);
  const rows = all<{ id: string; date: string; description: string | null; amount: number; category: string | null }>(
    `SELECT id, date, description, amount, category FROM transactions
     WHERE org_id = ? AND kind = 'cost' AND date >= ? AND amount >= 200000 ORDER BY amount DESC LIMIT 3`, orgId, sixMonthsAgo);
  for (const r of rows) {
    drafts.push({
      fingerprint: `tax_investment:${r.id}`,
      kind: 'tax',
      domain: 'skatt_ägare',
      title: `Större investering (${fmtKr(r.amount)}) — skattemässig behandling bör kontrolleras`,
      rationale: `Ni har bokfört en större utgift ${r.date} (${r.description ?? r.category ?? 'utan beskrivning'}, ${fmtKr(r.amount)}). För inventarier finns olika regler om omedelbart avdrag respektive värdeminskningsavdrag — rätt behandling beror på typ, livslängd och beskattningsår.`,
      potential_effect: 'Korrekt och skatteeffektiv behandling av investeringen.',
      caution: 'Regelverket måste verifieras mot aktuellt beskattningsår. Stäm av med redovisningskonsult — detta är beslutsstöd, inte skatterådgivning.',
      confidence: 0.65,
      requires_human_review: true,
      evidence: { transaction: { date: r.date, amount: r.amount, description: r.description, category: r.category } }
    });
  }
}

function detectTaxDevelopment(orgId: string, drafts: OpportunityDraft[]): void {
  const sixMonthsAgo = new Date(Date.now() - 183 * 86400000).toISOString().slice(0, 10);
  const dev = get<{ total: number | null; cnt: number }>(
    `SELECT SUM(amount) as total, COUNT(*) as cnt FROM transactions
     WHERE org_id = ? AND kind = 'cost' AND date >= ?
     AND (category LIKE '%utveckling%' OR description LIKE '%utveckling%' OR category LIKE '%development%')`, orgId, sixMonthsAgo);
  if (!dev?.total || dev.total < 300000) return;
  drafts.push({
    fingerprint: 'tax_rnd',
    kind: 'tax',
    domain: 'skatt_ägare',
    title: `Utvecklingskostnader (${fmtKr(dev.total)}) — kan vara relevanta för FoU-regler`,
    rationale: `Ni har haft ${fmtKr(dev.total)} i utvecklingsrelaterade kostnader det senaste halvåret. En fråga värd att ställa: har någon bedrivit systematisk teknisk utveckling eller löst tekniska problem utan uppenbar lösning? I så fall kan delar av arbetet vara relevant för FoU-incitament.`,
    potential_effect: 'Möjligt skatteincitament om villkoren är uppfyllda.',
    caution: 'FoU-bedömningar är komplexa och felaktiga anspråk förekommer. Kartlägg personer, perioder och det tekniska innehållet innan något yrkas. Kräver professionell kontroll.',
    confidence: 0.55,
    requires_human_review: true,
    evidence: { six_month_development_costs: round2(dev.total), transactions: dev.cnt }
  });
}

function detectOwnerDrawReview(orgId: string, drafts: OpportunityDraft[]): void {
  const pack = computeMetrics(orgId);
  const result12 = pack.resultByMonth.reduce((a, p) => a + p.value, 0);
  const liq = computeLiquidity(orgId);
  if (result12 < 500000) return;
  if (liq.startBalance === null || liq.bufferTarget === null) return;
  const headroom = (liq.minBalance ?? liq.startBalance) - liq.bufferTarget;
  if (headroom < 100000) return;
  drafts.push({
    fingerprint: 'owner_draw_review',
    kind: 'tax',
    domain: 'skatt_ägare',
    title: 'Möjligt utrymme för ägaruttag — scenarier bör jämföras först',
    rationale: `Resultatet senaste 12 månaderna är ${fmtKr(result12)} och likviditetsprognosen visar ${fmtKr(headroom)} ovanför bufferten. Innan beslut bör lön, utdelning och att behålla kapital jämföras utifrån din situation i år.`,
    potential_effect: 'Skatteeffektivt ägaruttag inom regelverket.',
    caution: 'Kontrollera kommande skatter, moms och arbetsgivaravgifter först. Valet mellan lön och utdelning styrs av regler som förändras — stäm av med redovisningskonsult.',
    confidence: 0.6,
    requires_human_review: true,
    evidence: { result_12m: Math.round(result12), liquidity_headroom: Math.round(headroom) }
  });
}

function detectIncentiveVariation(orgId: string, drafts: OpportunityDraft[]): void {
  const p = computeProductivity(orgId);
  if (!p.hasData) return;
  const ratios = p.byEmployee.map(e => e.recentRatio).filter((r): r is number => r !== null && r > 0);
  if (ratios.length < 4) return;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
  const cv = sd / mean;
  if (cv < 0.12) return;
  // Detect patterns, not verdicts: no individual is named in the title.
  drafts.push({
    fingerprint: 'incentive_variation',
    kind: 'incentive',
    domain: 'personal',
    title: `Produktiviteten varierar kraftigt mellan personer (±${(cv * 100).toFixed(0)} %)`,
    rationale: 'Skillnaden mellan personer med liknande arbetsförutsättningar har kvarstått de senaste veckorna och kan inte förklaras av arbetsvolymen i underlaget. Det kan finnas flera orsaker — arbetsfördelning, ordertyper, frånvaro eller stöd/behov. En möjlig ledningsåtgärd är ett teammål kopplat till produktivitet och kvalitet.',
    potential_effect: 'Jämnare kapacitetsutnyttjande och tydligare förväntningar.',
    caution: 'Dra inga slutsatser om enskilda personer utan att förstå orsaken. Basera inte incitament enbart på timmar — det kan skapa fel beteenden (maximera timmar i stället för kvalitet och rätt första gången).',
    confidence: 0.65,
    evidence: { coefficient_of_variation: round2(cv), employees_analyzed: ratios.length, per_employee: p.byEmployee.map(e => ({ name: e.name, recent: e.recentRatio, baseline: e.baselineRatio })) }
  });
}

function detectPricingReview(orgId: string, drafts: OpportunityDraft[]): void {
  const pack = computeMetrics(orgId);
  const lastIdx = pack.months.length - 2;
  if (lastIdx < 5) return;
  const marginAt = (i: number) => {
    const rev = pack.revenueByMonth[i]?.value ?? 0;
    return rev > 0 ? (pack.resultByMonth[i]?.value ?? 0) / rev : null;
  };
  const recent = [lastIdx - 1, lastIdx].map(marginAt).filter((m): m is number => m !== null);
  const baselineIdx = [lastIdx - 5, lastIdx - 4, lastIdx - 3, lastIdx - 2];
  const baseline = baselineIdx.map(marginAt).filter((m): m is number => m !== null);
  if (recent.length < 2 || baseline.length < 3) return;
  const rAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const bAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (bAvg - rAvg < 0.03) return;
  drafts.push({
    fingerprint: 'pricing_review',
    kind: 'pricing',
    domain: 'försäljning',
    title: `Marginalen har fallit ${((bAvg - rAvg) * 100).toFixed(1)} procentenheter — är prissättningen rätt?`,
    rationale: `Marginalen de senaste två månaderna (${(rAvg * 100).toFixed(1)} %) ligger under tidigare nivå (${(bAvg * 100).toFixed(1)} %). Innan kostnadsjakt är en fråga värd att ställa: speglar priserna fortfarande kostnadsläget, eller har kostnadsökningar absorberats utan prisjustering?`,
    potential_effect: 'Återställd marginal via prisjustering i stället för enbart kostnadsbesparingar.',
    caution: 'Testa prisförändringar på nya offerter före generell höjning. Kontrollera kundmix — marginalfallet kan bero på mixförändring.',
    confidence: 0.7,
    evidence: { recent_margin: round2(rAvg), baseline_margin: round2(bAvg) }
  });
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

/** Run all opportunity detectors. Dismissed fingerprints are never
 *  re-proposed (user preference), but the underlying business facts remain
 *  in the reality model. */
export function runOpportunityScan(orgId: string): { created: number; updated: number; total_active: number } {
  const drafts: OpportunityDraft[] = [];
  detectPurchasing(orgId, drafts);
  detectTaxInvestment(orgId, drafts);
  detectTaxDevelopment(orgId, drafts);
  detectOwnerDrawReview(orgId, drafts);
  detectIncentiveVariation(orgId, drafts);
  detectPricingReview(orgId, drafts);

  let created = 0, updated = 0;
  for (const d of drafts) {
    const existing = get<OpportunityRow>(
      'SELECT * FROM opportunities WHERE org_id = ? AND fingerprint = ?', orgId, d.fingerprint);
    if (existing) {
      if (existing.status === 'dismissed') continue; // learned preference
      if (existing.status === 'proposed') {
        run('UPDATE opportunities SET title=?, rationale=?, potential_effect=?, caution=?, confidence=?, evidence_json=?, updated_at=? WHERE id=?',
          d.title, d.rationale, d.potential_effect ?? null, d.caution ?? null, d.confidence,
          d.evidence !== undefined ? JSON.stringify(d.evidence) : null, now(), existing.id);
        updated++;
      }
      continue;
    }
    run(`INSERT INTO opportunities (id, org_id, fingerprint, kind, domain, title, rationale, potential_effect, caution,
          confidence, requires_human_review, status, evidence_json, detected_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uuid(), orgId, d.fingerprint, d.kind, d.domain, d.title, d.rationale,
      d.potential_effect ?? null, d.caution ?? null, d.confidence, d.requires_human_review ? 1 : 0,
      'proposed', d.evidence !== undefined ? JSON.stringify(d.evidence) : null, now(), now());
    created++;
  }
  const total = get<{ c: number }>(
    "SELECT COUNT(*) as c FROM opportunities WHERE org_id = ? AND status IN ('proposed','investigating')", orgId);
  return { created, updated, total_active: total?.c ?? 0 };
}

export function listOpportunities(orgId: string, includeDismissed = false): OpportunityRow[] {
  return all<OpportunityRow>(
    includeDismissed
      ? 'SELECT * FROM opportunities WHERE org_id = ? ORDER BY detected_at DESC LIMIT 50'
      : "SELECT * FROM opportunities WHERE org_id = ? AND status IN ('proposed','investigating') ORDER BY confidence DESC, detected_at DESC LIMIT 50",
    orgId);
}

export function dismissOpportunity(orgId: string, id: string, reason: string | null): boolean {
  const opp = get<OpportunityRow>('SELECT * FROM opportunities WHERE id = ? AND org_id = ?', id, orgId);
  if (!opp) return false;
  run("UPDATE opportunities SET status='dismissed', dismissed_reason=?, updated_at=? WHERE id=?", reason, now(), id);
  return true;
}

// ---------------------------------------------------------------------------
// Investigations — locked-context threads
// ---------------------------------------------------------------------------

export function createInvestigation(
  orgId: string, userId: string | null,
  input: { title: string; question?: string; trigger_kind?: string; trigger_id?: string; context?: unknown }
): string {
  const id = uuid();
  run(`INSERT INTO investigations (id, org_id, title, question, trigger_kind, trigger_id, status, context_json, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, orgId, input.title, input.question ?? null, input.trigger_kind ?? 'manual', input.trigger_id ?? null,
    'open', input.context !== undefined ? JSON.stringify(input.context) : null, userId, now());
  if (input.trigger_kind === 'opportunity' && input.trigger_id) {
    run("UPDATE opportunities SET status='investigating', updated_at=? WHERE id=? AND org_id=?", now(), input.trigger_id, orgId);
  }
  return id;
}

export function investigationWithMessages(orgId: string, id: string): {
  investigation: Record<string, unknown> | undefined;
  messages: { role: string; content: string; model: string | null; created_at: string }[];
} {
  const inv = get<Record<string, unknown>>('SELECT * FROM investigations WHERE id = ? AND org_id = ?', id, orgId);
  const messages = inv ? all<{ role: string; content: string; model: string | null; created_at: string }>(
    'SELECT role, content, model, created_at FROM investigation_messages WHERE investigation_id = ? ORDER BY created_at', id) : [];
  return { investigation: inv, messages };
}

export function addInvestigationMessage(orgId: string, investigationId: string, role: 'user' | 'system', content: string, model?: string): void {
  run('INSERT INTO investigation_messages (id, org_id, investigation_id, role, content, model, created_at) VALUES (?,?,?,?,?,?,?)',
    uuid(), orgId, investigationId, role, content, model ?? null, now());
}

export function concludeInvestigation(orgId: string, id: string, conclusion: string, confidence: number | null): boolean {
  const inv = get<{ id: string; trigger_kind: string | null; trigger_id: string | null }>(
    'SELECT id, trigger_kind, trigger_id FROM investigations WHERE id = ? AND org_id = ?', id, orgId);
  if (!inv) return false;
  run("UPDATE investigations SET status='concluded', conclusion=?, confidence=?, concluded_at=? WHERE id=?",
    conclusion, confidence, now(), id);
  return true;
}
