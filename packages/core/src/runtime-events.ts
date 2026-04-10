import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './task-queue.js';
import { writeAudit } from './audit.js';
import { RuntimeEvent, RuntimeEventType } from '../../shared/src/types.js';
import { EVENTS_DIR, RUNTIME_EVENTS_LOG } from '../../shared/src/state-dir.js';

function ensureEventDir(): void {
  if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  }
}

export function recordRuntimeEvent(params: {
  runId: string;
  goalId: string;
  eventType: RuntimeEventType;
  payload: unknown;
  agent?: string;
}): RuntimeEvent {
  const db = getDb();
  const ts = Date.now();

  db.prepare(`
    INSERT INTO runtime_events (run_id, goal_id, event_type, payload, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(params.runId, params.goalId, params.eventType, JSON.stringify(params.payload), ts);

  const row = db.prepare(`
    SELECT * FROM runtime_events
    WHERE run_id = ? AND goal_id = ? AND event_type = ? AND ts = ?
    ORDER BY id DESC LIMIT 1
  `).get(params.runId, params.goalId, params.eventType, ts) as Record<string, unknown> | undefined;

  const event: RuntimeEvent = {
    id: Number(row?.id ?? 0),
    runId: params.runId,
    goalId: params.goalId,
    eventType: params.eventType,
    payload: params.payload,
    ts,
  };

  ensureEventDir();
  fs.appendFileSync(RUNTIME_EVENTS_LOG, JSON.stringify(event) + '\n');

  writeAudit({
    agent: params.agent ?? 'runtime',
    taskId: params.runId,
    action: 'runtime_event',
    payload: { goalId: params.goalId, eventType: params.eventType, payload: params.payload },
    outcome: 'success',
  });

  return event;
}

export function listRuntimeEvents(options: {
  runId?: string;
  goalId?: string;
  afterId?: number;
  limit?: number;
} = {}): RuntimeEvent[] {
  const db = getDb();
  const where: string[] = [];
  const args: Array<string | number> = [];

  if (options.runId) {
    where.push('run_id = ?');
    args.push(options.runId);
  }
  if (options.goalId) {
    where.push('goal_id = ?');
    args.push(options.goalId);
  }
  if (options.afterId) {
    where.push('id > ?');
    args.push(options.afterId);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit ?? 200;

  const rows = db.prepare(`
    SELECT * FROM runtime_events
    ${whereSql}
    ORDER BY id ASC
    LIMIT ?
  `).all(...args, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    runId: String(row.run_id),
    goalId: String(row.goal_id),
    eventType: row.event_type as RuntimeEventType,
    payload: row.payload ? JSON.parse(String(row.payload)) : null,
    ts: Number(row.ts),
  }));
}

export function getLatestRuntimeEventId(): number {
  const row = getDb().prepare('SELECT MAX(id) as id FROM runtime_events').get() as { id: number | null } | undefined;
  return Number(row?.id ?? 0);
}

export function clearRuntimeEventsForTests(): void {
  getDb().prepare('DELETE FROM runtime_events').run();
  if (fs.existsSync(RUNTIME_EVENTS_LOG)) {
    fs.rmSync(path.dirname(RUNTIME_EVENTS_LOG), { recursive: true, force: true });
  }
}
