import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.OI_DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Master key for encrypting connector secrets at rest (AES-256-GCM).
 * Taken from env OI_SECRET_KEY, otherwise generated once and persisted
 * with restrictive permissions. Never sent to the frontend.
 */
function loadSecretKey(): Buffer {
  const fromEnv = process.env.OI_SECRET_KEY;
  if (fromEnv && fromEnv.length >= 32) {
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: DATA_DIR,
  dbFile: process.env.OI_DB_FILE || path.join(DATA_DIR, 'oi.sqlite'),
  baseUrl: process.env.OI_BASE_URL || `http://localhost:${Number(process.env.PORT || 3000)}`,
  secretKey: loadSecretKey(),

  // Reasoning engine — model-agnostic. The core never hardcodes a model name;
  // provider and model come from configuration only.
  reasoning: {
    provider: process.env.OI_REASONING_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'deterministic'),
    model: process.env.OI_REASONING_MODEL || 'claude-fable-5',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    maxTokens: Number(process.env.OI_REASONING_MAX_TOKENS || 2000)
  },

  // Notification channel providers. All optional — the channel architecture
  // exists regardless; deliveries are recorded in the outbox and sent when
  // a provider is configured.
  channels: {
    smtpUrl: process.env.OI_SMTP_URL || '',            // smtp://user:pass@host:port
    emailFrom: process.env.OI_EMAIL_FROM || 'oi@localhost',
    smsWebhookUrl: process.env.OI_SMS_WEBHOOK_URL || '', // POST {to, body}
    pushWebhookUrl: process.env.OI_PUSH_WEBHOOK_URL || '' // POST {user, title, body}
  },

  connectors: {
    fortnox: {
      clientId: process.env.FORTNOX_CLIENT_ID || '',
      clientSecret: process.env.FORTNOX_CLIENT_SECRET || '',
      scopes: process.env.FORTNOX_SCOPES || 'companyinformation invoice supplierinvoice bookkeeping'
    },
    visma: {
      clientId: process.env.VISMA_CLIENT_ID || '',
      clientSecret: process.env.VISMA_CLIENT_SECRET || ''
    }
  }
};
