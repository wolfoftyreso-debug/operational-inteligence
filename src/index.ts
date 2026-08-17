import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config';
import { getDb, get, run, now } from './db';
import { authenticate } from './core/auth';
import { router as apiRouter } from './api/routes';
import { rssAlerts, rssFindings, rssManagement } from './api/rss';
import { getDataSource, makeContext, getConnector } from './connectors/registry';
import { fortnoxExchangeCode } from './connectors/fortnox';
import { decryptSecret } from './core/crypto';
import { audit } from './core/audit';

getDb();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(authenticate);

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

// Health
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, at: now() });
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

if (require.main === module) {
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Operational Intelligence beta körs på ${config.baseUrl} (port ${config.port})`);
  });
}

export { app };
