// Connector registry — new connectors are added here without touching core.

import type { Connector, ConnectorContext } from './types';
import { csvConnector } from './csv';
import { excelConnector } from './excel';
import { fortnoxConnector } from './fortnox';
import { vismaConnector } from './visma';
import { genericApiConnector } from './generic-api';
import { get, run, all, uuid, now } from '../db';
import { encryptSecret, decryptSecret } from '../core/crypto';

const CONNECTORS: Connector[] = [fortnoxConnector, vismaConnector, csvConnector, excelConnector, genericApiConnector];

export function listConnectors(): Connector[] {
  return CONNECTORS;
}

export function getConnector(key: string): Connector | undefined {
  return CONNECTORS.find(c => c.key === key);
}

export interface DataSourceRow {
  id: string; org_id: string; connector_key: string; name: string; status: string;
  config_encrypted: string | null; last_sync_at: string | null; last_sync_status: string | null;
  last_error: string | null; created_at: string; disconnected_at: string | null;
}

export function createDataSource(orgId: string, connectorKey: string, name: string, cfg: Record<string, unknown>): DataSourceRow {
  const id = uuid();
  run(
    'INSERT INTO data_sources (id, org_id, connector_key, name, status, config_encrypted, created_at) VALUES (?,?,?,?,?,?,?)',
    id, orgId, connectorKey, name, 'configured', encryptSecret(JSON.stringify(cfg)), now()
  );
  return get<DataSourceRow>('SELECT * FROM data_sources WHERE id = ?', id)!;
}

export function getDataSource(orgId: string, id: string): DataSourceRow | undefined {
  return get<DataSourceRow>('SELECT * FROM data_sources WHERE id = ? AND org_id = ?', id, orgId);
}

export function listDataSources(orgId: string): DataSourceRow[] {
  return all<DataSourceRow>('SELECT * FROM data_sources WHERE org_id = ? ORDER BY created_at', orgId);
}

export function readSourceConfig(src: DataSourceRow): Record<string, unknown> {
  if (!src.config_encrypted) return {};
  try { return JSON.parse(decryptSecret(src.config_encrypted)); } catch { return {}; }
}

export function makeContext(src: DataSourceRow): ConnectorContext {
  return {
    orgId: src.org_id,
    sourceId: src.id,
    sourceName: src.name,
    saveConfig(cfg: Record<string, unknown>) {
      run('UPDATE data_sources SET config_encrypted = ? WHERE id = ?', encryptSecret(JSON.stringify(cfg)), src.id);
    }
  };
}

export async function runSync(src: DataSourceRow): Promise<{ ok: boolean; error?: string; stats: unknown }> {
  const connector = getConnector(src.connector_key);
  if (!connector) return { ok: false, error: 'Okänd connector', stats: null };
  const runId = uuid();
  run('INSERT INTO sync_runs (id, org_id, source_id, started_at, status) VALUES (?,?,?,?,?)',
    runId, src.org_id, src.id, now(), 'running');
  const ctx = makeContext(src);
  const cfg = readSourceConfig(src);
  const result = await connector.sync(ctx, cfg);
  run('UPDATE sync_runs SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?',
    now(), result.ok ? 'ok' : 'error', JSON.stringify(result.datasets), result.error ?? null, runId);
  run('UPDATE data_sources SET last_sync_at = ?, last_sync_status = ?, last_error = ?, status = ? WHERE id = ?',
    now(), result.ok ? 'ok' : 'error', result.error ?? null, result.ok ? 'connected' : 'error', src.id);
  return { ok: result.ok, error: result.error, stats: result.datasets };
}

export function disconnectSource(orgId: string, id: string): boolean {
  const src = getDataSource(orgId, id);
  if (!src) return false;
  // Credentials are destroyed immediately on disconnect.
  run("UPDATE data_sources SET status = 'disconnected', config_encrypted = NULL, disconnected_at = ? WHERE id = ?", now(), id);
  return true;
}

/** Remove a source and all data imported from it (customer data deletion). */
export function purgeSource(orgId: string, id: string): boolean {
  const src = getDataSource(orgId, id);
  if (!src) return false;
  run('DELETE FROM transactions WHERE org_id = ? AND source_id = ?', orgId, id);
  run('DELETE FROM invoices WHERE org_id = ? AND source_id = ?', orgId, id);
  run('DELETE FROM raw_records WHERE org_id = ? AND source_id = ?', orgId, id);
  run('DELETE FROM sync_runs WHERE org_id = ? AND source_id = ?', orgId, id);
  run('DELETE FROM data_sources WHERE org_id = ? AND id = ?', orgId, id);
  return true;
}
