import * as fs from 'fs';
import * as path from 'path';
import { STATE_DIR } from './state-dir.js';
import { AuditEntry } from './types.js';

export const AUDIT_LOG_PATH = path.join(STATE_DIR, 'audit.log');

function ensureAuditLogDir(): void {
  fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
}

export function appendAuditJsonl(entry: AuditEntry): void {
  ensureAuditLogDir();
  fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

export function readRecentAuditEntriesFromJsonl(
  filter: { agent?: string; taskId?: string },
  limit = 5,
): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];

    const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);

    const entries: AuditEntry[] = [];
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]!) as AuditEntry;
        if (filter.agent && parsed.agent !== filter.agent) continue;
        if (filter.taskId && parsed.taskId !== filter.taskId) continue;
        entries.push(parsed);
      } catch {
        // Ignore malformed historical log lines and continue scanning backwards.
      }
    }

    return entries.reverse();
  } catch {
    return [];
  }
}
