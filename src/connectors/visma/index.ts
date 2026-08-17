// Visma eAccounting connector — OAuth2 skeleton with the same contract as
// Fortnox. Activates when VISMA_CLIENT_ID/SECRET are configured.

import type { Connector, ConnectorContext, SyncResult, ConnectionStatus } from '../types';
import { config } from '../../config';
import { normalizeRows, type RawRow } from '../../ingest/normalize';

const API_BASE = 'https://eaccountingapi.vismaonline.com/v2';

async function apiGet(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Visma API ${path}: ${res.status} ${await res.text()}`);
  return await res.json() as Record<string, unknown>;
}

export const vismaConnector: Connector = {
  key: 'visma',
  name: 'Visma eAccounting',
  description: 'Hämtar kundfakturor och leverantörsfakturor från Visma eAccounting via OAuth2.',
  authKind: 'oauth2',
  datasets: [
    { key: 'invoices_customer', label: 'Kundfakturor' },
    { key: 'invoices_supplier', label: 'Leverantörsfakturor' }
  ],
  configFields: [],
  available: () => {
    const c = config.connectors.visma;
    if (!c.clientId || !c.clientSecret) {
      return { ok: false, reason: 'VISMA_CLIENT_ID/VISMA_CLIENT_SECRET saknas i servermiljön. Connectorn aktiveras när API-uppgifter finns.' };
    }
    return { ok: true };
  },
  async testConnection(_ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<ConnectionStatus> {
    try {
      if (!cfg.access_token) return { ok: false, detail: 'Ingen OAuth-anslutning etablerad ännu.' };
      await apiGet(String(cfg.access_token), '/companysettings');
      return { ok: true, detail: 'Ansluten till Visma eAccounting' };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  },
  async sync(ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<SyncResult> {
    try {
      if (!cfg.access_token) return { ok: false, datasets: [], error: 'Ingen OAuth-anslutning etablerad ännu.' };
      const token = String(cfg.access_token);
      const datasets: SyncResult['datasets'] = [];
      const inv = await apiGet(token, '/customerinvoices?$top=500');
      const rows: RawRow[] = ((inv.Data as RawRow[]) || []).map(i => ({
        'fakturanummer': i.InvoiceNumber, 'kund': i.InvoiceCustomerName ?? i.CustomerName,
        'fakturadatum': i.InvoiceDate, 'förfallodatum': i.DueDate,
        'belopp': i.TotalAmount, 'saldo': i.RemainingAmount, 'valuta': i.CurrencyCode
      }));
      const s = normalizeRows(ctx.orgId, ctx.sourceId, 'invoices_customer', rows);
      datasets.push({ dataset: 'invoices_customer', fetched: s.fetched, upserted: s.upserted });
      return { ok: true, datasets };
    } catch (e) {
      return { ok: false, datasets: [], error: String(e) };
    }
  }
};
