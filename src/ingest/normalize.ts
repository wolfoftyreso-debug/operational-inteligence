// Normalization: raw connector rows → canonical internal model.
// Every upsert is idempotent on (org, source, external_id).

import { all, get, run, uuid, now, today } from '../db';
import { parseAmount, parseDate } from './csv';

export interface RawRow { [key: string]: unknown }

// --- Header aliases (Swedish/English) per canonical field ---

const ALIASES: Record<string, string[]> = {
  external_id: ['id', 'externt id', 'external id', 'documentnumber', 'fakturanummer', 'invoice number', 'invoicenumber', 'verifikationsnummer', 'nummer', 'no', 'nr'],
  date: ['datum', 'date', 'bokföringsdatum', 'transactiondate', 'transaktionsdatum'],
  description: ['beskrivning', 'description', 'text', 'benämning', 'kommentar'],
  amount: ['belopp', 'amount', 'summa', 'total', 'totalbelopp', 'total amount'],
  kind: ['typ', 'type', 'kind', 'art'],
  category: ['kategori', 'category', 'kostnadsslag', 'konto­grupp', 'kontogrupp'],
  account: ['konto', 'account', 'kontonummer', 'account number'],
  unit: ['enhet', 'unit', 'avdelning', 'department', 'kostnadsställe', 'costcenter', 'cost center', 'anläggning'],
  currency: ['valuta', 'currency'],
  counterparty: ['kund', 'customer', 'customername', 'kundnamn', 'leverantör', 'supplier', 'suppliername', 'leverantörsnamn', 'motpart', 'counterparty', 'namn', 'name'],
  issue_date: ['fakturadatum', 'invoice date', 'invoicedate', 'utfärdad'],
  due_date: ['förfallodatum', 'due date', 'duedate', 'förfaller'],
  paid_date: ['betaldatum', 'paid date', 'paiddate', 'betald'],
  balance: ['saldo', 'balance', 'kvarstående', 'restbelopp', 'outstanding'],
  status: ['status', 'tillstånd'],
  role: ['roll', 'role', 'befattning', 'title'],
  email: ['epost', 'e-post', 'email', 'mail']
};

function normHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
}

/** Map raw headers to canonical field names. Returns {canonicalField: rawHeader}. */
export function mapHeaders(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [canon, aliases] of Object.entries(ALIASES)) {
    for (const h of headers) {
      const nh = normHeader(h);
      if (nh === canon || aliases.includes(nh)) { if (!map[canon]) map[canon] = h; }
    }
  }
  return map;
}

/** Guess which canonical dataset a table of headers represents. */
export function detectDataset(headers: string[]): string {
  const m = mapHeaders(headers);
  const hs = headers.map(normHeader).join('|');
  if (m.due_date || /förfall|due/.test(hs)) {
    if (/leverantör|supplier/.test(hs)) return 'invoices_supplier';
    return 'invoices_customer';
  }
  if (m.role || /anställd|employee|personal/.test(hs)) return 'employees';
  if (m.amount && m.date) return 'transactions';
  if (m.counterparty && !m.amount) return 'customers';
  return 'transactions';
}

