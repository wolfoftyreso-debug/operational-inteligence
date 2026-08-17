// Analysis engine — deterministic rules that turn the metric pack into
// structured findings with full evidence chains. The reasoning model never
// invents numbers; it interprets what this engine computed.

import { all, get, run, uuid, now, today } from '../db';
import type { FindingDraft, FindingRow, EvidenceItem, MetricPack, OverallStatus, Severity } from '../domain/types';
import { computeMetrics, trailingAvg, getProfile, profileNumber, round2 } from './metrics';
import { computeLiquidity } from './liquidity';
import { listSourceLabels } from '../ingest/normalize';
import { dispatchAlertsForFinding } from '../alerts/engine';
import { generateNarrative } from '../reasoning';
import { sensitivityMultiplier, suppressBelowFraction } from '../core/settings';
import { goalTargetForMonth } from '../core/hierarchy';
import { computeProductivity } from './productivity';

// Guidance domains — the navigator categories. Findings carry a category;
// the domain is derived so every surface (brief, dashboard, chat) can group
// information the way an owner thinks, not the way tables are named.
export const DOMAIN_FOR_CATEGORY: Record<string, string> = {
  revenue: 'ekonomi', costs: 'ekonomi', liquidity: 'ekonomi', receivables: 'ekonomi',
  operations: 'drift', staffing: 'personal', purchasing: 'inköp', sales: 'försäljning',
  marketing: 'marknad', tax_owner: 'skatt_ägare', concentration: 'risk', memory: 'risk',
  follow_up: 'mål', stability: 'mål', coverage: 'system', discovery: 'system'
};
export function domainFor(category: string): string {
  return DOMAIN_FOR_CATEGORY[category] ?? 'ekonomi';
}

const fmtKr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';
const fmtPct = (n: number) => (n * 100).toFixed(1).replace('.', ',') + ' %';

/** Confidence heuristic based on data coverage. */
function baseConfidence(pack: MetricPack): number {
  let c = 0.5;
  if (pack.dataCoverage.monthsOfHistory >= 6) c += 0.2;
  if (pack.dataCoverage.monthsOfHistory >= 12) c += 0.1;
  if (pack.dataCoverage.txCount > 200) c += 0.1;
  return Math.min(0.95, c);
}

