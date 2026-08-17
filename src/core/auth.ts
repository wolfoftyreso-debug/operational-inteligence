import type { Request, Response, NextFunction } from 'express';
import { all, get, run, uuid, now } from '../db';
import { sha256 } from './crypto';
import type { Role } from '../domain/types';

export interface AuthedUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      authVia?: 'session' | 'api_key';
    }
  }
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/** Session cookie string — Secure is added automatically when served over TLS. */
export function sessionCookie(sid: string): string {
  const secure = (process.env.OI_BASE_URL ?? '').startsWith('https') ? '; Secure' : '';
  return `oi_session=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=1209600${secure}`;
}

export function clearedSessionCookie(): string {
  return 'oi_session=; HttpOnly; Path=/; Max-Age=0';
}

export function createSession(userId: string): string {
  const id = uuid() + uuid().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  run('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)', id, userId, now(), expires);
  return id;
}

export function destroySession(id: string): void {
  run('DELETE FROM sessions WHERE id = ?', id);
}

function userFromSession(sid: string): AuthedUser | undefined {
  const row = get<{ user_id: string; expires_at: string }>('SELECT user_id, expires_at FROM sessions WHERE id = ?', sid);
  if (!row) return undefined;
  if (row.expires_at < now()) { destroySession(sid); return undefined; }
  return get<AuthedUser>('SELECT id, org_id, email, name, role FROM users WHERE id = ?', row.user_id);
}

function userFromApiKey(key: string): AuthedUser | undefined {
  const hash = sha256(key);
  const row = get<{ id: string; org_id: string }>(
    'SELECT id, org_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', hash
  );
  if (!row) return undefined;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), row.id);
  // API keys act with executive-level read scope, bound to the org.
  return { id: 'api:' + row.id, org_id: row.org_id, email: '', name: 'API', role: 'executive' };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authz = req.headers.authorization;
  if (authz && authz.startsWith('Bearer ')) {
    const u = userFromApiKey(authz.slice(7).trim());
    if (u) { req.user = u; req.authVia = 'api_key'; }
  }
  if (!req.user) {
    const keyParam = typeof req.query.key === 'string' ? req.query.key : undefined;
    if (keyParam) {
      const u = userFromApiKey(keyParam);
      if (u) { req.user = u; req.authVia = 'api_key'; }
    }
  }
  if (!req.user) {
    const sid = parseCookies(req.headers.cookie)['oi_session'];
    if (sid) {
      const u = userFromSession(sid);
      if (u) { req.user = u; req.authVia = 'session'; }
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Ej inloggad' }); return; }
  next();
}

// Role hierarchy for information scope. Admin additionally manages settings.
const ROLE_LEVEL: Record<Role, number> = {
  technician: 0,
  team_manager: 1,
  department_manager: 2,
  facility_manager: 3,
  executive: 4,
  admin: 4
};

export function roleLevel(role: Role): number {
  return ROLE_LEVEL[role] ?? 0;
}

export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) { res.status(401).json({ error: 'Ej inloggad' }); return; }
    if (roleLevel(req.user.role) < ROLE_LEVEL[minRole]) {
      res.status(403).json({ error: 'Behörighet saknas' });
      return;
    }
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Ej inloggad' }); return; }
  if (req.user.role !== 'admin') { res.status(403).json({ error: 'Kräver administratörsroll' }); return; }
  next();
}

/** Minimum severity a role sees on the dashboard — lower roles get a focused view. */
export function visibleSeverities(role: Role): string[] {
  if (roleLevel(role) <= 1) return ['medium', 'high', 'critical'];
  return ['info', 'low', 'medium', 'high', 'critical'];
}

export function listOrgUsers(orgId: string): AuthedUser[] {
  return all<AuthedUser>('SELECT id, org_id, email, name, role FROM users WHERE org_id = ?', orgId);
}
