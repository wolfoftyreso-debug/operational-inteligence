// Tests for the structural backbone: settings inheritance, sensitivity
// wiring, org hierarchy/scopes, goals with inheritance, document ingestion
// with review flow, and the intent-routed chat pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.OI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-gov-test-'));
process.env.OI_DB_FILE = path.join(process.env.OI_DATA_DIR, 'test.sqlite');
process.env.OI_REASONING_PROVIDER = 'deterministic';

import { getDb, run, get, all, uuid, now } from '../src/db';
import { hashPassword, randomToken } from '../src/core/crypto';
import { getSetting, setSetting, sensitivityMultiplier, applyPreset, resolveAll } from '../src/core/settings';
import { createUnit, scopeUnitIds, createGoal, breakdownGoal, goalTargetForMonth, managementContext } from '../src/core/hierarchy';
import { heuristicExtract, ingestDocument, approveItem, rejectItem } from '../src/ingest/documents';
import { classifyIntent, askBusiness } from '../src/reasoning';
import { createDataSource, makeContext } from '../src/connectors/registry';
import { ingestCsvContent } from '../src/connectors/csv';
import { runAnalysis } from '../src/analysis/engine';

function makeOrg(): string {
  getDb();
  const orgId = uuid();
  run('INSERT INTO organizations (id, name, industry, rss_token, created_at) VALUES (?,?,?,?,?)',
    orgId, 'GovOrg', 'general', randomToken(), now());
  return orgId;
}

function makeUser(orgId: string, unitId: string | null = null): string {
  const id = uuid();
  run('INSERT INTO users (id, org_id, email, name, role, password_hash, created_at, unit_id) VALUES (?,?,?,?,?,?,?,?)',
    id, orgId, `u${id.slice(0, 8)}@t.se`, 'Testare', 'executive', hashPassword('x'.repeat(8)), now(), unitId);
  return id;
}

test('settings: default → org → user resolution with audit-able writes', () => {
  const orgId = makeOrg();
  const userId = makeUser(orgId);
  assert.equal(getSetting(orgId, 'intelligence.sensitivity'), 'balanced'); // default
  setSetting(orgId, 'intelligence.sensitivity', 'conservative', 'org', '', null);
  assert.equal(getSetting(orgId, 'intelligence.sensitivity'), 'conservative'); // org
  setSetting(orgId, 'intelligence.sensitivity', 'sensitive', 'user', userId, userId);
  assert.equal(getSetting(orgId, 'intelligence.sensitivity', userId), 'sensitive'); // user override
  assert.equal(getSetting(orgId, 'intelligence.sensitivity'), 'conservative'); // org unchanged
  const resolved = resolveAll(orgId, userId);
  assert.equal(resolved['intelligence.sensitivity'].source, 'user');
  assert.equal(resolved['reports.mode'].source, 'default');
});

test('sensitivity setting changes analysis thresholds', async () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'csv', 'CSV', {});
  const ctx = makeContext(src);
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'monthly_revenue_target', '1000000', now());
  // 8 months at 1M, last complete month at 920k → -8% deviation
  const lines = ['id;datum;beskrivning;belopp;typ'];
  let id = 1;
  const nowD = new Date();
  for (let back = 8; back >= 0; back--) {
    const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 15));
    lines.push(`${id++};${d.toISOString().slice(0, 7)}-15;Intäkt;${back === 1 ? 920000 : 1000000};intäkt`);
  }
  ingestCsvContent(ctx, { filename: 'r.csv', content: lines.join('\n'), dataset: 'transactions' });

  // Conservative (×1.5 → floor 7.5%... -8% triggers) vs suppress policy at 10%
  setSetting(orgId, 'intelligence.sensitivity', 'conservative', 'org', '', null);
  let r = await runAnalysis(orgId, { skipNarrative: true });
  const hasRev = (rr: typeof r) => rr.activeFindings.some(f => f.fingerprint === 'revenue_below_plan');
  assert.ok(hasRev(r), '-8% should trigger at conservative floor 7.5%');

  // Suppression policy: ignore variations under 10 %
  setSetting(orgId, 'notifications.suppress_below_pct', '10', 'org', '', null);
  r = await runAnalysis(orgId, { skipNarrative: true });
  assert.ok(!hasRev(r), 'suppress_below_pct=10 must silence a -8% deviation');
  assert.equal(sensitivityMultiplier(orgId), 1.5);
});

test('presets apply setting bundles at org level', () => {
  const orgId = makeOrg();
  assert.ok(applyPreset(orgId, 'operational', null));
  assert.equal(getSetting(orgId, 'intelligence.sensitivity'), 'sensitive');
  assert.equal(getSetting(orgId, 'reports.mode'), 'always');
  assert.ok(!applyPreset(orgId, 'nonexistent', null));
});

test('unit hierarchy and scope resolution', () => {
  const orgId = makeOrg();
  const company = createUnit(orgId, 'Bolag', 'company', null);
  const fac = createUnit(orgId, 'Anläggning 1', 'facility', company);
  const team = createUnit(orgId, 'Team A', 'team', fac);
  createUnit(orgId, 'Anläggning 2', 'facility', company);
  const scope = scopeUnitIds(orgId, fac)!;
  assert.ok(scope.includes(fac) && scope.includes(team));
  assert.equal(scope.length, 2, 'facility scope = facility + its team, not sibling');
  assert.equal(scopeUnitIds(orgId, null), null, 'null unit = whole org');
  const userId = makeUser(orgId, fac);
  const mc = managementContext(orgId, userId) as { scope: { unit: string } };
  assert.equal(mc.scope.unit, 'Anläggning 1');
});

