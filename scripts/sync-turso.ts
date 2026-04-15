/**
 * sync-turso.ts — Push local SQLite state to Turso cloud
 *
 * Usage:
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
 *   tsx --experimental-sqlite scripts/sync-turso.ts
 *
 * Reads from state/tasks.db (local) and writes to Turso (cloud).
 * Full refresh: creates tables if needed, then upserts all rows.
 * Safe to run repeatedly — idempotent.
 */

import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { DB_PATH as LOCAL_DB_PATH } from '../packages/shared/src/state-dir.js';

async function main() {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (!tursoUrl || !tursoToken) {
    console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
    process.exit(1);
  }

  if (!existsSync(LOCAL_DB_PATH)) {
    console.error(`Local DB not found at ${LOCAL_DB_PATH}`);
    process.exit(1);
  }

  const local = new DatabaseSync(LOCAL_DB_PATH, { open: true });
  local.exec('PRAGMA journal_mode=WAL');

  const remote = createClient({ url: tursoUrl, authToken: tursoToken });

  console.log('Connected to local DB and Turso');

  // ── Create tables in Turso ────────────────────────────────────
  await remote.executeMultiple(`
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
      created_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shadow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      task_id TEXT NOT NULL,
      output TEXT,
      quality_score REAL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS innovation_radar_feedback (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      opportunity_title TEXT,
      feedback_code TEXT NOT NULL,
      notes TEXT,
      trigger TEXT,
      created_by TEXT NOT NULL DEFAULT 'rafael',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent);
    CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_innovation_feedback_project ON innovation_radar_feedback(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_innovation_feedback_task ON innovation_radar_feedback(task_id);
  `);

  console.log('Schema ensured');

  // ── Sync each table ───────────────────────────────────────────

  await syncTable(local, remote, 'tasks', 'id', [
    'id', 'agent', 'status', 'lane', 'description', 'input', 'input_hash',
    'output', 'tokens_used', 'cost_usd', 'started_at', 'completed_at',
    'error', 'parent_task_id', 'project_id', 'created_at',
  ]);

  await syncTable(local, remote, 'audit_log', 'id', [
    'id', 'ts', 'agent', 'task_id', 'action', 'payload', 'outcome', 'error_code',
  ]);

  await syncTable(local, remote, 'agent_spend', null, [
    'agent', 'date', 'project_id', 'tokens_in', 'tokens_out', 'cost_usd',
  ]);

  await syncTable(local, remote, 'gates', 'id', [
    'id', 'task_id', 'gate', 'decision', 'decided_by', 'reason',
    'decided_at', 'patch_path', 'created_at',
  ]);

  await syncTable(local, remote, 'shadow_runs', 'id', [
    'id', 'agent', 'task_id', 'output', 'quality_score', 'ts',
  ]);

  await syncTable(local, remote, 'innovation_radar_feedback', 'id', [
    'id', 'task_id', 'project_id', 'opportunity_title', 'feedback_code',
    'notes', 'trigger', 'created_by', 'created_at',
  ]);

  console.log('\nSync complete!');
  local.close();
}

async function syncTable(
  local: DatabaseSync,
  remote: ReturnType<typeof createClient>,
  table: string,
  _pk: string | null,
  columns: string[],
) {
  const rows = local.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Record<string, unknown>[];
  console.log(`\n${table}: ${rows.length} rows`);

  if (rows.length === 0) return;

  // Clear remote table and reinsert (full refresh)
  await remote.execute(`DELETE FROM ${table}`);

  // Batch insert in chunks of 50
  const chunkSize = 50;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = columns.map(() => '?').join(',');
    const valuesSql = chunk.map(() => `(${placeholders})`).join(',');
    const args = chunk.flatMap(row => columns.map(col => {
      const val = row[col];
      if (val === undefined || val === null) return null;
      if (typeof val === 'bigint') return Number(val);
      return val;
    }));

    await remote.execute({
      sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${valuesSql}`,
      args: args as Array<string | number | null>,
    });

    process.stdout.write(`  synced ${Math.min(i + chunkSize, rows.length)}/${rows.length}\r`);
  }

  console.log(`  synced ${rows.length}/${rows.length} ✓`);
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
