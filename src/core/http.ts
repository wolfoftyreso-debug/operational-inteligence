// HTTP hardening: structured request logging with correlation IDs,
// central error handling (no stack traces to clients, no secrets in logs),
// and basic abuse protection on authentication endpoints.

import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { requestId?: string }
  }
}

/** Structured JSON log line to stdout (collected by the platform's log agent). */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  // Never log credentials, tokens, cookies or raw model inputs here.
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const id = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].slice(0, 64)) || crypto.randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Skip static assets to keep logs signal-dense.
    if (!req.path.startsWith('/api') && !req.path.startsWith('/rss') && !req.path.startsWith('/connect')) return;
    log(res.statusCode >= 500 ? 'error' : 'info', 'http', {
      request_id: id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(ms * 10) / 10,
      org: req.user?.org_id ?? null,
      auth: req.authVia ?? null
    });
  });
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

/** Central error handler — clients get a request id, never a stack trace. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const id = req.requestId ?? 'unknown';
  log('error', 'unhandled_error', {
    request_id: id, path: req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined
  });
  if (res.headersSent) return;
  res.status(500).json({
    error: 'Ett internt fel inträffade. Ingen data har gått förlorad.',
    detail: 'Ange referensen vid felanmälan.',
    request_id: id
  });
}

// --- Simple in-memory rate limiting for auth endpoints ---
// (Per-process; a shared store is needed if the API is scaled horizontally —
// documented in the deployment contract.)

const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;

export function authRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim();
  const nowMs = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < nowMs) {
    attempts.set(key, { count: 1, resetAt: nowMs + WINDOW_MS });
    next();
    return;
  }
  entry.count++;
  if (entry.count > MAX_ATTEMPTS) {
    log('warn', 'auth_rate_limited', { ip_hash: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) });
    res.status(429).json({ error: 'För många inloggningsförsök. Försök igen om en stund.' });
    return;
  }
  next();
}
