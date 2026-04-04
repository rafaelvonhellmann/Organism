import * as fs from 'fs';
import * as path from 'path';
import { AuditEntry } from './types.js';

const AUDIT_LOG_PATH = path.resolve(process.cwd(), 'state/audit.log');

function ensureAuditDir() {
  const dir = path.dirname(AUDIT_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Structured JSON log to stdout + append to audit.log
export function log(entry: Omit<AuditEntry, 'ts'>) {
  const full: AuditEntry = { ...entry, ts: Date.now() };
  const line = JSON.stringify(full);
  console.log(line);
  try {
    ensureAuditDir();
    fs.appendFileSync(AUDIT_LOG_PATH, line + '\n');
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
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .map((l) => { try { return JSON.parse(l) as AuditEntry; } catch { return null; } })
      .filter((e): e is AuditEntry => e !== null && e.agent === agent)
      .slice(-limit);
  } catch {
    return [];
  }
}
