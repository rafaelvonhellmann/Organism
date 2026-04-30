import { getDb } from './task-queue.js';
import { AuditEntry } from '../../shared/src/types.js';
import { appendAuditJsonl, readRecentAuditEntriesFromJsonl } from '../../shared/src/audit-log.js';

// Immutable append-only audit log.
// All runtime writers go through this module so the SQLite query model and the
// JSONL operator ledger stay in the same canonical state root.

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

  try {
    appendAuditJsonl(full);
  } catch (error) {
    // Audit mirroring must never crash agent execution, but we still surface it.
    console.error('[Audit] Failed to append JSONL audit entry:', error);
  }
}

// Read the last N entries for a given agent — used for session start breadcrumb context.
export function readRecentForAgent(agent: string, limit = 5): AuditEntry[] {
  const rows = getDb().prepare(`
    SELECT * FROM audit_log WHERE agent = ? ORDER BY ts DESC LIMIT ?
  `).all(agent, limit) as Array<Record<string, unknown>>;

  if (rows.length > 0) {
    return rows.reverse().map(rowToEntry);
  }

  return readRecentAuditEntriesFromJsonl({ agent }, limit);
}

export function readRecentForTask(taskId: string): AuditEntry[] {
  const rows = getDb().prepare(`
    SELECT * FROM audit_log WHERE task_id = ? ORDER BY ts ASC
  `).all(taskId) as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    return rows.map(rowToEntry);
  }

  return readRecentAuditEntriesFromJsonl({ taskId }, Number.MAX_SAFE_INTEGER);
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
