// Excel connector — parses .xlsx/.xls via SheetJS, then reuses the same
// mapping/normalization pipeline as CSV.

import * as XLSX from 'xlsx';
import type { Connector, ConnectorContext, SyncResult, ConnectionStatus } from '../types';
import { CANONICAL_DATASETS } from '../types';
import { detectDataset, normalizeRows, type RawRow } from '../../ingest/normalize';

export function ingestExcelContent(ctx: ConnectorContext, payload: { filename: string; contentBase64: string; dataset?: string }): SyncResult {
  const wb = XLSX.read(Buffer.from(payload.contentBase64, 'base64'), { type: 'buffer', cellDates: false });
  const results: SyncResult['datasets'] = [];
  const errors: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: '' });
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]);
    const dataset = payload.dataset && payload.dataset !== 'auto' ? payload.dataset : detectDataset(headers);
    const stats = normalizeRows(ctx.orgId, ctx.sourceId, dataset, rows);
    results.push({ dataset, fetched: stats.fetched, upserted: stats.upserted });
    errors.push(...stats.errors);
  }
  if (results.length === 0) return { ok: false, datasets: [], error: 'Inga datarader hittades i arbetsboken' };
  return { ok: errors.length === 0, datasets: results, error: errors.length ? errors.slice(0, 3).join('; ') : undefined };
}

export const excelConnector: Connector = {
  key: 'excel',
  name: 'Excel-import',
  description: 'Import av Excel-arbetsböcker (.xlsx). Varje blad tolkas och normaliseras automatiskt.',
  authKind: 'file',
  datasets: CANONICAL_DATASETS,
  configFields: [],
  available: () => ({ ok: true }),
  async testConnection(): Promise<ConnectionStatus> {
    return { ok: true, detail: 'Filbaserad källa — ladda upp en fil för att synkronisera.' };
  },
  async sync(): Promise<SyncResult> {
    return { ok: true, datasets: [] };
  }
};
