// Tests for Background Intelligence: opportunity detectors (question-first,
// never verdicts), dismissal learning, and locked-context investigations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.OI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-opp-test-'));
process.env.OI_DB_FILE = path.join(process.env.OI_DATA_DIR, 'test.sqlite');
process.env.OI_REASONING_PROVIDER = 'deterministic';

import { getDb, run, get, all, uuid, now } from '../src/db';
import { randomToken } from '../src/core/crypto';
import { createDataSource, makeContext } from '../src/connectors/registry';
import { ingestCsvContent } from '../src/connectors/csv';
import {
  runOpportunityScan, listOpportunities, dismissOpportunity,
  createInvestigation, investigationWithMessages, concludeInvestigation
} from '../src/analysis/opportunities';
import { askInvestigation } from '../src/reasoning';

function makeOrg(): string {
  getDb();
  const orgId = uuid();
  run('INSERT INTO organizations (id, name, industry, rss_token, created_at) VALUES (?,?,?,?,?)',
    orgId, 'OppOrg', 'workshop', randomToken(), now());
  return orgId;
}

function seedCosts(orgId: string): void {
  const src = createDataSource(orgId, 'csv', 'CSV', {});
  const ctx = makeContext(src);
  const lines = ['id;datum;beskrivning;belopp;typ;kategori'];
  let id = 1;
  const nowD = new Date();
  for (let back = 8; back >= 0; back--) {
    const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 15)).toISOString().slice(0, 7);
    lines.push(`${id++};${d}-10;Intäkter;1000000;intäkt;`);
    lines.push(`${id++};${d}-12;Reservdelar;400000;kostnad;reservdelar`);
    lines.push(`${id++};${d}-14;Löner;300000;kostnad;löner`);
    lines.push(`${id++};${d}-16;Övrigt;100000;kostnad;övrigt`);
  }
  // Large single investment + development costs (tax detectors)
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  lines.push(`${id++};${recent};Ny maskin;600000;kostnad;investeringar`);
  lines.push(`${id++};${recent};Systemutveckling;350000;kostnad;utveckling`);
  ingestCsvContent(ctx, { filename: 'tx.csv', content: lines.join('\n'), dataset: 'transactions' });
}

test('opportunity scan finds purchasing + tax opportunities, question-first', () => {
  const orgId = makeOrg();
  seedCosts(orgId);
  const result = runOpportunityScan(orgId);
  assert.ok(result.created >= 3, 'expected purchasing + investment + rnd opportunities, got ' + result.created);
  const opps = listOpportunities(orgId);
  const purchasing = opps.find(o => o.kind === 'purchasing');
  assert.ok(purchasing, 'purchasing concentration detected');
  assert.ok(purchasing!.caution && /garanti|ledtid/i.test(purchasing!.caution), 'caution lists what to check first');
  const taxInv = opps.find(o => o.fingerprint.startsWith('tax_investment'));
  assert.ok(taxInv, 'large investment raises tax question');
  assert.equal(taxInv!.requires_human_review, 1, 'tax opportunities always require human review');
  assert.ok(/kontrolleras|undersök/i.test(taxInv!.title + taxInv!.rationale), 'phrased as a question to investigate, not a verdict');
  const rnd = opps.find(o => o.fingerprint === 'tax_rnd');
  assert.ok(rnd, 'development costs raise FoU question');
  assert.ok(rnd!.caution!.includes('professionell'), 'FoU flagged for professional review');
});

test('scan is idempotent and dismissal is remembered (user preference)', () => {
  const orgId = makeOrg();
  seedCosts(orgId);
  runOpportunityScan(orgId);
  const before = listOpportunities(orgId).length;
  const again = runOpportunityScan(orgId);
  assert.equal(again.created, 0, 'second scan creates no duplicates');
  assert.equal(listOpportunities(orgId).length, before);

  const target = listOpportunities(orgId)[0];
  assert.ok(dismissOpportunity(orgId, target.id, 'Det där är avsiktligt'));
  runOpportunityScan(orgId);
  const after = listOpportunities(orgId);
  assert.ok(!after.some(o => o.id === target.id), 'dismissed opportunity not re-proposed');
  const stored = get<{ status: string; dismissed_reason: string }>('SELECT status, dismissed_reason FROM opportunities WHERE id = ?', target.id);
  assert.equal(stored!.status, 'dismissed');
  assert.equal(stored!.dismissed_reason, 'Det där är avsiktligt', 'business fact retained, preference recorded');
});

test('investigation: locked context thread with dialog and conclusion', async () => {
  const orgId = makeOrg();
  seedCosts(orgId);
  runOpportunityScan(orgId);
  const opp = listOpportunities(orgId)[0];
  const invId = createInvestigation(orgId, null, {
    title: opp.title, question: opp.rationale, trigger_kind: 'opportunity', trigger_id: opp.id,
    context: { evidence: opp.evidence_json ? JSON.parse(opp.evidence_json) : null }
  });
  const oppAfter = get<{ status: string }>('SELECT status FROM opportunities WHERE id = ?', opp.id);
  assert.equal(oppAfter!.status, 'investigating', 'opportunity moves to investigating');

  const r = await askInvestigation(orgId, invId, null, 'Vad har vi lagt mest pengar på?');
  assert.ok(r.answer.length > 20);
  assert.ok(r.answer.includes(opp.title.slice(0, 20)) || r.answer.includes('undersökningen'), 'answer references the locked context');

  const { messages } = investigationWithMessages(orgId, invId);
  assert.equal(messages.length, 2, 'user + system message stored');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].role, 'system');

  assert.ok(concludeInvestigation(orgId, invId, 'Direktinköp testas på en produktkategori.', 0.7));
  const inv = get<{ status: string; conclusion: string }>('SELECT status, conclusion FROM investigations WHERE id = ?', invId);
  assert.equal(inv!.status, 'concluded');
});

test('tenant isolation: investigations are not readable across orgs', () => {
  const orgA = makeOrg();
  const orgB = makeOrg();
  const invId = createInvestigation(orgA, null, { title: 'Hemlig undersökning' });
  const { investigation } = investigationWithMessages(orgB, invId);
  assert.equal(investigation, undefined, 'cross-tenant read must fail');
});
