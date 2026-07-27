/**
 * Audit log — records security-sensitive actions for compliance.
 * Fire-and-forget: errors are logged but never thrown to the caller.
 */
import { db } from '../db';

type AuditAction =
  | 'login'
  | 'logout'
  | 'check_started'
  | 'bulk_check_started'
  | 'score_override'
  | 'prompt_changed'
  | 'system_param_changed';

interface AuditEntry {
  teacherId: string;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export function audit(entry: AuditEntry): void {
  db.query(
    `INSERT INTO audit_log (teacher_id, action, entity_type, entity_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.teacherId,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.ipAddress ?? null,
    ],
  ).catch(() => {}); // best-effort, never block request
}
