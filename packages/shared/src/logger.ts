import { AuditEntry } from './types.js';
import { appendAuditJsonl, readRecentAuditEntriesFromJsonl } from './audit-log.js';

// Structured JSON log to stdout + append to audit.log
export function log(entry: Omit<AuditEntry, 'ts'>) {
  const full: AuditEntry = { ...entry, ts: Date.now() };
  const line = JSON.stringify(full);
  console.log(line);
  try {
    appendAuditJsonl(full);
  } catch {
    // Never crash the agent because logging failed
  }
}

export function logError(
  agent: string,
  taskId: string,
  errorCode: string,
  message: string,
  context?: unknown
) {
  log({
    agent,
    taskId,
    action: 'error',
    payload: { errorCode, message, context },
    outcome: 'failure',
    errorCode,
  });
}

export function logMcpCall(
  agent: string,
  taskId: string,
  tool: string,
  args: unknown,
  outcome: 'success' | 'failure' | 'blocked',
  result?: unknown
) {
  log({
    agent,
    taskId,
    action: 'mcp_call',
    payload: { tool, args, result },
    outcome,
  });
}

// Read the last N audit entries for a given agent (for session start context)
export function readRecentAuditEntries(agent: string, limit = 5): AuditEntry[] {
  return readRecentAuditEntriesFromJsonl({ agent }, limit);
}
