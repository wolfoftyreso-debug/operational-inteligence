// CSV connector — file-based. Data arrives via upload (base64/text),
// is auto-mapped from Swedish/English headers and normalized.

import type { Connector, ConnectorContext, SyncResult, ConnectionStatus } from '../types';
import { CANONICAL_DATASETS } from '../types';
import { parseCsv } from '../../ingest/csv';
import { rowsFromTable, detectDataset, normalizeRows } from '../../ingest/normalize';

export interface FilePayload { filename: string; content: string; dataset?: string }

export function ingestCsvContent(ctx: ConnectorContext, payload: FilePayload): SyncResult {
  const table = parseCsv(payload.content);
  if (table.length < 2) return { ok: false, datasets: [], error: 'Filen innehåller inga datarader' };
  const rows = rowsFromTable(table);
  const dataset = payload.dataset && payload.dataset !== 'auto' ? payload.dataset : detectDataset(table[0]);
  const stats = normalizeRows(ctx.orgId, ctx.sourceId, dataset, rows);
  return {
    ok: stats.errors.length === 0,
    datasets: [{ dataset, fetched: stats.fetched, upserted: stats.upserted }],
    error: stats.errors.length ? stats.errors.slice(0, 3).join('; ') : undefined
  };
}

export const csvConnector: Connector = {
  key: 'csv',
  name: 'CSV-import',
  description: 'Generisk import av CSV-filer (transaktioner, fakturor, kunder, personal). Kolumnnamn identifieras automatiskt.',
  authKind: 'file',
  datasets: CANONICAL_DATASETS,
  configFields: [],
  available: () => ({ ok: true }),
  async testConnection(): Promise<ConnectionStatus> {
    return { ok: true, detail: 'Filbaserad källa — ladda upp en fil för att synkronisera.' };
  },
  async sync(): Promise<SyncResult> {
    return { ok: true, datasets: [] }; // data arrives via upload endpoint
  }
};
