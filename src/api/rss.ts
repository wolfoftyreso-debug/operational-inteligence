// RSS feeds — /rss/alerts, /rss/findings, /rss/management
// Authenticated with the organization's rss_token (?token=...).

import type { Request, Response } from 'express';
import { all, get } from '../db';
import { config } from '../config';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function feed(title: string, link: string, items: { title: string; description: string; date: string; guid: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${esc(title)}</title>
<link>${esc(link)}</link>
<description>${esc(title)} — Operational Intelligence</description>
<language>sv-SE</language>
${items.map(i => `<item>
<title>${esc(i.title)}</title>
<description>${esc(i.description)}</description>
<pubDate>${new Date(i.date).toUTCString()}</pubDate>
<guid isPermaLink="false">${esc(i.guid)}</guid>
</item>`).join('\n')}
</channel>
</rss>`;
}

function orgFromToken(req: Request): { id: string; name: string } | undefined {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return undefined;
  return get<{ id: string; name: string }>('SELECT id, name FROM organizations WHERE rss_token = ?', token);
}

export function rssAlerts(req: Request, res: Response): void {
  const org = orgFromToken(req);
  if (!org) { res.status(401).send('Ogiltig token'); return; }
  const rows = all<{ id: string; title: string; body: string; created_at: string; severity: string }>(
    'SELECT id, title, body, created_at, severity FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT 30', org.id);
  res.type('application/rss+xml').send(feed(`Alerts — ${org.name}`, config.baseUrl,
    rows.map(r => ({ title: `[${r.severity.toUpperCase()}] ${r.title}`, description: r.body, date: r.created_at, guid: r.id }))));
}

export function rssFindings(req: Request, res: Response): void {
  const org = orgFromToken(req);
  if (!org) { res.status(401).send('Ogiltig token'); return; }
  const rows = all<{ id: string; title: string; description: string; detected_at: string; severity: string; confidence: number }>(
    "SELECT id, title, description, detected_at, severity, confidence FROM findings WHERE org_id = ? AND status IN ('open','acknowledged') ORDER BY detected_at DESC LIMIT 30", org.id);
  res.type('application/rss+xml').send(feed(`Findings — ${org.name}`, config.baseUrl,
    rows.map(r => ({ title: `[${r.severity.toUpperCase()}] ${r.title}`, description: `${r.description} (confidence ${(r.confidence * 100).toFixed(0)} %)`, date: r.detected_at, guid: r.id }))));
}

export function rssManagement(req: Request, res: Response): void {
  const org = orgFromToken(req);
  if (!org) { res.status(401).send('Ogiltig token'); return; }
  const runs = all<{ id: string; finished_at: string; summary: string; narrative: string | null }>(
    "SELECT id, finished_at, summary, narrative FROM analysis_runs WHERE org_id = ? AND status = 'ok' ORDER BY started_at DESC LIMIT 10", org.id);
  res.type('application/rss+xml').send(feed(`Ledningsläge — ${org.name}`, config.baseUrl,
    runs.map(r => ({ title: r.summary ?? 'Verksamhetsbedömning', description: r.narrative ?? r.summary ?? '', date: r.finished_at, guid: r.id }))));
}
