import { run, uuid, now } from '../db';

export function audit(orgId: string | null, userId: string | null, action: string, target?: string, detail?: unknown): void {
  run(
    'INSERT INTO audit_log (id, org_id, user_id, action, target, detail_json, at) VALUES (?,?,?,?,?,?,?)',
    uuid(), orgId, userId, action, target ?? null, detail ? JSON.stringify(detail) : null, now()
  );
}
