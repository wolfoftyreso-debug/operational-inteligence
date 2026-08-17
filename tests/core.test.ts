// Smoke tests for the vertical slice:
// csv parsing → normalization → metrics → analysis → findings/evidence → alerts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.OI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-test-'));
process.env.OI_DB_FILE = path.join(process.env.OI_DATA_DIR, 'test.sqlite');
process.env.OI_REASONING_PROVIDER = 'deterministic';

import { getDb, run, get, all, uuid, now, today } from '../src/db';
import { parseCsv, parseAmount, parseDate } from '../src/ingest/csv';
import { mapHeaders, detectDataset, normalizeRows } from '../src/ingest/normalize';
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from '../src/core/crypto';
import { computeMetrics } from '../src/analysis/metrics';
import { computeLiquidity } from '../src/analysis/liquidity';
import { runAnalysis } from '../src/analysis/engine';
import { createDataSource, makeContext, disconnectSource } from '../src/connectors/registry';
import { ingestCsvContent } from '../src/connectors/csv';
import { randomToken } from '../src/core/crypto';

function makeOrg(): string {
  getDb();
  const orgId = uuid();
  run('INSERT INTO organizations (id, name, industry, rss_token, created_at) VALUES (?,?,?,?,?)',
    orgId, 'TestOrg', 'general', randomToken(), now());
  return orgId;
}

test('csv parser handles quotes, semicolons and Swedish numbers', () => {
  const rows = parseCsv('a;b;c\n1;"x;y";"rad\nbryt"\n2;z;w');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['1', 'x;y', 'rad\nbryt']);
  assert.equal(parseAmount('1 234,56'), 1234.56);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount('1234.56'), 1234.56);
  assert.equal(parseDate('2026-03-05'), '2026-03-05');
  assert.equal(parseDate('05/03/2026'), '2026-03-05');
});

test('header mapping and dataset detection (Swedish headers)', () => {
  const headers = ['Fakturanummer', 'Kund', 'Fakturadatum', 'Förfallodatum', 'Belopp', 'Saldo'];
  const m = mapHeaders(headers);
  assert.equal(m.external_id, 'Fakturanummer');
  assert.equal(m.counterparty, 'Kund');
  assert.equal(m.due_date, 'Förfallodatum');
  assert.equal(detectDataset(headers), 'invoices_customer');
  assert.equal(detectDataset(['Datum', 'Beskrivning', 'Belopp', 'Typ']), 'transactions');
});

test('password hashing and secret encryption', () => {
  const h = hashPassword('hemligt123');
  assert.ok(verifyPassword('hemligt123', h));
  assert.ok(!verifyPassword('fel', h));
  const enc = encryptSecret('{"token":"abc"}');
  assert.ok(!enc.includes('abc'));
  assert.equal(decryptSecret(enc), '{"token":"abc"}');
});

test('normalization upserts are idempotent', () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'csv', 'Test CSV', {});
  const csv = 'id;datum;beskrivning;belopp;typ\n1;2026-01-10;Jobb A;10000;intäkt\n2;2026-01-12;Delar;4000;kostnad';
  const ctx = makeContext(src);
  ingestCsvContent(ctx, { filename: 't.csv', content: csv, dataset: 'transactions' });
  ingestCsvContent(ctx, { filename: 't.csv', content: csv, dataset: 'transactions' });
  const cnt = get<{ c: number }>('SELECT COUNT(*) as c FROM transactions WHERE org_id = ?', orgId);
  assert.equal(cnt!.c, 2, 'duplicate import must not duplicate rows');
});

test('metrics computes revenue/costs and receivables deterministically', () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'csv', 'Test CSV', {});
  const ctx = makeContext(src);
  const thisMonth = today().slice(0, 7);
  const tx = ['id;datum;beskrivning;belopp;typ',
    `10;${thisMonth}-05;Jobb;50000;intäkt`,
    `11;${thisMonth}-07;Delar;20000;kostnad`].join('\n');
  ingestCsvContent(ctx, { filename: 'tx.csv', content: tx, dataset: 'transactions' });
  const overdueDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const inv = ['fakturanummer;kund;fakturadatum;förfallodatum;belopp;saldo;status',
    `100;Kund AB;2026-01-01;${overdueDate};30000;30000;öppen`].join('\n');
  ingestCsvContent(ctx, { filename: 'inv.csv', content: inv, dataset: 'invoices_customer' });

  const pack = computeMetrics(orgId);
  const last = pack.revenueByMonth[pack.revenueByMonth.length - 1];
  assert.equal(last.value, 50000);
  assert.equal(pack.receivables.openTotal, 30000);
  assert.equal(pack.receivables.overdueTotal, 30000);
});