test('goal breakdown and month lookup (goal inheritance)', () => {
  const orgId = makeOrg();
  const y = new Date().getFullYear();
  const gid = createGoal(orgId, {
    label: `Omsättning ${y}`, metric: 'revenue', target_value: 12000000,
    period: 'yearly', period_start: `${y}-01-01`, period_end: `${y}-12-31`
  });
  const created = breakdownGoal(orgId, gid);
  assert.equal(created, 12);
  assert.equal(breakdownGoal(orgId, gid), 0, 'breakdown is idempotent');
  const t = goalTargetForMonth(orgId, 'revenue', `${y}-06`);
  assert.ok(t, 'monthly goal must be found');
  assert.equal(t!.target, 1000000);
  assert.equal(t!.goal.period, 'monthly', 'monthly child goal preferred over yearly parent');
});

test('document ingestion: heuristic extraction + review flow materializes goals/risks', async () => {
  const orgId = makeOrg();
  const userId = makeUser(orgId);
  const y = new Date().getFullYear();
  const text = [
    `Omsättningen ska öka till 24 MSEK under ${y}.`,
    'Risk: Kompetensbrist riskerar att begränsa kapaciteten.',
    'Ledningen beslutade att införa veckovis likviditetsuppföljning.',
    'Åtgärd: Rekrytera två tekniker. Ansvarig: Anna Chef.'
  ].join('\n');

  const items = heuristicExtract(text);
  assert.ok(items.some(i => i.kind === 'goal'), 'goal extracted');
  assert.ok(items.some(i => i.kind === 'risk'), 'risk extracted');
  assert.ok(items.some(i => i.kind === 'decision'), 'decision extracted');
  assert.ok(items.some(i => i.kind === 'action'), 'action extracted');
  const goal = items.find(i => i.kind === 'goal')!;
  assert.equal(goal.payload.target_value, 24000000, 'MSEK parsed to kr');

  const result = await ingestDocument(orgId, userId, { filename: 'plan.txt', kind: 'verksamhetsplan', content: text });
  assert.ok(result.counts.goal >= 1);
  const proposed = all<{ id: string; kind: string }>('SELECT id, kind FROM document_items WHERE document_id = ?', result.documentId);
  // Nothing materializes before approval.
  assert.equal(get<{ c: number }>("SELECT COUNT(*) as c FROM goals WHERE org_id = ? AND source='document'", orgId)!.c, 0);
  const goalItem = proposed.find(i => i.kind === 'goal')!;
  const riskItem = proposed.find(i => i.kind === 'risk')!;
  assert.ok(approveItem(orgId, goalItem.id, userId));
  assert.ok(approveItem(orgId, riskItem.id, userId));
  const actionItem = proposed.find(i => i.kind === 'action');
  if (actionItem) assert.ok(rejectItem(orgId, actionItem.id, userId));
  assert.equal(get<{ c: number }>("SELECT COUNT(*) as c FROM goals WHERE org_id = ? AND source='document'", orgId)!.c, 1);
  assert.equal(get<{ c: number }>('SELECT COUNT(*) as c FROM risks WHERE org_id = ?', orgId)!.c, 1);
  assert.ok(approveItem(orgId, goalItem.id, userId) === null, 'double-approve rejected');
});

test('chat pipeline: intent classification and evidence-backed answers', async () => {
  const orgId = makeOrg();
  const userId = makeUser(orgId);
  assert.equal(classifyIntent('Har vi fått betalt för allt vi köpte in förra månaden?'), 'payments_reconciliation');
  assert.equal(classifyIntent('Hur ser likviditeten ut?'), 'liquidity');
  assert.equal(classifyIntent('Ligger vi efter mot målen?'), 'goals');
  assert.equal(classifyIntent('Vad har vi lagt mest pengar på?'), 'costs');

  const src = createDataSource(orgId, 'csv', 'CSV', {});
  const ctx = makeContext(src);
  const past = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const overdue = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const inv = ['fakturanummer;leverantör;fakturadatum;förfallodatum;belopp;saldo;status',
    `1;Leverantör A;${past};${overdue};18900;18900;öppen`,
    `2;Leverantör B;${past};${past};12500;0;betald`].join('\n');
  ingestCsvContent(ctx, { filename: 'sup.csv', content: inv, dataset: 'invoices_supplier' });

  const r = await askBusiness(orgId, userId, 'Har vi betalat allt vi köpte in?');
  assert.equal(r.intent, 'payments_reconciliation');
  assert.ok(r.answer.includes('leverantörsfakturor'), 'answer addresses supplier invoices');
  const normalized = r.answer.replace(/[  ]/g, ' ');
  assert.ok(normalized.includes('18 900'), 'outstanding amount from deterministic calc present');
  const ev = r.evidence as { facts: { overdue: number } };
  assert.equal(ev.facts.overdue, 1, 'evidence package carries structured facts');
});
