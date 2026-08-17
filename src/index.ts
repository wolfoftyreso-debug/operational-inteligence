import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { getDb, get, run, now } from './db';
import { authenticate } from './core/auth';
import { router as apiRouter } from './api/routes';
import { rssAlerts, rssFindings, rssManagement } from './api/rss';
import { getDataSource, makeContext } from './connectors/registry';
import { fortnoxExchangeCode } from './connectors/fortnox';
import { decryptSecret } from './core/crypto';
import { audit } from './core/audit';
import { requestLogger, securityHeaders, errorHandler, authRateLimit, log } from './core/http';

getDb();

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '25mb' }));
app.use(authenticate);
app.use(requestLogger);
app.use('/api/v1/auth', authRateLimit);

// API
app.use('/api/v1', apiRouter);

// RSS
app.get('/rss/alerts', rssAlerts);
app.get('/rss/findings', rssFindings);
app.get('/rss/management', rssManagement);

// Fortnox OAuth callback (browser redirect target)
app.get('/connect/fortnox/callback', async (req, res) => {
  try {
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const [sourceId] = state.split('.');
    const srcRow = get<{ id: string; org_id: string; config_encrypted: string | null }>(
      'SELECT id, org_id, config_encrypted FROM data_sources WHERE id = ?', sourceId);
    if (!srcRow || !code) { res.status(400).send('Ogiltig OAuth-callback'); return; }
    const stored = srcRow.config_encrypted ? JSON.parse(decryptSecret(srcRow.config_encrypted)) : {};
    if (!state.endsWith('.' + String(stored.oauth_state ?? ''))) { res.status(400).send('Ogiltigt OAuth-state'); return; }
    const tokens = await fortnoxExchangeCode(code);
    const src = getDataSource(srcRow.org_id, srcRow.id);
    if (!src) { res.status(404).send('Källa saknas'); return; }
    makeContext(src).saveConfig({ ...tokens });
    run("UPDATE data_sources SET status = 'connected', last_error = NULL WHERE id = ?", src.id);
    audit(srcRow.org_id, null, 'source.oauth_connected', src.id, { connector: 'fortnox' });
    res.redirect('/#/integrations');
  } catch (e) {
    res.status(500).send('OAuth-fel: ' + String(e));
  }
});

// Health probes: /healthz = liveness (process up), /readyz = readiness
// (database reachable and schema loaded).
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, at: now() });
});
app.get('/readyz', (_req, res) => {
  try {
    get('SELECT 1 as ok');
    res.json({ ok: true, db: 'ok', at: now() });
  } catch (e) {
    res.status(503).json({ ok: false, db: String(e) });
  }
});

// Static frontend
const publicDir = [
  path.join(__dirname, '..', '..', 'public'),
  path.join(process.cwd(), 'public')
].find(p => fs.existsSync(p)) ?? path.join(process.cwd(), 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(errorHandler);

if (require.main === module) {
  const server = app.listen(config.port, () => {
    log('info', 'server_started', { base_url: config.baseUrl, port: config.port, node: process.version });
  });
  // Graceful shutdown: finish in-flight requests before exit (K8s SIGTERM).
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log('info', 'shutdown_initiated', { signal });
      server.close(() => {
        log('info', 'shutdown_complete', {});
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}

export { app };
