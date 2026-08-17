// Alert engine — an alert means something genuinely requires attention.
// Severity thresholds + per-user channel preferences + spam protection
// (dedupe on fingerprint within a cooldown window).

import { all, get, run, uuid, now } from '../db';
import type { FindingRow, Severity } from '../domain/types';
import { severityAtLeast } from '../domain/types';
import { deliver, type Channel } from './channels';

const ALERT_MIN_SEVERITY: Severity = 'high';
const DEDUPE_DAYS = 7;

export function dispatchAlertsForFinding(f: FindingRow): void {
  if (!severityAtLeast(f.severity, ALERT_MIN_SEVERITY)) return;

  // Spam protection: no repeat alert for the same underlying problem within the window.
  const cutoff = new Date(Date.now() - DEDUPE_DAYS * 86400000).toISOString();
  const recent = get<{ id: string }>(
    `SELECT a.id FROM alerts a JOIN findings fi ON fi.id = a.finding_id
     WHERE a.org_id = ? AND fi.fingerprint = ? AND a.created_at >= ?`,
    f.org_id, f.fingerprint, cutoff
  );
  if (recent) return;

  const alertId = uuid();
  run('INSERT INTO alerts (id, org_id, finding_id, severity, title, body, created_at) VALUES (?,?,?,?,?,?,?)',
    alertId, f.org_id, f.id, f.severity, f.title, f.description, now());

  // Fan out to users according to their preferences.
  const users = all<{ id: string; email: string }>('SELECT id, email FROM users WHERE org_id = ?', f.org_id);
  for (const u of users) {
    const prefs = all<{ channel: Channel; min_severity: Severity; enabled: number; destination: string | null }>(
      'SELECT channel, min_severity, enabled, destination FROM alert_prefs WHERE user_id = ?', u.id
    );
    const effective = prefs.length ? prefs : [{ channel: 'in_app' as Channel, min_severity: 'high' as Severity, enabled: 1, destination: null }];
    for (const p of effective) {
      if (!p.enabled) continue;
      if (!severityAtLeast(f.severity, p.min_severity)) continue;
      void deliver({
        orgId: f.org_id,
        alertId,
        userId: u.id,
        channel: p.channel,
        destination: p.destination ?? (p.channel === 'email' ? u.email : null),
        title: `[${f.severity.toUpperCase()}] ${f.title}`,
        body: f.description
      });
    }
  }
}

export function listAlerts(orgId: string, limit = 50): unknown[] {
  return all(
    'SELECT id, finding_id, severity, title, body, created_at, read_at FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT ?',
    orgId, limit
  );
}

export function markAlertRead(orgId: string, alertId: string): void {
  run('UPDATE alerts SET read_at = ? WHERE id = ? AND org_id = ?', now(), alertId, orgId);
}
