// Connector contract — every integration implements this interface.
// Connectors are reusable product components, never customer-specific logic.

export type AuthKind = 'oauth2' | 'apikey' | 'file' | 'config';

export interface DatasetDescriptor {
  key: string;                 // canonical dataset: transactions|invoices_customer|invoices_supplier|customers|suppliers|employees
  label: string;
}

export interface ConnectorContext {
  orgId: string;
  sourceId: string;
  sourceName: string;
  /** Persist updated config (e.g. refreshed OAuth tokens). Stored encrypted. */
  saveConfig(cfg: Record<string, unknown>): void;
}

export interface SyncResult {
  ok: boolean;
  datasets: { dataset: string; fetched: number; upserted: number }[];
  error?: string;
}

export interface ConnectionStatus {
  ok: boolean;
  detail: string;
}

export interface Connector {
  key: string;
  name: string;
  description: string;
  authKind: AuthKind;
  datasets: DatasetDescriptor[];
  /** Fields the user must provide when creating a source (non-secret ones are echoed back). */
  configFields: { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string }[];
  /** Whether this connector is ready for live use (e.g. OAuth app credentials present). */
  available(): { ok: boolean; reason?: string };
  testConnection(ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<ConnectionStatus>;
  sync(ctx: ConnectorContext, cfg: Record<string, unknown>): Promise<SyncResult>;
}

export const CANONICAL_DATASETS: DatasetDescriptor[] = [
  { key: 'transactions', label: 'Transaktioner (intäkter/kostnader)' },
  { key: 'invoices_customer', label: 'Kundfakturor' },
  { key: 'invoices_supplier', label: 'Leverantörsfakturor' },
  { key: 'customers', label: 'Kunder' },
  { key: 'suppliers', label: 'Leverantörer' },
  { key: 'employees', label: 'Personal' },
  { key: 'time_entries', label: 'Tidsposter (arbetade/debiterade timmar)' },
  { key: 'work_orders', label: 'Arbetsorder' }
];