test('liquidity forecast uses manual cash position and flags risk', () => {
  const orgId = makeOrg();
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'cash_position', '100000', now());
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'liquidity_buffer', '300000', now());
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'monthly_fixed_costs', '50000', now());
  const fc = computeLiquidity(orgId);
  assert.equal(fc.startBalance, 100000);
  assert.ok(fc.weeks.length === 13);
  assert.ok(['medium', 'high', 'critical'].includes(fc.riskLevel), 'below buffer should not be low risk');
  assert.ok(fc.startBalanceSource.includes('anuell'), 'manual source must be labeled');
});

test('full vertical slice: analysis produces findings with evidence and alerts', async () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'csv', 'Ekonomi CSV', {});
  const ctx = makeContext(src);
  run('INSERT INTO business_profile (org_id, key, value, updated_at) VALUES (?,?,?,?)', orgId, 'monthly_revenue_target', '1000000', now());
  run('INSERT INTO users (id, org_id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    uuid(), orgId, 'slice@test.se', 'Slice', 'executive', hashPassword('x'.repeat(8)), now());

  // 8 months history at ~1M, last complete month collapses to 600k → revenue findings
  const lines = ['id;datum;beskrivning;belopp;typ'];
  let id = 1;
  const nowD = new Date();
  for (let back = 8; back >= 0; back--) {
    const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 15));
    const label = d.toISOString().slice(0, 7);
    const amount = back === 1 ? 600000 : 1000000;
    lines.push(`${id++};${label}-15;Månadsintäkt;${amount};intäkt`);
  }
  ingestCsvContent(ctx, { filename: 'rev.csv', content: lines.join('\n'), dataset: 'transactions' });

  const result = await runAnalysis(orgId, { skipNarrative: true });
  assert.ok(result.activeFindings.length > 0, 'analysis must produce findings');
  const revFinding = result.activeFindings.find(f => f.category === 'revenue');
  assert.ok(revFinding, 'revenue deviation must be detected');
  assert.ok(revFinding!.severity === 'high' || revFinding!.severity === 'medium');

  const evidence = all('SELECT * FROM evidence WHERE finding_id = ?', revFinding!.id);
  assert.ok(evidence.length >= 2, 'finding must carry an evidence chain');

  // Alert created for high-severity finding (revenue 40% below plan → high)
  if (revFinding!.severity === 'high') {
    const alerts = all('SELECT * FROM alerts WHERE org_id = ?', orgId);
    assert.ok(alerts.length > 0, 'high severity finding must raise an alert');
  }

  // Re-run: same fingerprint should update, not duplicate
  const again = await runAnalysis(orgId, { skipNarrative: true });
  const openRev = all('SELECT * FROM findings WHERE org_id = ? AND category = ? AND status IN (?,?)', orgId, 'revenue', 'open', 'acknowledged');
  const fps = new Set(openRev.map((f: { fingerprint?: unknown }) => String(f.fingerprint)));
  assert.equal(fps.size, openRev.length, 'no duplicate open findings per fingerprint');
  assert.equal(again.newFindings.length, 0, 'second run must not re-create findings');
});

test('stability finding appears when nothing deviates', async () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'csv', 'Stabil CSV', {});
  const ctx = makeContext(src);
  const lines = ['id;datum;beskrivning;belopp;typ'];
  let id = 1;
  const nowD = new Date();
  for (let back = 8; back >= 0; back--) {
    const d = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 15));
    lines.push(`${id++};${d.toISOString().slice(0, 7)}-15;Månadsintäkt;1000000;intäkt`);
  }
  ingestCsvContent(ctx, { filename: 'rev.csv', content: lines.join('\n'), dataset: 'transactions' });
  const result = await runAnalysis(orgId, { skipNarrative: true });
  assert.ok(result.activeFindings.some(f => f.category === 'stability'), 'stable state must be stated explicitly');
  assert.equal(result.overallStatus, 'stable');
});

test('disconnecting a source destroys credentials but keeps data', () => {
  const orgId = makeOrg();
  const src = createDataSource(orgId, 'generic-api', 'API', { auth_token: 'secret-token' });
  assert.ok(get<{ config_encrypted: string }>('SELECT config_encrypted FROM data_sources WHERE id = ?', src.id)!.config_encrypted);
  disconnectSource(orgId, src.id);
  const after = get<{ config_encrypted: string | null; status: string }>('SELECT config_encrypted, status FROM data_sources WHERE id = ?', src.id)!;
  assert.equal(after.config_encrypted, null);
  assert.equal(after.status, 'disconnected');
});
