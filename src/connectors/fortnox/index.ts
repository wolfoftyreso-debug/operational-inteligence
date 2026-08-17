// Fortnox connector — real OAuth2 (authorization code) + REST sync.
// Requires FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET in the environment.
// Tokens are stored encrypted; nothing secret ever reaches the frontend.

import type { Connector, ConnectorContext, SyncResult, ConnectionStatus } from '../types';
import { config } from '../../config';
import { normalizeRows, type RawRow } from '../../ingest/normalize';

const AUTH_BASE = 'https://apps.fortnox.se/oauth-v1';
const API_BASE = 'https://api.fortnox.se/3';

export function fortnoxAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: config.connectors.fortnox.clientId,
    redirect_uri: `${config.baseUrl}/connect/fortnox/callback`,
    scope: config.connectors.fortnox.scopes,
    state,
    access_type: 'offline',
    response_type: 'code'
  });
  return `${AUTH_BASE}/auth?${p.toString()}`;
}

export async function fortnoxExchangeCode(code: string): Promise<{ access_token: string; refresh_token: string; expires_at: number }> {
  const basic = Buffer.from(`${config.connectors.fortnox.clientId}:${config.connectors.fortnox.clientSecret}`).toString('base64');
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.baseUrl}/connect/fortnox/callback`
    })
  });
  if (!res.ok) throw new Error(`Fortnox token exchange failed: ${res.status} ${await res.text()}`);
  const j = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
}

async function refreshToken(cfg: Record<string, unknown>, ctx: ConnectorContext): Promise<string> {
  const expiresAt = Number(cfg.expires_at || 0);
  if (cfg.access_token && Date.now() < expiresAt) return String(cfg.access_token);
  const basic = Buffer.from(`${config.connectors.fortnox.clientId}:${config.connectors.fortnox.clientSecret}`).toString('base64');
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(cfg.refresh_token || '') })
  });
  if (!res.ok) throw new Error(`Fortnox token refresh failed: ${res.status}`);
  const j = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  cfg.access_token = j.access_token;
  cfg.refresh_token = j.refresh_token;
  cfg.expires_at = Date.now() + (j.expires_in - 60) * 1000;
  ctx.saveConfig(cfg);
  return j.access_token;
}

async function apiGet(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Fortnox API ${path}: ${res.status} ${await res.text()}`);
  return await res.json() as Record<string, unknown>;
}

async function fetchPaged(token: string, path: string, listKey: string): Promise<RawRow[]> {
  const out: RawRow[] = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const j = await apiGet(token, `${path}${sep}page=${page}&limit=500`);
    const items = (j[listKey] as RawRow[]) || [];
    out.push(...items);
    const meta = j.MetaInformation as { '@TotalPages'?: number } | undefined;
    const totalPages = meta?.['@TotalPages'] ?? 1;
    if (page >= totalPages || items.length === 0) break;
    page++;
  }
  return out;
}

export const fortnoxConnector: Connector = {
  key: 'fortnox',
  name: 'Fortnox',
  description: 'Hämtar kundfakturor, leverantörsfakturor och bokföringsdata från Fortnox via OAuth2.',
  authKind: 'oauth2',
  datasets: [
    { key: 'invoices_customer', label: 'Kundfakturor' },
    { key: 'invoices_supplier', label: 'Leverantörsfakturor' },
    { key: 'transactions', label: 'Bokförda intäkter/kostnader' }
  ],
  configFields: [],
  available: () => {
    const c = config.connectors.fortnox;
    if (!c.clientId || !c.clientSecret) {
      return { ok: false, reason: 'FORTNOX_CLIENT_ID/FORTNOX_CLIENT_SECRET saknas i servermiljön. Arkitekturen är på plats — anslutningen aktiveras när API-uppgifter finns.' };
    }
    return { ok: true };
  },
  async testConnection(ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<ConnectionStatus> {
    try {
      const token = await refreshToken(cfg, ctx);
      const info = await apiGet(token, '/companyinformation');
      const name = (info.CompanyInformation as { CompanyName?: string } | undefined)?.CompanyName || 'okänt bolag';
      return { ok: true, detail: `Ansluten till ${name}` };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  },
  async sync(ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<SyncResult> {
    try {
      const token = await refreshToken(cfg, ctx);
      const datasets: SyncResult['datasets'] = [];

      const invoices = await fetchPaged(token, '/invoices', 'Invoices');
      const custRows: RawRow[] = invoices.map(i => ({
        'fakturanummer': i.DocumentNumber, 'kund': i.CustomerName, 'fakturadatum': i.InvoiceDate,
        'förfallodatum': i.DueDate, 'belopp': i.Total, 'saldo': i.Balance,
        'betaldatum': i.FinalPayDate ?? '', 'status': i.Cancelled ? 'makulerad' : (Number(i.Balance) === 0 ? 'betald' : 'öppen'),
        'valuta': i.Currency
      }));
      const s1 = normalizeRows(ctx.orgId, ctx.sourceId, 'invoices_customer', custRows);
      datasets.push({ dataset: 'invoices_customer', fetched: s1.fetched, upserted: s1.upserted });

      const supInvoices = await fetchPaged(token, '/supplierinvoices', 'SupplierInvoices');
      const supRows: RawRow[] = supInvoices.map(i => ({
        'fakturanummer': i.GivenNumber, 'leverantör': i.SupplierName, 'fakturadatum': i.InvoiceDate,
        'förfallodatum': i.DueDate, 'belopp': i.Total, 'saldo': i.Balance,
        'status': i.Cancelled ? 'makulerad' : (Number(i.Balance) === 0 ? 'betald' : 'öppen'),
        'valuta': i.Currency
      }));
      const s2 = normalizeRows(ctx.orgId, ctx.sourceId, 'invoices_supplier', supRows);
      datasets.push({ dataset: 'invoices_supplier', fetched: s2.fetched, upserted: s2.upserted });

      return { ok: true, datasets };
    } catch (e) {
      return { ok: false, datasets: [], error: String(e) };
    }
  }
};