export function rowsFromTable(table: string[][]): RawRow[] {
  if (table.length < 2) return [];
  const headers = table[0].map(h => h.trim());
  return table.slice(1).map(cells => {
    const row: RawRow = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

function pick(row: RawRow, headerMap: Record<string, string>, field: string): unknown {
  const h = headerMap[field];
  return h ? row[h] : undefined;
}

export interface NormalizeStats { fetched: number; upserted: number; skipped: number; errors: string[] }

function storeRaw(orgId: string, sourceId: string, dataset: string, externalId: string | null, payload: unknown): void {
  run(
    'INSERT INTO raw_records (id, org_id, source_id, dataset, external_id, payload_json, imported_at) VALUES (?,?,?,?,?,?,?)',
    uuid(), orgId, sourceId, dataset, externalId, JSON.stringify(payload), now()
  );
}

function findOrCreateUnit(orgId: string, name: string | null): string | null {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const existing = get<{ id: string }>('SELECT id FROM business_units WHERE org_id = ? AND lower(name) = lower(?)', orgId, trimmed);
  if (existing) return existing.id;
  const id = uuid();
  run('INSERT INTO business_units (id, org_id, name) VALUES (?,?,?)', id, orgId, trimmed);
  return id;
}

function findOrCreateCounterparty(orgId: string, table: 'customers' | 'suppliers', name: string | null, externalId: string | null, sourceId: string): string | null {
  if (!name && !externalId) return null;
  let row = externalId
    ? get<{ id: string }>(`SELECT id FROM ${table} WHERE org_id = ? AND external_id = ?`, orgId, externalId)
    : undefined;
  if (!row && name) {
    row = get<{ id: string }>(`SELECT id FROM ${table} WHERE org_id = ? AND lower(name) = lower(?)`, orgId, String(name).trim());
  }
  if (row) return row.id;
  const id = uuid();
  run(`INSERT INTO ${table} (id, org_id, external_id, name, source_id) VALUES (?,?,?,?,?)`,
    id, orgId, externalId, name ? String(name).trim() : (externalId || 'Okänd'), sourceId);
  return id;
}

/** Normalize and upsert rows into a canonical dataset. */
export function normalizeRows(
  orgId: string,
  sourceId: string,
  dataset: string,
  rawRows: RawRow[],
  opts: { storeRaws?: boolean } = {}
): NormalizeStats {
  const stats: NormalizeStats = { fetched: rawRows.length, upserted: 0, skipped: 0, errors: [] };
  if (rawRows.length === 0) return stats;
  const headers = Object.keys(rawRows[0]);
  const hm = mapHeaders(headers);

  for (const row of rawRows) {
    try {
      const extIdRaw = pick(row, hm, 'external_id');
      const externalId = extIdRaw !== undefined && extIdRaw !== '' ? String(extIdRaw) : null;
      if (opts.storeRaws !== false) storeRaw(orgId, sourceId, dataset, externalId, row);

      if (dataset === 'transactions') {
        const date = parseDate(pick(row, hm, 'date'));
        const amountRaw = parseAmount(pick(row, hm, 'amount'));
        if (!date || amountRaw === null) { stats.skipped++; continue; }
        let kind = String(pick(row, hm, 'kind') ?? '').toLowerCase().trim();
        if (/int[äa]kt|revenue|income|sales/.test(kind)) kind = 'revenue';
        else if (/kostnad|cost|expense/.test(kind)) kind = 'cost';
        else kind = amountRaw >= 0 ? 'revenue' : 'cost';
        const amount = Math.abs(amountRaw);
        const unitId = findOrCreateUnit(orgId, pick(row, hm, 'unit') as string | null);
        const id = uuid();
        run(
          `INSERT INTO transactions (id, org_id, external_id, date, description, amount, kind, category, unit_id, account, currency, source_id, imported_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (org_id, source_id, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET date=excluded.date, description=excluded.description, amount=excluded.amount, kind=excluded.kind,
             category=excluded.category, unit_id=excluded.unit_id, account=excluded.account, imported_at=excluded.imported_at`,
          id, orgId, externalId, date,
          String(pick(row, hm, 'description') ?? '') || null,
          amount, kind,
          String(pick(row, hm, 'category') ?? '').trim().toLowerCase() || null,
          unitId,
          String(pick(row, hm, 'account') ?? '') || null,
          String(pick(row, hm, 'currency') ?? 'SEK') || 'SEK',
          sourceId, now()
        );
        stats.upserted++;
      } else if (dataset === 'invoices_customer' || dataset === 'invoices_supplier') {
        const kind = dataset === 'invoices_customer' ? 'customer' : 'supplier';
        const amount = parseAmount(pick(row, hm, 'amount'));
        if (amount === null) { stats.skipped++; continue; }
        const issue = parseDate(pick(row, hm, 'issue_date')) || parseDate(pick(row, hm, 'date'));
        const due = parseDate(pick(row, hm, 'due_date'));
        const paid = parseDate(pick(row, hm, 'paid_date'));
        let balance = parseAmount(pick(row, hm, 'balance'));
        const statusRaw = String(pick(row, hm, 'status') ?? '').toLowerCase();
        let status: string;
        if (paid || /paid|betald/.test(statusRaw)) { status = 'paid'; balance = 0; }
        else if (/cancel|makuler/.test(statusRaw)) { status = 'cancelled'; balance = 0; }
        else {
          if (balance === null) balance = amount;
          status = due && due < today() ? 'overdue' : 'open';
        }
        const cpName = pick(row, hm, 'counterparty') as string | null;
        const cpId = findOrCreateCounterparty(orgId, kind === 'customer' ? 'customers' : 'suppliers', cpName, null, sourceId);
        const unitId = findOrCreateUnit(orgId, pick(row, hm, 'unit') as string | null);
        run(
          `INSERT INTO invoices (id, org_id, external_id, kind, counterparty_id, counterparty_name, issue_date, due_date, paid_date, amount, balance, currency, status, unit_id, source_id, imported_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (org_id, source_id, kind, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET counterparty_id=excluded.counterparty_id, counterparty_name=excluded.counterparty_name,
             issue_date=excluded.issue_date, due_date=excluded.due_date, paid_date=excluded.paid_date,
             amount=excluded.amount, balance=excluded.balance, status=excluded.status, imported_at=excluded.imported_at`,
          uuid(), orgId, externalId, kind, cpId,
          cpName ? String(cpName).trim() : null,
          issue, due, paid, Math.abs(amount), Math.abs(balance ?? 0),
          String(pick(row, hm, 'currency') ?? 'SEK') || 'SEK',
          status, unitId, sourceId, now()
        );
        stats.upserted++;
      } else if (dataset === 'employees') {
        const name = pick(row, hm, 'counterparty') ?? pick(row, hm, 'description');
        if (!name) { stats.skipped++; continue; }
        const unitId = findOrCreateUnit(orgId, pick(row, hm, 'unit') as string | null);
        const existing = externalId
          ? get<{ id: string }>('SELECT id FROM employees WHERE org_id = ? AND external_id = ?', orgId, externalId)
          : get<{ id: string }>('SELECT id FROM employees WHERE org_id = ? AND lower(name) = lower(?)', orgId, String(name).trim());
        if (existing) {
          run('UPDATE employees SET name=?, unit_id=?, role=? WHERE id=?',
            String(name).trim(), unitId, String(pick(row, hm, 'role') ?? '') || null, existing.id);
        } else {
          run('INSERT INTO employees (id, org_id, external_id, name, unit_id, role, source_id) VALUES (?,?,?,?,?,?,?)',
            uuid(), orgId, externalId, String(name).trim(), unitId, String(pick(row, hm, 'role') ?? '') || null, sourceId);
        }
        stats.upserted++;
      } else if (dataset === 'customers' || dataset === 'suppliers') {
        const name = pick(row, hm, 'counterparty');
        if (!name) { stats.skipped++; continue; }
        findOrCreateCounterparty(orgId, dataset, String(name), externalId, sourceId);
        stats.upserted++;
      } else {
        stats.skipped++;
      }
    } catch (e) {
      stats.errors.push(String(e));
      stats.skipped++;
    }
  }
  return stats;
}

/** Human-readable label for a data source, used in evidence chains. */
export function sourceLabel(sourceId: string): string {
  if (sourceId === 'manual') return 'Manuell uppgift';
  const src = get<{ name: string; connector_key: string }>('SELECT name, connector_key FROM data_sources WHERE id = ?', sourceId);
  if (!src) return 'Okänd källa';
  return `${src.name} (${src.connector_key})`;
}

export function listSourceLabels(orgId: string): string[] {
  return all<{ name: string; connector_key: string }>(
    "SELECT name, connector_key FROM data_sources WHERE org_id = ? AND status != 'disconnected'", orgId
  ).map(s => `${s.name} (${s.connector_key})`);
}
