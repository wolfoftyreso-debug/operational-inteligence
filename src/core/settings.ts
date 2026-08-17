// Control Center — "Opinionated Defaults, Deep Control".
// Every setting has a system default, an explanation of its consequence,
// and named options instead of opaque sliders. Resolution: user → org → default.
// All changes are audited by the API layer.

import { all, get, run, now } from '../db';

export interface SettingOption { value: string; label: string; description: string }
export interface SettingDef {
  key: string;
  category: 'general' | 'intelligence' | 'guidance' | 'reports' | 'tone' | 'notifications' | 'constitution';
  label: string;
  description: string;
  type: 'select' | 'number' | 'text';
  default: string;
  options?: SettingOption[];
  advanced?: boolean; // hidden in SIMPLE mode
}

export const SETTINGS_CATALOG: SettingDef[] = [
  // --- General ---
  { key: 'general.language', category: 'general', label: 'Språk', description: 'Systemets språk i rapporter och bedömningar.', type: 'select', default: 'sv', options: [
    { value: 'sv', label: 'Svenska', description: 'Alla bedömningar och rapporter på svenska.' },
    { value: 'en', label: 'English', description: 'Assessments and reports in English.' }] },
  { key: 'general.currency', category: 'general', label: 'Valuta', description: 'Redovisningsvaluta.', type: 'text', default: 'SEK' },
  { key: 'general.fiscal_year_start', category: 'general', label: 'Räkenskapsårets start (månad)', description: 'Styr års- och kvartalsperioder.', type: 'number', default: '1', advanced: true },

  // --- Intelligence ---
  { key: 'intelligence.sensitivity', category: 'intelligence', label: 'Analyskänslighet', description: 'Hur tidigt systemet rapporterar avvikelser.', type: 'select', default: 'balanced', options: [
    { value: 'conservative', label: 'Conservative', description: 'Systemet rapporterar endast starkare signaler.' },
    { value: 'balanced', label: 'Balanced', description: 'Systemet rapporterar statistiskt och verksamhetsmässigt betydande förändringar.' },
    { value: 'sensitive', label: 'More sensitive', description: 'Systemet rapporterar mindre avvikelser tidigare.' }] },
  { key: 'intelligence.min_confidence', category: 'intelligence', label: 'Lägsta confidence som visas', description: 'Findings under denna nivå döljs i huvudvyn (sparas ändå).', type: 'select', default: '0.5', advanced: true, options: [
    { value: '0.3', label: '30 %', description: 'Visa även mycket osäkra observationer.' },
    { value: '0.5', label: '50 %', description: 'Standard — dölj svagt underbyggda observationer.' },
    { value: '0.75', label: '75 %', description: 'Visa endast väl underbyggda observationer.' }] },
  { key: 'intelligence.forecast_horizon_weeks', category: 'intelligence', label: 'Prognoshorisont (veckor)', description: 'Hur långt likviditetsprognosen sträcker sig.', type: 'number', default: '13', advanced: true },
  { key: 'intelligence.history_months', category: 'intelligence', label: 'Historikfönster (månader)', description: 'Hur mycket historik trend- och avvikelseanalys använder.', type: 'number', default: '13', advanced: true },

  // --- Guidance ---
  { key: 'guidance.proactivity', category: 'guidance', label: 'Proaktivitet', description: 'Hur aktivt systemet rekommenderar åtgärder.', type: 'select', default: 'recommend', options: [
    { value: 'observe', label: 'Observe', description: 'Systemet beskriver läget men föreslår inte åtgärder.' },
    { value: 'recommend', label: 'Recommend', description: 'Systemet rekommenderar åtgärder vid väsentliga avvikelser.' },
    { value: 'drive', label: 'Drive', description: 'Systemet rekommenderar åtgärder och följer aktivt upp att de hanteras.' }] },
  { key: 'guidance.allow_challenge', category: 'guidance', label: 'Får ifrågasätta beslut', description: 'Om systemet får påpeka när data talar emot ett fattat beslut.', type: 'select', default: 'yes', advanced: true, options: [
    { value: 'yes', label: 'Ja', description: 'Systemet flaggar när utfall avviker från beslutets antaganden.' },
    { value: 'no', label: 'Nej', description: 'Systemet redovisar utfall utan att ifrågasätta beslut.' }] },

  // --- Reports ---
  { key: 'reports.mode', category: 'reports', label: 'Rapportläge', description: 'När schemalagda rapporter faktiskt skickas.', type: 'select', default: 'changes_only', options: [
    { value: 'always', label: 'Always', description: 'Skicka rapport varje gång enligt schema.' },
    { value: 'changes_only', label: 'Changes only', description: 'Skicka bara när något relevant förändrats.' },
    { value: 'exception_only', label: 'Exception only', description: 'Skicka bara vid avvikelse.' }] },
  { key: 'reports.detail', category: 'reports', label: 'Detaljeringsnivå', description: 'Hur omfattande rapporterna är.', type: 'select', default: 'executive', options: [
    { value: 'executive', label: 'Executive', description: 'Kort. Viktigast först.' },
    { value: 'standard', label: 'Standard', description: 'Läge, observationer, nyckeltal och memory.' },
    { value: 'detailed', label: 'Detailed', description: 'Fullt underlag med evidens och appendix.' }] },

  // --- Tone ---
  { key: 'tone.style', category: 'tone', label: 'Ton', description: 'Hur systemet formulerar bedömningar.', type: 'select', default: 'executive', options: [
    { value: 'neutral', label: 'Neutral', description: 'Saklig och avskalad.' },
    { value: 'executive', label: 'Executive', description: 'Kort, direkt, viktigast först.' },
    { value: 'analytical', label: 'Analytical', description: 'Mer resonerande med orsakssamband.' },
    { value: 'direct', label: 'Direct', description: 'Rakt på sak, inga omskrivningar.' },
    { value: 'formal', label: 'Formal', description: 'Formell rapportprosa.' }] },
  { key: 'tone.custom', category: 'tone', label: 'Anpassad ton', description: 'Egen beskrivning av hur rapporter ska låta (kompletterar vald ton).', type: 'text', default: '', advanced: true },

  // --- Notifications / policy ---
  { key: 'notifications.suppress_below_pct', category: 'notifications', label: 'Ignorera variationer under (%)', description: 'Avvikelser mindre än detta rapporteras inte. Policy, inte bara UI.', type: 'number', default: '3', advanced: true },
  { key: 'notifications.quiet_categories', category: 'notifications', label: 'Tysta kategorier', description: 'Kommaseparerade finding-kategorier som aldrig genererar alerts (t.ex. concentration,memory).', type: 'text', default: '', advanced: true },

  // --- System Constitution ---
  { key: 'constitution.primary_objective', category: 'constitution', label: 'Primary objective', description: 'Organisationens överordnade mål som styr systemets prioriteringar.', type: 'text', default: 'Skydda kassaflödet och upprätthåll leveranskvaliteten.' },
  { key: 'constitution.risk_tolerance', category: 'constitution', label: 'Risk tolerance', description: 'Riskaptit som styr hur tidigt risker eskaleras.', type: 'select', default: 'conservative', options: [
    { value: 'conservative', label: 'Conservative', description: 'Eskalera risker tidigt.' },
    { value: 'moderate', label: 'Moderate', description: 'Balanserad riskhantering.' },
    { value: 'aggressive', label: 'Aggressive', description: 'Acceptera större variation innan eskalering.' }] },
  { key: 'constitution.management_style', category: 'constitution', label: 'Management style', description: 'Hur systemet talar med ledningen.', type: 'text', default: 'Direkt och evidensbaserad.' },
  { key: 'constitution.alert_philosophy', category: 'constitution', label: 'Alert philosophy', description: 'Hur notifieringar ska avvägas.', type: 'text', default: 'Varna tidigt, men undvik brus.' },
  { key: 'constitution.reporting_philosophy', category: 'constitution', label: 'Reporting philosophy', description: 'Hur rapporter ska utformas.', type: 'text', default: 'Kort executive summary med expanderbar evidens.' }
];

