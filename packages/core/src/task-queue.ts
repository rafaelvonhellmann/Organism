// Uses Node.js built-in sqlite (available in Node 22.5+, no native compilation).
// node:sqlite docs: https://nodejs.org/api/sqlite.html

import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Task, TaskStatus, RiskLane } from '../../shared/src/types.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';

const DB_PATH = path.resolve(process.cwd(), 'state/tasks.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  runMigrations(_db);
  return _db;
}

function runMigrations(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      lane TEXT NOT NULL,
      description TEXT NOT NULL,
      input TEXT,
      input_hash TEXT,
      output TEXT,
      tokens_used INTEGER,
      cost_usd REAL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      parent_task_id TEXT,
      project_id TEXT NOT NULL DEFAULT 'organism',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent TEXT NOT NULL,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT,
      outcome TEXT NOT NULL,
      error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_spend (
      agent TEXT NOT NULL,
      date TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'organism',
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      PRIMARY KEY (agent, date, project_id)
    );

    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      gate TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      reason TEXT,
      decided_at INTEGER,
      patch_path TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS shadow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      task_id TEXT NOT NULL,
      output TEXT,
      quality_score REAL,
      ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent);
    CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
  `);

  // Additive migrations for existing databases — safe to re-run (errors caught and ignored)
  const additiveMigrations = [
    `ALTER TABLE tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT 'organism'`,
    `ALTER TABLE agent_spend ADD COLUMN project_id TEXT NOT NULL DEFAULT 'organism'`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`,
  ];
  for (const sql of additiveMigrations) {
    try { db.exec(sql); } catch { /* column/index already exists — safe to ignore */ }
  }
}

export function createTask(params: {
  agent: string;
  lane: RiskLane;
  description: string;
  input: unknown;
  parentTaskId?: string;
  projectId?: string;
}): Task {
  const db = getDb();
  const id = crypto.randomUUID();
  const inputJson = JSON.stringify(params.input);
  // Include description in hash so same-agent + same-input but different-description tasks are allowed
  const inputHash = crypto.createHash('sha256').update(params.description + '::' + inputJson).digest('hex');
  const projectId = params.projectId ?? 'organism';

  // Duplicate detection: same agent + same input hash + same project within last 24h
  const existing = db.prepare(`
    SELECT id FROM tasks
    WHERE agent = ? AND input_hash = ? AND project_id = ? AND created_at > ?
    AND status NOT IN ('failed', 'rolled_back')
    LIMIT 1
  `).get(params.agent, inputHash, projectId, Date.now() - 86_400_000) as { id: string } | undefined;

  if (existing) {
    throw new Error(
      `Duplicate task detected (existing: ${existing.id}). Code: ${OrganismError.TASK_CHECKOUT_CONFLICT}`
    );
  }

  db.prepare(`
    INSERT INTO tasks (id, agent, status, lane, description, input, input_hash, parent_task_id, project_id)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(id, params.agent, params.lane, params.description, inputJson, inputHash, params.parentTaskId ?? null, projectId);

  return getTask(id)!;
}

// Atomic checkout — returns null if task already taken
export function checkoutTask(taskId: string, agent: string): Task | null {
  const db = getDb();
  const result = db.prepare(`
    UPDATE tasks SET status = 'in_progress', agent = ?, started_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(agent, Date.now(), taskId);

  if ((result as { changes: number }).changes === 0) return null;
  return getTask(taskId);
}

export function completeTask(taskId: string, output: unknown, tokensUsed: number, costUsd: number): void {
  getDb().prepare(`
    UPDATE tasks SET status = 'completed', output = ?, tokens_used = ?, cost_usd = ?, completed_at = ?
    WHERE id = ?
  `).run(JSON.stringify(output), tokensUsed, costUsd, Date.now(), taskId);
}

export function failTask(taskId: string, error: string): void {
  getDb().prepare(`
    UPDATE tasks SET status = 'failed', error = ?, completed_at = ?
    WHERE id = ?
  `).run(error, Date.now(), taskId);
}

export function reapDeadLetters(maxAgeMs = 30 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = getDb().prepare(`
    UPDATE tasks SET status = 'dead_letter', error = 'No heartbeat for >30 minutes'
    WHERE status = 'in_progress' AND started_at < ?
  `).run(cutoff);
  return (result as { changes: number }).changes;
}

export function getTask(id: string): Task | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTask(row);
}

export function getPendingTasks(agent?: string, projectId?: string): Task[] {
  const db = getDb();
  let rows: unknown[];
  if (agent && projectId) {
    rows = db.prepare('SELECT * FROM tasks WHERE status = ? AND agent = ? AND project_id = ? ORDER BY created_at ASC').all('pending', agent, projectId);
  } else if (agent) {
    rows = db.prepare('SELECT * FROM tasks WHERE status = ? AND agent = ? ORDER BY created_at ASC').all('pending', agent);
  } else if (projectId) {
    rows = db.prepare('SELECT * FROM tasks WHERE status = ? AND project_id = ? ORDER BY created_at ASC').all('pending', projectId);
  } else {
    rows = db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC").all();
  }
  return (rows as Record<string, unknown>[]).map(rowToTask);
}

export function getDeadLetterTasks(): Task[] {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE status = 'dead_letter' ORDER BY created_at DESC")
    .all();
  return (rows as Record<string, unknown>[]).map(rowToTask);
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    agent: row.agent as string,
    status: row.status as TaskStatus,
    lane: row.lane as RiskLane,
    description: row.description as string,
    input: row.input ? JSON.parse(row.input as string) : null,
    inputHash: row.input_hash as string,
    output: row.output ? JSON.parse(row.output as string) : undefined,
    tokensUsed: row.tokens_used as number | undefined,
    costUsd: row.cost_usd as number | undefined,
    startedAt: row.started_at as number | undefined,
    completedAt: row.completed_at as number | undefined,
    error: row.error as string | undefined,
    parentTaskId: row.parent_task_id as string | undefined,
    projectId: (row.project_id as string | undefined) ?? 'organism',
  };
}
