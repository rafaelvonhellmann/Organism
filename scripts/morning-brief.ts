/**
 * morning-brief.ts — Structured system state summary.
 *
 * Usage: pnpm morning-brief
 * Or:    tsx --experimental-sqlite scripts/morning-brief.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../packages/core/src/task-queue.js';
import { getPendingTasks, getDeadLetterTasks } from '../packages/core/src/task-queue.js';
import { getSpendSummary, getSystemSpend } from '../packages/core/src/budget.js';
import { getPendingG4Gates } from '../packages/core/src/gates.js';

const SYSTEM_DAILY_CAP = parseFloat(process.env.SYSTEM_DAILY_CAP_USD ?? '50');
const LESSONS_PATH = path.resolve(process.cwd(), 'knowledge/lessons.md');

// --- Helpers ---

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function tsToTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function msSince(ts: number): string {
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m ago`;
  return `${m}m ago`;
}

// --- Data readers ---

interface TaskCounts {
  completed: number;
  pending: number;
  failed: number;
  deadLetters: number;
}

function getTaskCountsToday(): TaskCounts {
  const db = getDb();
  const today = todayStr();
  const todayStartMs = new Date(today).getTime();

  const completed = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE status = 'completed' AND completed_at >= ?"
  ).get(todayStartMs) as { n: number }).n;

  const pending = getPendingTasks().length;

  const failed = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE status = 'failed' AND completed_at >= ?"
  ).get(todayStartMs) as { n: number }).n;

  const deadLetters = getDeadLetterTasks().length;

  return { completed, pending, failed, deadLetters };
}

interface LaneCounts {
  LOW: number;
  MEDIUM: number;
  HIGH: number;
  pendingHigh: number;
}

function getLaneCounts(): LaneCounts {
  const db = getDb();
  const today = todayStr();
  const todayStartMs = new Date(today).getTime();

  const low = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE lane = 'LOW' AND status = 'completed' AND completed_at >= ?"
  ).get(todayStartMs) as { n: number }).n;

  const medium = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE lane = 'MEDIUM' AND status = 'completed' AND completed_at >= ?"
  ).get(todayStartMs) as { n: number }).n;

  const high = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE lane = 'HIGH' AND status = 'completed' AND completed_at >= ?"
  ).get(todayStartMs) as { n: number }).n;

  // HIGH tasks pending G4 approval = pending tasks in HIGH lane
  const pendingHigh = (db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE lane = 'HIGH' AND status = 'pending'"
  ).get() as { n: number }).n;

  return { LOW: low, MEDIUM: medium, HIGH: high, pendingHigh };
}

function getLastLessons(n = 3): string[] {
  if (!fs.existsSync(LESSONS_PATH)) return ['(no lessons.md found)'];
  const content = fs.readFileSync(LESSONS_PATH, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

// --- Brief renderer ---

function renderBrief(): void {
  const date = new Date().toISOString().slice(0, 10);
  const line = (s = '') => console.log(s);

  line(`=== Organism Morning Brief — ${date} ===`);
  line();

  // SYSTEM STATUS
  line('SYSTEM STATUS');
  const counts = getTaskCountsToday();
  line('  Uptime: fresh start');
  line(
    `  Total tasks today: ${counts.completed} completed, ${counts.pending} pending, ` +
    `${counts.failed} failed, ${counts.deadLetters} dead letters`
  );
  line();

  // AGENT SPEND
  line('AGENT SPEND (today)');
  const spendRows = getSpendSummary();
  if (spendRows.length === 0) {
    line('  (no spend recorded today)');
  } else {
    for (const row of spendRows) {
      const bar = `${pad(row.agent, 26)} $${fmt(row.spent)} / $${fmt(row.cap)} (${row.pct.toFixed(0)}%)`;
      line(`  ${bar}`);
    }
  }
  const systemTotal = getSystemSpend();
  line(`  System total: $${fmt(systemTotal)} / $${fmt(SYSTEM_DAILY_CAP)}`);
  line();

  // PIPELINE HEALTH
  line('PIPELINE HEALTH');
  const lanes = getLaneCounts();
  line(`  LOW lane:    ${lanes.LOW} tasks completed`);
  line(`  MEDIUM lane: ${lanes.MEDIUM} tasks completed`);
  const highLine = lanes.pendingHigh > 0
    ? `${lanes.HIGH} tasks completed (${lanes.pendingHigh} pending G4 approval)`
    : `${lanes.HIGH} tasks completed`;
  line(`  HIGH lane:   ${highLine}`);
  line();

  // DEAD LETTERS
  line('DEAD LETTERS (requires attention)');
  const deadLetters = getDeadLetterTasks();
  if (deadLetters.length === 0) {
    line('  (none)');
  } else {
    for (const task of deadLetters) {
      const since = task.startedAt ? msSince(task.startedAt) : 'unknown';
      line(`  ${task.id.slice(0, 8)}: ${task.description.slice(0, 60)} — stuck since ${since}`);
    }
  }
  line();

  // PENDING G4 GATES
  line('PENDING G4 GATES');
  let gates: ReturnType<typeof getPendingG4Gates>;
  try {
    gates = getPendingG4Gates();
  } catch {
    gates = [];
  }
  if (gates.length === 0) {
    line('  (none)');
  } else {
    for (const gate of gates) {
      const db = getDb();
      const task = db.prepare('SELECT description FROM tasks WHERE id = ?').get(gate.taskId) as { description: string } | undefined;
      const desc = task?.description?.slice(0, 60) ?? '(unknown task)';
      line(`  ${gate.id.slice(0, 8)}: ${desc} — waiting for Rafael approval`);
    }
  }
  line();

  // LESSONS REMINDER
  line('LESSONS REMINDER');
  const lessons = getLastLessons(3);
  for (const lesson of lessons) {
    line(`  ${lesson}`);
  }
  line();

  line('=== End of Brief ===');
}

// --- Entry point ---

try {
  renderBrief();
} catch (err) {
  console.error('[morning-brief] Error generating brief:', err);
  process.exit(1);
}
