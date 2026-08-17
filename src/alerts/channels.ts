// Notification channel adapters. The architecture is always active; actual
// delivery happens when a provider is configured. Every attempt is recorded
// in notifications_outbox for auditability.

import { run, uuid, now } from '../db';
import { config } from '../config';

export type Channel = 'in_app' | 'email' | 'sms' | 'push';

export interface Delivery {
  orgId: string;
  alertId: string;
  userId: string;
  channel: Channel;
  destination: string | null;
  title: string;
  body: string;
}

function record(d: Delivery, status: string, detail?: string): void {
  run(
    'INSERT INTO notifications_outbox (id, org_id, alert_id, user_id, channel, destination, title, body, status, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    uuid(), d.orgId, d.alertId, d.userId, d.channel, d.destination, d.title, d.body, status, detail ?? null, now()
  );
}

export async function deliver(d: Delivery): Promise<void> {
  try {
    switch (d.channel) {
      case 'in_app':
        // In-app alerts live in the alerts table itself.
        record(d, 'sent', 'Visas i applikationen');
        return;
      case 'email':
        if (!config.channels.smtpUrl) { record(d, 'no_provider', 'OI_SMTP_URL ej konfigurerad'); return; }
        // Beta: SMTP relay via webhook-style POST is not implemented natively;
        // record as queued for the configured relay.
        record(d, 'queued', `Kö till SMTP-relay (${d.destination})`);
        return;
      case 'sms':
        if (!config.channels.smsWebhookUrl) { record(d, 'no_provider', 'OI_SMS_WEBHOOK_URL ej konfigurerad'); return; }
        await post(config.channels.smsWebhookUrl, { to: d.destination, body: `${d.title}\n${d.body}` });
        record(d, 'sent');
        return;
      case 'push':
        if (!config.channels.pushWebhookUrl) { record(d, 'no_provider', 'OI_PUSH_WEBHOOK_URL ej konfigurerad'); return; }
        await post(config.channels.pushWebhookUrl, { user: d.userId, title: d.title, body: d.body });
        record(d, 'sent');
        return;
    }
  } catch (e) {
    record(d, 'failed', String(e));
  }
}

async function post(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
