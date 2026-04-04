import { getDb } from './task-queue.js';
import { AuditEntry } from '../../shared/src/types.js';

// Immutable append-only audit log (SQLite + JSONL file mirror).
// The JSONL file at state/audit.log is the authoritative human-readable record.
// The SQLite table supports fast agent-specific queries (e.g., readRecent).

export function writeAudit(entry: Omit<AuditEntry, 'ts'>): void {
  const full: AuditEntry = { ...entry, ts: Date.now() };
  getDb().prepare(`
    INSERT INTO audit_log (ts, agent, task_id, action, payload, outcome, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    full.ts,
    full.agent,
    full.taskId,
    full.action,
    JSON.stringify(full.payload),
    full.outcome,
    full.errorCode ?? null
  );
}

// Read the last N entries for a given agent — used for session start breadcrumb context.
export function readRecentForAgent(agent: string, limit = 5): AuditEntry[] {
  const rows = getDb().prepare(`
    SELECT * FROM audit_log WHERE agent = ? ORDER BY ts DESC LIMIT ?
  `).all(agent, limit) as Array<Record<string, unknown>>;

  return rows.reverse().map(rowToEntry);
}

export function readRecentForTask(taskId: string): AuditEntry[] {
  const rows = getDb().prepare(`
    SELECT * FROM audit_log WHERE task_id = ? ORDER BY ts ASC
  `).all(taskId) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: row.id as number,
    ts: row.ts as number,
    agent: row.agent as string,
    taskId: row.task_id as string,
    action: row.action as AuditEntry['action'],
    payload: row.payload ? JSON.parse(row.payload as string) : null,
    outcome: row.outcome as AuditEntry['outcome'],
    errorCode: row.error_code as string | undefined,
  };
}
