/**
 * clear-stuck-tasks.ts — one-shot recovery tool.
 *
 * Marks orphaned in_progress, stale paused, and long-sitting awaiting_review
 * tasks as failed with a clear reason, so the runner stops resurrecting them
 * on every daemon restart.
 *
 * Usage:
 *   tsx --experimental-sqlite scripts/clear-stuck-tasks.ts [--older-than-hours N] [--dry-run]
 *
 * Defaults: 24h threshold, dry-run off (writes to DB).
 */

import { bootstrapRuntimeEnv } from '../packages/shared/src/runtime-env.js';
bootstrapRuntimeEnv();

import { getDb } from '../packages/core/src/task-queue.js';

interface StuckTask {
  id: string;
  agent: string;
  status: string;
  description: string;
  started_at: number | null;
  created_at: number;
}

const args = process.argv.slice(2);
const olderThanHours = Number.parseInt(
  args.find((a) => a.startsWith('--older-than-hours'))?.split('=')[1] ?? '24',
  10,
);
const dryRun = args.includes('--dry-run');

const thresholdMs = Date.now() - olderThanHours * 60 * 60 * 1000;

const db = getDb();

const stuckInProgress = db.prepare(`
  SELECT id, agent, status, description, started_at, created_at
  FROM tasks
  WHERE status = 'in_progress'
    AND COALESCE(started_at, created_at) < ?
`).all(thresholdMs) as unknown as StuckTask[];

const stalePaused = db.prepare(`
  SELECT id, agent, status, description, started_at, created_at
  FROM tasks
  WHERE status = 'paused'
    AND created_at < ?
`).all(thresholdMs) as unknown as StuckTask[];

const staleAwaitingReview = db.prepare(`
  SELECT id, agent, status, description, started_at, created_at
  FROM tasks
  WHERE status = 'awaiting_review'
    AND created_at < ?
`).all(thresholdMs) as unknown as StuckTask[];

const all = [...stuckInProgress, ...stalePaused, ...staleAwaitingReview];

console.log(`Stuck task audit (older than ${olderThanHours}h):`);
console.log(`  in_progress:      ${stuckInProgress.length}`);
console.log(`  paused:           ${stalePaused.length}`);
console.log(`  awaiting_review:  ${staleAwaitingReview.length}`);
console.log(`  total:            ${all.length}`);

if (all.length === 0) {
  console.log('\nNothing to clear.');
  process.exit(0);
}

for (const t of all) {
  const ageHours = ((Date.now() - (t.started_at ?? t.created_at)) / 3600000).toFixed(1);
  console.log(`  [${t.status}] ${t.agent} — ${t.description.slice(0, 80)} (${ageHours}h old)`);
}

if (dryRun) {
  console.log('\n--dry-run set. No writes.');
  process.exit(0);
}

const fail = db.prepare(`
  UPDATE tasks
  SET status = 'failed',
      error = COALESCE(error, '') || ' | manual_clear_stuck: cleared by clear-stuck-tasks.ts',
      completed_at = ?
  WHERE id = ?
`);

let failed = 0;
for (const t of all) {
  fail.run(Date.now(), t.id);
  failed += 1;
}

// Also mark the run_sessions tied to these tasks as failed so recovery doesn't
// resurrect them via the run_sessions path.
const failRuns = db.prepare(`
  UPDATE run_sessions
  SET status = 'failed',
      updated_at = ?,
      completed_at = ?
  WHERE status IN ('running', 'paused')
    AND updated_at < ?
`);
const runResult = failRuns.run(Date.now(), Date.now(), thresholdMs) as { changes: number };

console.log(`\nCleared ${failed} stuck task(s) and ${runResult.changes} orphaned run session(s).`);
