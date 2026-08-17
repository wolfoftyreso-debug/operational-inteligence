// Tests for decision intelligence: granular time data → productivity rule
// with causal chain, owner-focused chat intents with reasoning contract
// (missing data, confidence tiers, human review), and connector discovery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.OI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-dec-test-'));
process.env.OI_DB_FILE = path.join(process.env.OI_DATA_DIR, 'test.sqlite');
process.env.OI_REASONING_PROVIDER = 'deterministic';

import { getDb, run, get, all, uuid, now } from '../src/db';
import { hashPassword, randomToken } from '../src/core/crypto';
import { createDataSource, makeContext } from '../src/connectors/registry';
import { ingestCsvContent } from '../src/connectors/csv';
import { computeProductivity } from '../src/analysis/productivity';
import { runAnalysis } from '../src/analysis/engine';
import { classifyIntent, askBusiness, extractAmount, extractPercent, confidenceTier } from '../src/reasoning';
import { createGoal } from '../src/core/hierarchy';
import { detectDataset } from '../src/ingest/normalize';

function makeOrg(): string {
  getDb();
  const orgId = uuid();
  run('INSERT INTO organizations (id, name, industry, rss_token, created_at) VALUES (?,?,?,?,?)',
    orgId, 'DecOrg', 'workshop', randomToken(), now());
  return orgId;
}

function seedTimeEntries(orgId: string, opts: { dip: boolean }): void {
  const src = createDataSource(orgId, 'csv', 'Tid CSV', {});
  const ctx = makeContext(src);
  const lines = ['id;datum;tekniker;enhet;arbetade timmar;debiterade timmar'];
  let id = 1;
  for (let back = 70; back >= 1; back--) {
    const d = new Date(Date.now() - back * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const dateStr = d.toISOString().slice(0, 10);
    for (const [tech, unit] of [['Anna', 'Nord'], ['Bo', 'Nord'], ['Cia', 'Syd'], ['Dan', 'Syd']]) {
      const worked = 8;
      let ratio = 0.8;
      if (opts.dip && back <= 21 && (tech === 'Cia' || tech === 'Dan')) ratio = 0.55;
      lines.push(`${id++};${dateStr};${tech};${unit};${worked};${(worked * ratio).toFixed(1)}`);
    }
  }
  ingestCsvContent(ctx, { filename: 'tid.csv', content: lines.join('\n'), dataset: 'time_entries' });
}

test('time entries dataset detection and normalization', () => {
  const orgId = makeOrg();
  assert.equal(detectDataset(['Datum', 'Tekniker', 'Arbetade timmar', 'Debiterade timmar']), 'time_entries');
  assert.equal(detectDataset(['Arbetsorder', 'Status', 'Öppnad', 'Kund']), 'work_orders');
  seedTimeEntries(orgId, { dip: false });
  const cnt = get<{ c: number }>('SELECT COUNT(*) as c FROM time_entries WHERE org_id = ?', orgId);
  assert.ok(cnt!.c > 150, 'time entries stored at person × day granularity');
});

test('productivity: stable data → no finding; dip → concentrated causal finding', async () => {
  const stableOrg = makeOrg();
  seedTimeEntries(stableOrg, { dip: false });
  const p1 = computeProductivity(stableOrg);
  assert.ok(p1.hasData);
  assert.ok(Math.abs(p1.overall.change ?? 1) < 0.03, 'stable ratio → ~0 change');
  const r1 = await runAnalysis(stableOrg, { skipNarrative: true });
  assert.ok(!r1.activeFindings.some(f => f.fingerprint === 'productivity_decline'));

  const dipOrg = makeOrg();
  seedTimeEntries(dipOrg, { dip: true });
  const p2 = computeProductivity(dipOrg);
  assert.ok((p2.overall.change ?? 0) < -0.08, 'dip must show in overall change');
  assert.ok(p2.overall.hoursNormal, 'worked hours unchanged');
  const sydUnit = p2.byUnit.find(u => u.unit === 'Syd');
  assert.ok(sydUnit && (sydUnit.change ?? 0) < -0.15, 'dip concentrated to Syd');
  const r2 = await runAnalysis(dipOrg, { skipNarrative: true });
  const finding = r2.activeFindings.find(f => f.fingerprint === 'productivity_decline');
  assert.ok(finding, 'productivity finding created');
  assert.ok(finding!.title.includes('Syd'), 'concentration named in title');
  assert.ok(finding!.description.includes('arbetade timmar är normalt') || finding!.description.includes('Antalet arbetade timmar är normalt'), 'causal chain: hours normal');
  const evidence = all<{ label: string }>('SELECT label FROM evidence WHERE finding_id = ?', finding!.id);
  assert.ok(evidence.some(e => /per person/i.test(e.label)), 'drill-down evidence to person level');
});

test('intent classification for owner questions', () => {
  assert.equal(classifyIntent('Har vi råd att köpa en kompressor för 180 000?'), 'affordability');
  assert.equal(classifyIntent('Borde jag ta ut mer lön eller utdelning?'), 'owner_compensation');
  assert.equal(classifyIntent('Har vi råd att anställa en mekaniker?'), 'hiring');
  assert.equal(classifyIntent('Ska vi anställa en mekaniker?'), 'hiring');
  assert.equal(classifyIntent('Vad händer om vi höjer priserna 5 %?'), 'pricing_scenario');
  assert.equal(classifyIntent('Hur mycket måste vi sälja för att nå årets mål?'), 'sales_target');
  assert.equal(extractAmount('köpa en kompressor för 180 000 kr'), 180000);
  assert.equal(extractAmount('en maskin för 1,2 MSEK'), 1200000);
  assert.equal(extractPercent('höjer priserna 5 %'), 0.05);
  assert.equal(confidenceTier(0.9), 'high');
  assert.equal(confidenceTier(0.7), 'moderate');
  assert.equal(confidenceTier(0.4), 'low');
});

test('affordability: adaptive data acquisition when cash position missing', async () => {
  const orgId = makeOrg();
  const r = await askBusiness(orgId, null, 'Har vi råd att köpa en maskin för 200 000 kr?');
  assert.equal(r.intent, 'affordability');
  assert.ok(r.missing_data.length >= 1, 'system asks for missing cash position');
  assert.ok(r.missing_data[0].toLowerCase().includes('kassa'), 'names the missing data');
  assert.equal(r.confidence_tier, 'low');
  assert.ok(r.answer.includes('UNDERLAGET ÄR INTE TILLRÄCKLIGT'));

  // With cash + buffer the verdict becomes computable.
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'cash_position', '800000', now());
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'liquidity_buffer', '300000', now());
  const r2 = await askBusiness(orgId, null, 'Har vi råd att köpa en maskin för 200 000 kr?');
  assert.equal(r2.missing_data.length, 0);
  assert.ok(/BEDÖMNING/.test(r2.answer));
});