const DEFAULTS = new Map(SETTINGS_CATALOG.map(s => [s.key, s.default]));

export function getSetting(orgId: string, key: string, userId?: string): string {
  if (userId) {
    const u = get<{ value: string | null }>(
      "SELECT value FROM settings WHERE org_id=? AND scope='user' AND scope_id=? AND key=?", orgId, userId, key);
    if (u && u.value !== null) return u.value;
  }
  const o = get<{ value: string | null }>(
    "SELECT value FROM settings WHERE org_id=? AND scope='org' AND scope_id='' AND key=?", orgId, key);
  if (o && o.value !== null) return o.value;
  return DEFAULTS.get(key) ?? '';
}

export function getSettingNumber(orgId: string, key: string, userId?: string): number {
  const v = Number(getSetting(orgId, key, userId));
  return Number.isFinite(v) ? v : Number(DEFAULTS.get(key) ?? 0);
}

export function setSetting(orgId: string, key: string, value: string, scope: 'org' | 'user', scopeId: string, updatedBy: string | null): void {
  run(`INSERT INTO settings (org_id, scope, scope_id, key, value, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (org_id, scope, scope_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    orgId, scope, scope === 'user' ? scopeId : '', key, value, now(), updatedBy);
}

export function resolveAll(orgId: string, userId?: string): Record<string, { value: string; source: 'user' | 'org' | 'default' }> {
  const orgRows = new Map(all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE org_id=? AND scope='org' AND scope_id=''", orgId).map(r => [r.key, r.value]));
  const userRows = userId ? new Map(all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE org_id=? AND scope='user' AND scope_id=?", orgId, userId).map(r => [r.key, r.value])) : new Map<string, string>();
  const out: Record<string, { value: string; source: 'user' | 'org' | 'default' }> = {};
  for (const def of SETTINGS_CATALOG) {
    if (userRows.has(def.key)) out[def.key] = { value: userRows.get(def.key)!, source: 'user' };
    else if (orgRows.has(def.key)) out[def.key] = { value: orgRows.get(def.key)!, source: 'org' };
    else out[def.key] = { value: def.default, source: 'default' };
  }
  return out;
}

/** Sensitivity multiplier applied to analysis rule thresholds.
 *  <1 = triggers earlier (sensitive), >1 = only stronger signals. */
export function sensitivityMultiplier(orgId: string): number {
  const s = getSetting(orgId, 'intelligence.sensitivity');
  return s === 'sensitive' ? 0.6 : s === 'conservative' ? 1.5 : 1.0;
}

export function suppressBelowFraction(orgId: string): number {
  return Math.max(0, getSettingNumber(orgId, 'notifications.suppress_below_pct') / 100);
}

export function quietCategories(orgId: string): Set<string> {
  return new Set(getSetting(orgId, 'notifications.quiet_categories').split(',').map(s => s.trim()).filter(Boolean));
}

export function constitution(orgId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of SETTINGS_CATALOG) {
    if (def.category === 'constitution') out[def.key.split('.')[1]] = getSetting(orgId, def.key);
  }
  return out;
}

// --- Presets: opinionated bundles, applied at org level ---

export const PRESETS: { key: string; label: string; description: string; values: Record<string, string> }[] = [
  { key: 'recommended', label: 'Recommended', description: 'Balanserad standard för de flesta verksamheter.', values: {
    'intelligence.sensitivity': 'balanced', 'guidance.proactivity': 'recommend', 'reports.mode': 'changes_only', 'reports.detail': 'executive', 'tone.style': 'executive' } },
  { key: 'executive', label: 'Executive', description: 'Kort. Viktigast först. Färre men skarpare signaler.', values: {
    'intelligence.sensitivity': 'conservative', 'guidance.proactivity': 'recommend', 'reports.mode': 'exception_only', 'reports.detail': 'executive', 'tone.style': 'executive' } },
  { key: 'operational', label: 'Operational', description: 'Mer detaljer och fler avvikelser, tidigare.', values: {
    'intelligence.sensitivity': 'sensitive', 'guidance.proactivity': 'drive', 'reports.mode': 'always', 'reports.detail': 'detailed', 'tone.style': 'analytical' } },
  { key: 'financial', label: 'Financial', description: 'Fokus på ekonomi, likviditet och prognoser.', values: {
    'intelligence.sensitivity': 'balanced', 'guidance.proactivity': 'recommend', 'reports.mode': 'changes_only', 'reports.detail': 'standard', 'tone.style': 'analytical' } },
  { key: 'full', label: 'Full Intelligence', description: 'Allt. Maximal känslighet och detaljeringsgrad.', values: {
    'intelligence.sensitivity': 'sensitive', 'intelligence.min_confidence': '0.3', 'guidance.proactivity': 'drive', 'reports.mode': 'always', 'reports.detail': 'detailed', 'tone.style': 'detailed' } }
];

export function applyPreset(orgId: string, presetKey: string, updatedBy: string | null): boolean {
  const preset = PRESETS.find(p => p.key === presetKey);
  if (!preset) return false;
  for (const [k, v] of Object.entries(preset.values)) setSetting(orgId, k, v, 'org', '', updatedBy);
  return true;
}