function srcEvidence(orgId: string): EvidenceItem {
  const labels = listSourceLabels(orgId);
  return {
    kind: 'fact',
    label: 'Datakällor som använts',
    value: labels.length ? labels.join(', ') : 'Endast manuell data',
    source_label: 'Systemets källregister'
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function ruleRevenueVsPlan(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const lastIdx = pack.revenueByMonth.length - 2; // last complete month
  if (lastIdx < 0) return;
  const last = pack.revenueByMonth[lastIdx];
  if (last.value === 0) return;
  // Plan source priority: active goal for the month (Organizational Context
  // Graph) → manual profile target. The goal is the governing truth.
  const monthGoal = goalTargetForMonth(orgId, 'revenue', last.period);
  const profile = getProfile(orgId);
  const profileTarget = profileNumber(profile, 'monthly_revenue_target');
  const budget = monthGoal ? monthGoal.target : profileTarget;
  const budgetSource = monthGoal
    ? `Mål: ${monthGoal.goal.label} (${monthGoal.goal.source === 'document' ? 'styrande dokument' : monthGoal.goal.source === 'breakdown' ? 'nedbrutet årsmål' : 'manuellt mål'})`
    : 'Verksamhetsprofil (manuell uppgift)';
  if (budget === null || budget <= 0) return;
  const m = sensitivityMultiplier(orgId);
  const floor = Math.max(0.05 * m, suppressBelowFraction(orgId));
  const dev = (last.value - budget) / budget;
  if (dev < -floor) {
    // Where is the deviation concentrated?
    const unitDevs = pack.revenueByUnit.map(u => {
      const cur = u.months[lastIdx]?.value ?? 0;
      const base = trailingAvg(u.months, pack.revenueByMonth.length - lastIdx);
      return { unit: u.unit, cur, base, drop: base ? (cur - base) / base : 0 };
    }).filter(u => u.base !== null && u.drop < -0.08).sort((a, b) => a.drop - b.drop);
    const worst = unitDevs[0];
    const severity: Severity = dev < -0.15 ? 'high' : 'medium';
    drafts.push({
      fingerprint: 'revenue_below_plan',
      severity,
      category: 'revenue',
      epistemic: 'derived',
      title: `Omsättningen ligger ${fmtPct(Math.abs(dev))} under plan`,
      description:
        `Omsättningen för ${last.period} var ${fmtKr(last.value)} mot planens ${fmtKr(budget)} (${fmtPct(dev)}).` +
        (worst ? ` Avvikelsen är koncentrerad till ${worst.unit}, som ligger ${fmtPct(Math.abs(worst.drop))} under sin historiska nivå.` : '') +
        ' Analysera ordermix och faktureringsgrad innan kapacitetsförändringar beslutas.',
      confidence: baseConfidence(pack),
      affected_entities: worst ? [{ type: 'business_unit', name: worst.unit }] : [],
      recommended_actions: [
        'Gå igenom ordermix och faktureringsgrad för den avvikande perioden',
        worst ? `Följ upp orderläget för ${worst.unit}` : 'Följ upp orderläget per enhet'
      ],
      expected_effect: 'Identifierad rotorsak till intäktsavvikelsen inom 2 veckor',
      period_start: last.period + '-01',
      period_end: last.period + '-28',
      evidence: [
        { kind: 'fact', label: `Omsättning ${last.period}`, value: fmtKr(last.value), period: last.period, source_label: 'Normaliserade transaktioner', data: pack.revenueByMonth },
        { kind: 'fact', label: 'Månatligt omsättningsmål', value: fmtKr(budget), source_label: budgetSource },
        { kind: 'derived', label: 'Avvikelse mot plan', value: fmtPct(dev), calculation: `(${fmtKr(last.value)} − ${fmtKr(budget)}) / ${fmtKr(budget)}` },
        ...(worst ? [{ kind: 'derived' as const, label: `Avvikelse ${worst.unit}`, value: fmtPct(worst.drop), calculation: 'Senaste månad jämfört med 6 månaders glidande medel för enheten', data: unitDevs }] : [])
      ]
    });
  }
}

function ruleRevenueTrend(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const lastIdx = pack.revenueByMonth.length - 2;
  if (lastIdx < 1) return;
  const last = pack.revenueByMonth[lastIdx];
  const base = trailingAvg(pack.revenueByMonth, pack.revenueByMonth.length - lastIdx);
  if (base === null || base <= 0 || last.value === 0) return;
  const m = sensitivityMultiplier(orgId);
  const floor = Math.max(0.12 * m, suppressBelowFraction(orgId));
  const change = (last.value - base) / base;
  if (change < -floor) {
    // Season awareness: the system learns what "normal" means for THIS
    // business. If the same month last year dipped similarly against its own
    // baseline, this is probably rhythm — not an anomaly.
    let seasonal = false;
    let seasonalNote: string | null = null;
    const lyIdx = lastIdx - 12;
    if (lyIdx >= 3) {
      const lyPoint = pack.revenueByMonth[lyIdx];
      const lyBase = trailingAvg(pack.revenueByMonth.slice(0, lyIdx + 1), 1);
      if (lyPoint && lyBase && lyBase > 0 && lyPoint.value > 0) {
        const lyChange = (lyPoint.value - lyBase) / lyBase;
        if (lyChange < -floor * 0.6 && Math.abs(lyChange - change) < 0.12) {
          seasonal = true;
          seasonalNote = `Samma månad förra året (${lyPoint.period}) låg ${fmtPct(Math.abs(lyChange))} under sin dåvarande nivå — detta liknar verksamhetens säsongsmönster snarare än en avvikelse.`;
        }
      }
    }
    drafts.push({
      fingerprint: 'revenue_trend_down',
      severity: seasonal ? 'low' : (change < -0.25 ? 'high' : 'medium'),
      category: 'revenue',
      epistemic: 'derived',
      title: seasonal
        ? `Omsättningen är ${fmtPct(Math.abs(change))} under snittet — men följer säsongsmönstret`
        : `Omsättningstrenden viker — ${fmtPct(Math.abs(change))} under historisk nivå`,
      description: `Omsättningen ${last.period} (${fmtKr(last.value)}) ligger ${fmtPct(Math.abs(change))} under det glidande sexmånaderssnittet (${fmtKr(base)}).` + (seasonalNote ? ' ' + seasonalNote : ''),
      confidence: baseConfidence(pack) * 0.95,
      recommended_actions: seasonal ? [] : ['Analysera orderingång och pipeline', 'Jämför med säsongsmönster föregående år'],
      expected_effect: seasonal ? undefined : 'Bekräftad eller avfärdad trendförändring',
      period_end: last.period + '-28',
      evidence: [
        { kind: 'fact', label: `Omsättning ${last.period}`, value: fmtKr(last.value), period: last.period, source_label: 'Normaliserade transaktioner' },
        { kind: 'derived', label: 'Glidande 6-mån-snitt', value: fmtKr(base), calculation: 'Medel av föregående 6 månaders omsättning', data: pack.revenueByMonth },
        ...(seasonalNote ? [{ kind: 'derived' as const, label: 'Säsongsjämförelse', value: seasonalNote, calculation: 'Samma kalendermånad föregående år jämförd mot sitt eget glidande snitt' }] : [])
      ]
    });
  } else if (change > 0.15) {
    drafts.push({
      fingerprint: 'revenue_trend_up',
      severity: 'info',
      category: 'revenue',
      epistemic: 'derived',
      title: `Omsättningen växer — ${fmtPct(change)} över historisk nivå`,
      description: `Omsättningen ${last.period} (${fmtKr(last.value)}) ligger ${fmtPct(change)} över sexmånaderssnittet (${fmtKr(base)}). Säkerställ att kapacitet och likviditet följer med tillväxten.`,
      confidence: baseConfidence(pack) * 0.95,
      recommended_actions: [],
      period_end: last.period + '-28',
      evidence: [
        { kind: 'fact', label: `Omsättning ${last.period}`, value: fmtKr(last.value), period: last.period, source_label: 'Normaliserade transaktioner' },
        { kind: 'derived', label: 'Glidande 6-mån-snitt', value: fmtKr(base), calculation: 'Medel av föregående 6 månaders omsättning' }
      ]
    });
  }
}

function ruleReceivables(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const r = pack.receivables;
  if (r.openTotal <= 0) return;
  const m = sensitivityMultiplier(orgId);
  const overdueShare = r.overdueTotal / r.openTotal;
  if (r.overdueTotal > 0 && overdueShare > 0.25 * m) {
    const top = r.topDebtors.filter(d => d.overdue > 0).slice(0, 3);
    drafts.push({
      fingerprint: 'receivables_overdue',
      severity: overdueShare > 0.45 ? 'high' : 'medium',
      category: 'receivables',
      epistemic: 'derived',
      title: `Förfallna kundfordringar: ${fmtKr(r.overdueTotal)} (${fmtPct(overdueShare)} av utestående)`,
      description:
        `${r.overdueCount} av ${r.openCount} öppna kundfakturor är förfallna, totalt ${fmtKr(r.overdueTotal)}.` +
        (top.length ? ` Störst exponering: ${top.map(d => `${d.name} (${fmtKr(d.overdue)})`).join(', ')}.` : '') +
        (r.dsoDays !== null ? ` Genomsnittlig betaltid är ${r.dsoDays} dagar.` : ''),
      confidence: Math.min(0.95, baseConfidence(pack) + 0.1),
      affected_entities: top.map(d => ({ type: 'customer', name: d.name })),
      recommended_actions: ['Prioritera påminnelser/inkasso för de största förfallna posterna', 'Se över betalningsvillkor för återkommande sena betalare'],
      expected_effect: 'Minskad förfallen fordringsstock inom 30 dagar',
      evidence: [
        { kind: 'fact', label: 'Utestående kundfordringar', value: fmtKr(r.openTotal), source_label: 'Normaliserade kundfakturor', data: r.topDebtors },
        { kind: 'fact', label: 'Varav förfallet', value: fmtKr(r.overdueTotal), source_label: 'Normaliserade kundfakturor' },
        { kind: 'derived', label: 'Förfallen andel', value: fmtPct(overdueShare), calculation: 'Förfallet belopp / totalt utestående' },
        ...(r.dsoDays !== null ? [{ kind: 'derived' as const, label: 'Genomsnittlig betaltid (DSO)', value: `${r.dsoDays} dagar`, calculation: 'Medel av dagar från fakturadatum till betaldatum, senaste 6 mån' }] : [])
      ]
    });
  }
}

function ruleCostAnomaly(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const lastIdx = pack.months.length - 2;
  if (lastIdx < 3) return;
  const m = sensitivityMultiplier(orgId);
  const floor = Math.max(0.30 * m, suppressBelowFraction(orgId));
  for (const cat of pack.costByCategory) {
    const cur = cat.months[lastIdx]?.value ?? 0;
    const base = trailingAvg(cat.months, cat.months.length - lastIdx);
    if (base === null || base < 5000) continue;
    const change = (cur - base) / base;
    if (change > floor && cur - base > 10000 * m) {
      drafts.push({
        fingerprint: `cost_anomaly:${cat.category}`,
        severity: change > 0.6 ? 'high' : 'medium',
        category: 'costs',
        epistemic: 'derived',
        title: `Kostnaden för ${cat.category} avviker: +${fmtPct(change)} mot normalnivå`,
        description: `Kostnadskategorin "${cat.category}" var ${fmtKr(cur)} i ${pack.months[lastIdx]}, mot en historisk nivå på ${fmtKr(base)}/mån (+${fmtKr(cur - base)}).`,
        confidence: baseConfidence(pack) * 0.9,
        recommended_actions: [`Granska underliggande poster i kategorin ${cat.category}`],
        expected_effect: 'Förklarad eller åtgärdad kostnadsavvikelse',
        period_end: pack.months[lastIdx] + '-28',
        evidence: [
          { kind: 'fact', label: `Kostnad ${cat.category} ${pack.months[lastIdx]}`, value: fmtKr(cur), period: pack.months[lastIdx], source_label: 'Normaliserade transaktioner', data: cat.months },
          { kind: 'derived', label: 'Historisk nivå', value: fmtKr(base) + '/mån', calculation: 'Glidande 6-månaderssnitt för kategorin' },
          { kind: 'derived', label: 'Avvikelse', value: '+' + fmtPct(change), calculation: '(aktuell − historisk) / historisk' }
        ]
      });
    }
  }
}

function ruleLiquidity(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const fc = computeLiquidity(orgId);
  if (fc.riskLevel === 'unknown') {
    if (pack.dataCoverage.invoiceCount > 0) {
      drafts.push({
        fingerprint: 'liquidity_unknown',
        severity: 'info',
        category: 'liquidity',
        epistemic: 'fact',
        title: 'Likviditetsläget kan inte bedömas — kassaposition saknas',
        description: 'Systemet har fakturadata men ingen angiven kassaposition. Ange aktuell kassa och önskad likviditetsbuffert i verksamhetsprofilen för att aktivera likviditetsprognosen.',
        confidence: 0.95,
        recommended_actions: ['Ange kassaposition och likviditetsbuffert i verksamhetsprofilen'],
        evidence: [
          { kind: 'fact', label: 'Kassaposition', value: 'Ej angiven', source_label: 'Verksamhetsprofil (manuell uppgift)' }
        ]
      });
    }
    return;
  }
  if (fc.riskLevel === 'high' || fc.riskLevel === 'critical' || fc.riskLevel === 'medium') {
    const sevMap: Record<string, Severity> = { medium: 'medium', high: 'high', critical: 'critical' };
    drafts.push({
      fingerprint: 'liquidity_risk',
      severity: sevMap[fc.riskLevel],
      category: 'liquidity',
      epistemic: 'forecast',
      title: fc.riskLevel === 'critical'
        ? `Likviditetsprognosen visar negativt saldo vecka ${fc.minWeek}`
        : `Likviditeten väntas understiga bufferten (lägst ${fmtKr(fc.minBalance!)} vecka ${fc.minWeek})`,
      description:
        `13-veckorsprognosen når som lägst ${fmtKr(fc.minBalance!)} (vecka som börjar ${fc.minWeek}).` +
        (fc.bufferTarget !== null ? ` Angiven buffert är ${fmtKr(fc.bufferTarget)}.` : '') +
        ` Prognosen bygger på öppna fakturor, fasta kostnader och löner.`,
      confidence: 0.7,
      recommended_actions: [
        'Tidigarelägg fakturering och driv in förfallna fordringar',
        'Se över betalningsplan för större leverantörsskulder kring den kritiska perioden'
      ],
      expected_effect: 'Prognostiserat lägsta saldo över buffertnivån',
      evidence: [
        { kind: 'fact', label: 'Kassaposition (start)', value: fmtKr(fc.startBalance!), source_label: fc.startBalanceSource },
        ...(fc.bufferTarget !== null ? [{ kind: 'fact' as const, label: 'Likviditetsbuffert (mål)', value: fmtKr(fc.bufferTarget), source_label: 'Verksamhetsprofil (manuell uppgift)' }] : []),
        { kind: 'derived', label: 'Lägsta prognostiserade saldo', value: fmtKr(fc.minBalance!), period: fc.minWeek ?? undefined, calculation: 'Vecko-simulering: kassa + inbetalningar (öppna kundfakturor, justerat för historisk betalförsening) − utbetalningar (leverantörsfakturor, fasta kostnader, löner)', data: fc.weeks },
        { kind: 'fact', label: 'Antaganden', value: fc.assumptions.join(' '), source_label: 'Likviditetsmodellen' }
      ]
    });
  }
}

function ruleConcentration(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const top = pack.customerConcentration[0];
  if (!top || top.share < 0.35) return;
  drafts.push({
    fingerprint: 'customer_concentration',
    severity: top.share > 0.5 ? 'medium' : 'low',
    category: 'concentration',
    epistemic: 'derived',
    title: `Hög kundkoncentration: ${top.name} står för ${fmtPct(top.share)} av faktureringen`,
    description: `Under de senaste tre månaderna står ${top.name} för ${fmtPct(top.share)} av faktureringen (${fmtKr(top.revenue)}). Ett bortfall skulle slå direkt mot omsättning och likviditet.`,
    confidence: baseConfidence(pack) * 0.9,
    affected_entities: [{ type: 'customer', name: top.name }],
    recommended_actions: ['Bedöm relationens stabilitet och avtalsläge', 'Prioritera breddning av kundbasen'],
    evidence: [
      { kind: 'derived', label: `Andel av fakturering (3 mån): ${top.name}`, value: fmtPct(top.share), calculation: 'Kundens fakturering / total fakturering senaste 3 månader', source_label: 'Normaliserade kundfakturor', data: pack.customerConcentration }
    ]
  });
}

/** Productivity — decision intelligence on granular time entries.
 *  Chain: overall drop → concentration → hours normal? → billed-per-worked
 *  down → assessment → decision basis. */
function ruleProductivity(orgId: string, drafts: FindingDraft[]): void {
  const p = computeProductivity(orgId);
  if (!p.hasData || p.overall.change === null || p.baselineWeeks.length < 4) return;
  const m = sensitivityMultiplier(orgId);
  const floor = Math.max(0.05 * m, suppressBelowFraction(orgId));
  if (p.overall.change >= -floor) return;

  const dropPct = Math.abs(p.overall.change);
  const worstUnits = p.byUnit.filter(u => u.change !== null && u.change < -floor).slice(0, 2);
  const worstEmployees = p.byEmployee.filter(e => e.change !== null && e.change < -floor * 1.5).slice(0, 3);

  const chain: string[] = [];
  chain.push(`Produktiviteten (debiterade/arbetade timmar) har minskat ${fmtPct(dropPct)} de senaste ${p.recentWeeks.length} veckorna (${(p.overall.recentRatio! * 100).toFixed(0)} % mot normalt ${(p.overall.baselineRatio! * 100).toFixed(0)} %).`);
  if (worstUnits.length) chain.push(`Minskningen är koncentrerad till ${worstUnits.map(u => u.unit).join(' och ')}.`);
  chain.push(p.overall.hoursNormal
    ? 'Antalet arbetade timmar är normalt — det är debiterade timmar per arbetad timme som minskat.'
    : `Även arbetade timmar avviker (${p.overall.workedRecent} h/v mot normalt ${p.overall.workedBaseline} h/v).`);
  const assessment = p.overall.hoursNormal
    ? 'Förändringen ser i första hand operativ ut snarare än volymrelaterad.'
    : 'Förändringen kan vara volymrelaterad — kontrollera orderingång och bemanning.';

  drafts.push({
    fingerprint: 'productivity_decline',
    severity: dropPct > 0.12 ? 'high' : 'medium',
    category: 'operations',
    epistemic: 'derived',
    title: `Produktiviteten har minskat ${fmtPct(dropPct)}${worstUnits.length ? ' — koncentrerat till ' + worstUnits.map(u => u.unit).join(', ') : ''}`,
    description: chain.join(' ') + ' BEDÖMNING: ' + assessment + ' Innan ytterligare bemanning övervägs rekommenderas analys av arbetsflödet.',
    confidence: 0.85,
    affected_entities: worstUnits.map(u => ({ type: 'business_unit', name: u.unit })),
    recommended_actions: [
      'Analysera arbetsflödet och ordertyperna i de berörda enheterna',
      'Avvakta bemanningsbeslut tills orsaken är utredd'
    ],
    expected_effect: 'Produktivitet tillbaka till normalnivå',
    evidence: [
      { kind: 'derived', label: 'Produktivitet senaste 3 veckor', value: (p.overall.recentRatio! * 100).toFixed(0) + ' %', period: p.recentWeeks.join(', '), calculation: 'Summa debiterade timmar / summa arbetade timmar', source_label: 'Tidsposter (person × dag × arbetsorder)', data: p.weeks },
      { kind: 'derived', label: 'Normalnivå (föregående 6 veckor)', value: (p.overall.baselineRatio! * 100).toFixed(0) + ' %', period: p.baselineWeeks.join(', ') },
      { kind: 'fact', label: 'Arbetade timmar per vecka', value: `${p.overall.workedRecent} h (normalt ${p.overall.workedBaseline} h)`, source_label: 'Tidsposter' },
      ...(worstUnits.length ? [{ kind: 'derived' as const, label: 'Koncentration per enhet', value: worstUnits.map(u => `${u.unit}: ${fmtPct(u.change!)}`).join('; '), data: p.byUnit }] : []),
      ...(worstEmployees.length ? [{ kind: 'derived' as const, label: 'Största förändringar per person', value: worstEmployees.map(e => `${e.name}: ${fmtPct(e.change!)}`).join('; '), data: p.byEmployee, calculation: 'Drill-down: enhet → person → vecka. Underliggande tidsposter finns kvar på dagsnivå.' }] : [])
    ]
  });
}

/** Connector Discovery: repeated manual imports → suggest an integration. */
function ruleConnectorDiscovery(orgId: string, drafts: FindingDraft[]): void {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = all<{ source_id: string; name: string; days: number }>(
    `SELECT r.source_id as source_id, ds.name as name, COUNT(DISTINCT substr(r.imported_at, 1, 10)) as days
     FROM raw_records r JOIN data_sources ds ON ds.id = r.source_id
     WHERE r.org_id = ? AND r.imported_at >= ? AND ds.connector_key IN ('csv','excel')
     GROUP BY r.source_id HAVING days >= 3`, orgId, cutoff);
  for (const r of rows) {
    drafts.push({
      fingerprint: `connector_discovery:${r.source_id}`,
      severity: 'info',
      category: 'discovery',
      epistemic: 'inference',
      title: `Återkommande manuell import upptäckt: ${r.name}`,
      description: `Du har importerat data manuellt till "${r.name}" vid ${r.days} tillfällen den senaste månaden. Det finns sannolikt ett bättre sätt att få in datan automatiskt — en connector mot källsystemet kan byggas eller aktiveras.`,
      confidence: 0.9,
      recommended_actions: ['Undersök om källsystemet har API eller export som kan kopplas som connector'],
      evidence: [
        { kind: 'fact', label: 'Importtillfällen senaste 30 dagarna', value: String(r.days), source_label: 'Systemets importlogg' }
      ]
    });
  }
}

/** Follow-up: completed actions whose expected effect has not materialized. */
function ruleActionFollowUp(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  const doneActions = all<{ id: string; title: string; finding_id: string | null; completed_at: string; expected_effect: string | null }>(
    `SELECT id, title, finding_id, completed_at, expected_effect FROM actions
     WHERE org_id = ? AND status = 'done' AND completed_at IS NOT NULL`, orgId
  );
  for (const a of doneActions) {
    if (!a.finding_id) continue;
    const f = get<{ fingerprint: string; category: string; status: string; title: string }>(
      'SELECT fingerprint, category, status, title FROM findings WHERE id = ?', a.finding_id
    );
    if (!f) continue;
    const daysSince = (Date.now() - Date.parse(a.completed_at)) / 86400000;
    // The linked problem is still open (same fingerprint re-detected) 14+ days after completion
    const stillOpen = get<{ id: string }>(
      "SELECT id FROM findings WHERE org_id = ? AND fingerprint = ? AND status = 'open'", orgId, f.fingerprint
    );
    if (daysSince >= 14 && stillOpen) {
      run("UPDATE actions SET effect_verified = 'ineffective' WHERE id = ?", a.id);
      drafts.push({
        fingerprint: `action_no_effect:${a.id}`,
        severity: 'medium',
        category: 'follow_up',
        epistemic: 'inference',
        title: `Genomförd åtgärd har ännu inte gett förväntad effekt: ${a.title}`,
        description:
          `Åtgärden "${a.title}" markerades som genomförd ${a.completed_at.slice(0, 10)}, men det underliggande problemet (${f.title}) kvarstår.` +
          (a.expected_effect ? ` Förväntad effekt var: ${a.expected_effect}.` : '') +
          ' Överväg att ompröva åtgärden eller analysera om rotorsaken var en annan.',
        confidence: 0.7,
        recommended_actions: ['Utvärdera varför åtgärden inte gett effekt', 'Besluta om alternativ åtgärd'],
        evidence: [
          { kind: 'fact', label: 'Åtgärd genomförd', value: a.completed_at.slice(0, 10), source_label: 'Åtgärdslogg (Management Memory)' },
          { kind: 'fact', label: 'Kopplat problem', value: f.title, source_label: 'Findings-historik' },
          { kind: 'derived', label: 'Dagar sedan genomförande', value: String(Math.floor(daysSince)), calculation: 'Dagens datum − genomförandedatum' }
        ]
      });
    } else if (daysSince >= 14 && !stillOpen && f.status === 'resolved') {
      run("UPDATE actions SET effect_verified = 'effective', observed_effect = COALESCE(observed_effect, 'Det kopplade problemet är inte längre aktivt.') WHERE id = ? AND (effect_verified IS NULL OR effect_verified = 'pending')", a.id);
    }
  }
}

/** Recurrence memory: the same fingerprint detected repeatedly. */
function ruleRecurrence(orgId: string, drafts: FindingDraft[]): void {
  const sixMonthsAgo = new Date(Date.now() - 183 * 86400000).toISOString();
  const rows = all<{ fingerprint: string; cnt: number; title: string }>(
    `SELECT fingerprint, COUNT(*) as cnt, MAX(title) as title FROM findings
     WHERE org_id = ? AND detected_at >= ? AND category NOT IN ('memory','stability','coverage')
     GROUP BY fingerprint HAVING COUNT(*) >= 3`, orgId, sixMonthsAgo
  );
  for (const r of rows) {
    drafts.push({
      fingerprint: `recurring:${r.fingerprint}`,
      severity: 'medium',
      category: 'memory',
      epistemic: 'inference',
      title: `Återkommande problem: identifierat ${r.cnt} gånger på sex månader`,
      description: `Problemet "${r.title}" har identifierats ${r.cnt} gånger under de senaste sex månaderna. Det indikerar en strukturell orsak snarare än en engångshändelse.`,
      confidence: 0.85,
      recommended_actions: ['Hantera rotorsaken strukturellt i stället för symtomen'],
      evidence: [
        { kind: 'derived', label: 'Antal förekomster (6 mån)', value: String(r.cnt), calculation: 'Antal findings med samma identitet i historiken', source_label: 'Findings-historik (Management Memory)' }
      ]
    });
  }
}

function ruleCoverage(orgId: string, pack: MetricPack, drafts: FindingDraft[]): void {
  if (pack.dataCoverage.txCount === 0 && pack.dataCoverage.invoiceCount === 0) {
    drafts.push({
      fingerprint: 'no_data',
      severity: 'info',
      category: 'coverage',
      epistemic: 'fact',
      title: 'Systemet saknar ännu verksamhetsdata',
      description: 'Ingen transaktions- eller fakturadata har importerats. Anslut en datakälla eller importera en CSV/Excel-fil för att aktivera analysen. Systemet redovisar alltid vad det vet och inte vet.',
      confidence: 1,
      recommended_actions: ['Anslut Fortnox/Visma eller importera CSV/Excel under Integrationer'],
      evidence: [srcEvidence(orgId)]
    });
  } else if (pack.dataCoverage.monthsOfHistory < 4) {
    drafts.push({
      fingerprint: 'thin_history',
      severity: 'info',
      category: 'coverage',
      epistemic: 'fact',
      title: `Begränsat historiskt underlag (${pack.dataCoverage.monthsOfHistory} mån) — bedömningar har lägre säkerhet`,
      description: 'Trend- och avvikelseanalys blir tillförlitlig först med minst 4–6 månaders historik. Systemet redovisar därför lägre confidence på sina bedömningar.',
      confidence: 1,
      recommended_actions: [],
      evidence: [
        { kind: 'fact', label: 'Historik', value: `${pack.dataCoverage.monthsOfHistory} månader (${pack.dataCoverage.firstDate} – ${pack.dataCoverage.lastDate})`, source_label: 'Normaliserad data' },
        srcEvidence(orgId)
      ]
    });
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  runId: string;
  overallStatus: OverallStatus;
  newFindings: FindingRow[];
  activeFindings: FindingRow[];
  summary: string;
}

export async function runAnalysis(orgId: string, opts: { skipNarrative?: boolean } = {}): Promise<AnalysisResult> {
  const runId = uuid();
  run('INSERT INTO analysis_runs (id, org_id, started_at, status) VALUES (?,?,?,?)', runId, orgId, now(), 'running');

  const pack = computeMetrics(orgId);
  const drafts: FindingDraft[] = [];

  ruleCoverage(orgId, pack, drafts);
  ruleRevenueVsPlan(orgId, pack, drafts);
  ruleRevenueTrend(orgId, pack, drafts);
  ruleReceivables(orgId, pack, drafts);
  ruleCostAnomaly(orgId, pack, drafts);
  ruleLiquidity(orgId, pack, drafts);
  ruleConcentration(orgId, pack, drafts);
  ruleProductivity(orgId, drafts);
  ruleActionFollowUp(orgId, pack, drafts);
  ruleRecurrence(orgId, drafts);
  ruleConnectorDiscovery(orgId, drafts);

  // Stability: when there is data and nothing significant deviates, say so.
  const significant = drafts.filter(d => d.severity !== 'info' && d.category !== 'coverage');
  if (significant.length === 0 && pack.dataCoverage.txCount > 0) {
    drafts.push({
      fingerprint: 'stable',
      severity: 'info',
      category: 'stability',
      epistemic: 'derived',
      title: 'Verksamheten uppvisar ett stabilt läge',
      description: 'Inga väsentliga avvikelser har identifierats i omsättning, kostnader, kundfordringar eller likviditet utifrån tillgänglig data.',
      confidence: baseConfidence(pack),
      recommended_actions: [],
      evidence: [srcEvidence(orgId), { kind: 'derived', label: 'Kontrollerade områden', value: 'Omsättning mot plan, trend, kostnadskategorier, kundfordringar, likviditet, kundkoncentration, åtgärdsuppföljning', calculation: 'Samtliga regler i analysmotorn utvärderade utan träff' }]
    });
  }

  // Upsert by fingerprint: refresh open findings, create new ones, resolve gone ones.
  const draftFps = new Set(drafts.map(d => d.fingerprint));
  const openRows = all<FindingRow>("SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged')", orgId);
  const newFindings: FindingRow[] = [];

  for (const d of drafts) {
    const existing = openRows.find(r => r.fingerprint === d.fingerprint);
    if (existing) {
      run(
        `UPDATE findings SET severity=?, title=?, description=?, confidence=?, affected_entities_json=?,
           recommended_actions_json=?, expected_effect=?, period_start=?, period_end=?, updated_at=?, run_id=? WHERE id=?`,
        d.severity, d.title, d.description, d.confidence,
        JSON.stringify(d.affected_entities ?? []), JSON.stringify(d.recommended_actions ?? []),
        d.expected_effect ?? null, d.period_start ?? null, d.period_end ?? null, now(), runId, existing.id
      );
      run('DELETE FROM evidence WHERE finding_id = ?', existing.id);
      insertEvidence(orgId, existing.id, d.evidence);
    } else {
      const id = uuid();
      run(
        `INSERT INTO findings (id, org_id, run_id, fingerprint, severity, category, epistemic, title, description, confidence,
           affected_entities_json, recommended_actions_json, expected_effect, period_start, period_end, detected_at, updated_at, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, orgId, runId, d.fingerprint, d.severity, d.category, d.epistemic, d.title, d.description, d.confidence,
        JSON.stringify(d.affected_entities ?? []), JSON.stringify(d.recommended_actions ?? []),
        d.expected_effect ?? null, d.period_start ?? null, d.period_end ?? null, now(), now(), 'open'
      );
      insertEvidence(orgId, id, d.evidence);
      const rowNew = get<FindingRow>('SELECT * FROM findings WHERE id = ?', id)!;
      newFindings.push(rowNew);
    }
  }

  for (const r of openRows) {
    if (!draftFps.has(r.fingerprint)) {
      run("UPDATE findings SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", now(), now(), r.id);
    }
  }

  const active = all<FindingRow>(
    "SELECT * FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, detected_at DESC",
    orgId
  );

  const overallStatus = computeOverallStatus(active);
  const summary = buildSummary(overallStatus, active);

  run('UPDATE analysis_runs SET finished_at=?, status=?, overall_status=?, summary=?, metrics_json=? WHERE id=?',
    now(), 'ok', overallStatus, summary, JSON.stringify(pack), runId);

  // Alerts for genuinely new, attention-worthy findings.
  for (const f of newFindings) {
    dispatchAlertsForFinding(f);
  }

  // Narrative from the reasoning engine (optional, model-agnostic, non-blocking failure).
  if (!opts.skipNarrative) {
    try {
      const narrative = await generateNarrative(orgId, { overallStatus, findings: active, pack });
      if (narrative) {
        run('UPDATE analysis_runs SET narrative=?, narrative_model=? WHERE id=?', narrative.text, narrative.model, runId);
      }
    } catch { /* narrative is enhancement, never a blocker */ }
  }

  return { runId, overallStatus, newFindings, activeFindings: active, summary };
}

function insertEvidence(orgId: string, findingId: string, items: EvidenceItem[]): void {
  for (const e of items) {
    run(
      'INSERT INTO evidence (id, org_id, finding_id, kind, label, value, period, source_label, calculation, data_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
      uuid(), orgId, findingId, e.kind, e.label, e.value ?? null, e.period ?? null,
      e.source_label ?? null, e.calculation ?? null, e.data !== undefined ? JSON.stringify(e.data) : null
    );
  }
}

export function computeOverallStatus(active: FindingRow[]): OverallStatus {
  if (active.some(f => f.severity === 'critical')) return 'critical';
  if (active.some(f => f.severity === 'high')) return 'action_needed';
  if (active.some(f => f.severity === 'medium')) return 'attention';
  return 'stable';
}

function buildSummary(status: OverallStatus, active: FindingRow[]): string {
  const labels: Record<OverallStatus, string> = {
    stable: 'Stabilt läge',
    attention: 'Läget kräver uppmärksamhet',
    action_needed: 'Åtgärder behövs',
    critical: 'Kritiskt läge'
  };
  const top = active.filter(f => f.severity !== 'info').slice(0, 3).map(f => f.title);
  return labels[status] + (top.length ? '. Viktigast: ' + top.join('; ') + '.' : '.');
}

export function latestRun(orgId: string): { id: string; overall_status: OverallStatus | null; summary: string | null; narrative: string | null; narrative_model: string | null; finished_at: string | null } | undefined {
  return get(
    "SELECT id, overall_status, summary, narrative, narrative_model, finished_at FROM analysis_runs WHERE org_id = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 1",
    orgId
  );
}
