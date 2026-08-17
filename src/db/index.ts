import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';

let db: DatabaseSync | null = null;

function schemaSql(): string {
  // Works both from src/ (tsx dev) and dist/src/ (compiled).
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'src', 'db', 'schema.sql')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  }
  throw new Error('schema.sql not found');
}

// Additive migrations for columns on existing tables. Each runs once;
// failures for already-applied changes are ignored.
const MIGRATIONS: string[] = [
  "ALTER TABLE business_units ADD COLUMN parent_id TEXT",
  "ALTER TABLE users ADD COLUMN unit_id TEXT",
  "ALTER TABLE users ADD COLUMN responsibilities TEXT",
  "ALTER TABLE goals ADD COLUMN metric TEXT",
  "ALTER TABLE goals ADD COLUMN period_start TEXT",
  "ALTER TABLE goals ADD COLUMN period_end TEXT",
  "ALTER TABLE goals ADD COLUMN parent_goal_id TEXT",
  "ALTER TABLE goals ADD COLUMN owner TEXT",
  "ALTER TABLE goals ADD COLUMN source TEXT",
  "ALTER TABLE goals ADD COLUMN source_document_id TEXT",
  "ALTER TABLE goals ADD COLUMN status TEXT DEFAULT 'active'",
  "ALTER TABLE decisions ADD COLUMN source_document_id TEXT",
  "ALTER TABLE actions ADD COLUMN source_document_id TEXT"
];

function applyMigrations(d: DatabaseSync): void {
  for (const m of MIGRATIONS) {
    try { d.exec(m); } catch { /* column already exists */ }
  }
}

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(config.dbFile);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(schemaSql());
    applyMigrations(db);
  }
  return db;
}

/** For tests: use an isolated database file. */
export function openTestDb(file: string): DatabaseSync {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(schemaSql());
  applyMigrations(db);
  return db;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type Row = Record<string, unknown>;

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  getDb().prepare(sql).run(...(params as never[]));
}