test('owner compensation always requires human review', async () => {
  const orgId = makeOrg();
  const r = await askBusiness(orgId, null, 'Borde jag ta ut mer lön eller utdelning?');
  assert.equal(r.intent, 'owner_compensation');
  assert.equal(r.requires_human_review, true);
  assert.ok(r.answer.includes('redovisningskonsult'), 'refers to professional review');
  assert.ok(r.answer.includes('Scenari'), 'presents scenarios');
});

test('hiring: constructive friction when capacity is under-utilized', async () => {
  const orgId = makeOrg();
  seedTimeEntries(orgId, { dip: true });
  const r = await askBusiness(orgId, null, 'Ska vi anställa en mekaniker till?');
  assert.equal(r.intent, 'hiring');
  assert.ok(r.answer.includes('inte fatta det beslutet ännu'), 'system pushes back');
  assert.ok(/utnyttjas till \d+ %/.test(r.answer), 'cites utilization');
});

test('sales target math from active goal', async () => {
  const orgId = makeOrg();
  const y = new Date().getFullYear();
  createGoal(orgId, { label: `Omsättning ${y}`, metric: 'revenue', target_value: 12000000, period: 'yearly', period_start: `${y}-01-01`, period_end: `${y}-12-31` });
  const src = createDataSource(orgId, 'csv', 'CSV', {});
  const ctx = makeContext(src);
  const lines = ['id;datum;beskrivning;belopp;typ'];
  let id = 1;
  const nowD = new Date();
  for (let back = 8; back >= 0; back--) {
    const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 15));
    lines.push(`${id++};${d.toISOString().slice(0, 7)}-15;Intäkt;900000;intäkt`);
  }
  ingestCsvContent(ctx, { filename: 'rev.csv', content: lines.join('\n'), dataset: 'transactions' });
  const r = await askBusiness(orgId, null, 'Hur mycket måste vi sälja för att nå årets mål?');
  assert.equal(r.intent, 'sales_target');
  const facts = (r.evidence as { facts: { target: { required_per_month: number } } }).facts;
  assert.ok(facts.target.required_per_month > 0, 'required monthly pace computed');
});

test('connector discovery: repeated manual imports produce a suggestion', async () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'csv', 'Fredagsrapporten', {});
  const ctx = makeContext(src);
  // Simulate three separate import days by backdating raw_records.
  ingestCsvContent(ctx, { filename: 'r.csv', content: 'id;datum;belopp;typ\n1;2026-01-05;1000;intäkt', dataset: 'transactions' });
  for (let d = 1; d <= 2; d++) {
    run('UPDATE raw_records SET imported_at = ? WHERE org_id = ? AND rowid IN (SELECT rowid FROM raw_records WHERE org_id = ? LIMIT 1 OFFSET ?)',
      new Date(Date.now() - d * 86400000).toISOString(), orgId, orgId, d - 1);
    ingestCsvContent(ctx, { filename: 'r.csv', content: `id;datum;belopp;typ\n${d + 10};2026-01-0${d};1000;intäkt`, dataset: 'transactions' });
  }
  const r = await runAnalysis(orgId, { skipNarrative: true });
  assert.ok(r.activeFindings.some(f => f.fingerprint.startsWith('connector_discovery:')), 'discovery finding created');
});
