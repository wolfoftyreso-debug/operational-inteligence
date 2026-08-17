// Generic REST API connector — configurable base URL, auth and field mapping.
// Lets a customer expose any JSON endpoint as a canonical dataset.

import type { Connector, ConnectorContext, SyncResult, ConnectionStatus } from '../types';
import { CANONICAL_DATASETS } from '../types';
import { normalizeRows, type RawRow } from '../../ingest/normalize';

interface EndpointCfg {
  path: string;         // e.g. /export/invoices
  dataset: string;      // canonical dataset key
  items_path?: string;  // dot path to the array in the response, e.g. "data.items"
  field_map?: Record<string, string>; // canonical field -> json field
}

function dig(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function buildHeaders(cfg: Record<string, unknown>): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  const auth = String(cfg.auth_kind || 'none');
  if (auth === 'bearer' && cfg.auth_token) h.Authorization = `Bearer ${cfg.auth_token}`;
  if (auth === 'basic' && cfg.auth_user) {
    h.Authorization = 'Basic ' + Buffer.from(`${cfg.auth_user}:${cfg.auth_password || ''}`).toString('base64');
  }
  if (auth === 'header' && cfg.auth_header_name) h[String(cfg.auth_header_name)] = String(cfg.auth_header_value || '');
  return h;
}

export const genericApiConnector: Connector = {
  key: 'generic-api',
  name: 'Generic REST API',
  description: 'Läser JSON-data från valfritt REST-API med konfigurerbar autentisering och fältmappning.',
  authKind: 'config',
  datasets: CANONICAL_DATASETS,
  configFields: [
    { key: 'base_url', label: 'Bas-URL', required: true, placeholder: 'https://api.example.com' },
    { key: 'auth_kind', label: 'Autentisering (none|bearer|basic|header)', placeholder: 'bearer' },
    { key: 'auth_token', label: 'Bearer-token', secret: true },
    { key: 'auth_user', label: 'Basic-användare' },
    { key: 'auth_password', label: 'Basic-lösenord', secret: true },
    { key: 'auth_header_name', label: 'Header-namn' },
    { key: 'auth_header_value', label: 'Header-värde', secret: true },
    { key: 'endpoints', label: 'Endpoints (JSON-lista: path, dataset, items_path, field_map)', required: true, placeholder: '[{"path":"/invoices","dataset":"invoices_customer","items_path":"data"}]' }
  ],
  available: () => ({ ok: true }),
  async testConnection(_ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<ConnectionStatus> {
    try {
      const res = await fetch(String(cfg.base_url), { headers: buildHeaders(cfg), method: 'GET' });
      return { ok: res.status < 500, detail: `HTTP ${res.status} från ${cfg.base_url}` };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  },
  async sync(ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<SyncResult> {
    try {
      let endpoints: EndpointCfg[] = [];
      try {
        endpoints = typeof cfg.endpoints === 'string' ? JSON.parse(cfg.endpoints) : (cfg.endpoints as EndpointCfg[] || []);
      } catch {
        return { ok: false, datasets: [], error: 'Ogiltig endpoints-konfiguration (måste vara JSON)' };
      }
      const datasets: SyncResult['datasets'] = [];
      for (const ep of endpoints) {
        const res = await fetch(String(cfg.base_url).replace(/\/$/, '') + ep.path, { headers: buildHeaders(cfg) });
        if (!res.ok) throw new Error(`HTTP ${res.status} från ${ep.path}`);
        const body = await res.json();
        let items = dig(body, ep.items_path);
        if (!Array.isArray(items)) items = Array.isArray(body) ? body : [];
        let rows = items as RawRow[];
        if (ep.field_map) {
          rows = rows.map(r => {
            const mapped: RawRow = {};
            for (const [canon, jsonField] of Object.entries(ep.field_map!)) mapped[canon] = dig(r, jsonField);
            return mapped;
          });
        }
        const stats = normalizeRows(ctx.orgId, ctx.sourceId, ep.dataset, rows);
        datasets.push({ dataset: ep.dataset, fetched: stats.fetched, upserted: stats.upserted });
      }
      return { ok: true, datasets };
    } catch (e) {
      return { ok: false, datasets: [], error: String(e) };
    }
  }
};
