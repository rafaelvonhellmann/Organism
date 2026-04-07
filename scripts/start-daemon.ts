/**
 * start-daemon.ts — Main entry point for running Organism autonomously.
 *
 * Usage: pnpm start
 * Or:    tsx --experimental-sqlite scripts/start-daemon.ts
 *
 * Lifecycle cycles:
 *   - Agent runner: polls every DAEMON_POLL_MS (10s) for pending tasks
 *   - Scheduler: ticks every SCHEDULER_TICK_MS (60s) for frequency-tier dispatch
 *   - Execute cycle: every 3h — checks for approved action items, executes ready tasks
 *   - Sync cycle: every 6h — pushes local state to Turso
 *   - Review cycle: daily at configured hour — runs full project review if scheduled
 *
 * Daemon status is persisted to state/daemon-status.json for dashboard consumption.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { requireSecrets } from '../packages/shared/src/secrets.js';
import { getDb } from '../packages/core/src/task-queue.js';
import { loadRegistry } from '../packages/core/src/registry.js';
import { startScheduler } from '../packages/core/src/scheduler.js';
import { startDaemon, dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { isRateLimited, getRateLimitStatus } from '../agents/_base/mcp-client.js';
import dashboardServer from '../packages/dashboard/src/server.js';

const VERSION = '0.2.0';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '7391');
const DAEMON_POLL_MS = 10_000;   // 10 seconds — agent runner polling interval
const SCHEDULER_TICK_MS = 60_000; // 60 seconds — scheduler tick interval

// ── Daemon config ─────────────────────────────────────────────────────────

const DAEMON_CONFIG = {
  /** How often to check for approved action items and execute ready tasks */
  executeIntervalMs: 3 * 60 * 60 * 1000,   // 3 hours
  /** How often to sync local state to Turso */
  syncIntervalMs: 6 * 60 * 60 * 1000,       // 6 hours
  /** Hour (0-23) to run the daily review cycle (local time) */
  reviewHour: 3,                             // 3 AM daily
  /** Cron-style reference (not parsed — for documentation only) */
  reviewSchedule: '0 3 * * *',
  /** Master switch — if false, lifecycle cycles are skipped (base polling still runs) */
  enabled: true,
};

// ── Daemon status tracking ────────────────────────────────────────────────

interface DaemonStatus {
  startedAt: string;
  lastExecuteCycle: string | null;
  nextExecuteCycle: string | null;
  lastSyncCycle: string | null;
  nextSyncCycle: string | null;
  lastReviewCycle: string | null;
  nextReviewCycle: string | null;
  itemsExecutedSinceRestart: number;
  itemsSyncedSinceRestart: number;
  reviewsRunSinceRestart: number;
  rateLimitStatus: {
    limited: boolean;
    resetsAt: string | null;
    usagePct: number;
  };
  config: typeof DAEMON_CONFIG;
  version: string;
}

const STATE_DIR = path.resolve(process.cwd(), 'state');
const STATUS_FILE = path.join(STATE_DIR, 'daemon-status.json');

const daemonState = {
  startedAt: new Date().toISOString(),
  lastExecuteCycleMs: 0,
  lastSyncCycleMs: 0,
  lastReviewCycleMs: 0,
  lastReviewDate: '',  // YYYY-MM-DD — prevents running review twice in one day
  itemsExecuted: 0,
  itemsSynced: 0,
  reviewsRun: 0,
};

function computeNextCycle(lastMs: number, intervalMs: number): string | null {
  if (lastMs === 0) {
    // First cycle runs after one interval from daemon start
    return new Date(Date.parse(daemonState.startedAt) + intervalMs).toISOString();
  }
  return new Date(lastMs + intervalMs).toISOString();
}

function computeNextReview(): string | null {
  const now = new Date();
  const next = new Date(now);
  next.setHours(DAEMON_CONFIG.reviewHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

function buildStatus(): DaemonStatus {
  const rlStatus = getRateLimitStatus();
  return {
    startedAt: daemonState.startedAt,
    lastExecuteCycle: daemonState.lastExecuteCycleMs ? new Date(daemonState.lastExecuteCycleMs).toISOString() : null,
    nextExecuteCycle: computeNextCycle(daemonState.lastExecuteCycleMs, DAEMON_CONFIG.executeIntervalMs),
    lastSyncCycle: daemonState.lastSyncCycleMs ? new Date(daemonState.lastSyncCycleMs).toISOString() : null,
    nextSyncCycle: computeNextCycle(daemonState.lastSyncCycleMs, DAEMON_CONFIG.syncIntervalMs),
    lastReviewCycle: daemonState.lastReviewCycleMs ? new Date(daemonState.lastReviewCycleMs).toISOString() : null,
    nextReviewCycle: computeNextReview(),
    itemsExecutedSinceRestart: daemonState.itemsExecuted,
    itemsSyncedSinceRestart: daemonState.itemsSynced,
    reviewsRunSinceRestart: daemonState.reviewsRun,
    rateLimitStatus: {
      limited: rlStatus.limited,
      resetsAt: rlStatus.resetsAt ? new Date(rlStatus.resetsAt).toISOString() : null,
      usagePct: rlStatus.usagePct,
    },
    config: DAEMON_CONFIG,
    version: VERSION,
  };
}

function persistStatus(): void {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(buildStatus(), null, 2));
  } catch (err) {
    console.error('[Lifecycle] Failed to write daemon status:', err);
  }
}

// ── Execute cycle: approved action items + pending tasks ──────────────────

async function runExecuteCycle(): Promise<void> {
  if (!DAEMON_CONFIG.enabled) return;
  if (isRateLimited()) {
    console.log('[Lifecycle] Execute cycle skipped — rate limited');
    return;
  }

  const now = Date.now();
  const elapsed = now - (daemonState.lastExecuteCycleMs || Date.parse(daemonState.startedAt));
  if (elapsed < DAEMON_CONFIG.executeIntervalMs) return;

  console.log(`[Lifecycle] Execute cycle starting at ${new Date().toISOString()}`);

  // 1. Check local DB for approved action items (status = 'in_progress' in the tasks table)
  //    The action_items table lives on Turso (dashboard-owned), so we look at the local
  //    tasks table for tasks that are ready to execute.
  try {
    const dispatched = await dispatchPendingTasks();
    daemonState.itemsExecuted += dispatched;
    console.log(`[Lifecycle] Execute cycle complete — dispatched ${dispatched} task(s)`);
  } catch (err) {
    console.error('[Lifecycle] Execute cycle error:', err);
  }

  daemonState.lastExecuteCycleMs = Date.now();
  persistStatus();
}

// ── Sync cycle: push to Turso ─────────────────────────────────────────────

function loadTursoEnv(): { url: string; token: string } | null {
  // Check environment first
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    return { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  }

  // Fall back to dashboard-v2 env file
  const envFile = path.resolve(process.cwd(), 'packages/dashboard-v2/.env.production.local');
  if (!fs.existsSync(envFile)) return null;

  const env: Record<string, string> = {};
  const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+)="(.+)"$/);
    if (match) env[match[1]] = match[2];
  }

  if (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN) {
    return { url: env.TURSO_DATABASE_URL, token: env.TURSO_AUTH_TOKEN };
  }
  return null;
}

async function runSyncCycle(): Promise<void> {
  if (!DAEMON_CONFIG.enabled) return;

  const now = Date.now();
  const elapsed = now - (daemonState.lastSyncCycleMs || Date.parse(daemonState.startedAt));
  if (elapsed < DAEMON_CONFIG.syncIntervalMs) return;

  console.log(`[Lifecycle] Sync cycle starting at ${new Date().toISOString()}`);

  const tursoEnv = loadTursoEnv();
  if (!tursoEnv) {
    console.warn('[Lifecycle] Sync cycle skipped — no Turso credentials found');
    daemonState.lastSyncCycleMs = Date.now();
    persistStatus();
    return;
  }

  const LOCAL_DB_PATH = path.resolve(process.cwd(), 'state', 'tasks.db');
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.warn('[Lifecycle] Sync cycle skipped — local DB not found');
    daemonState.lastSyncCycleMs = Date.now();
    persistStatus();
    return;
  }

  try {
    const { createClient } = await import('@libsql/client');
    const local = new DatabaseSync(LOCAL_DB_PATH, { open: true });
    local.exec('PRAGMA journal_mode=WAL');

    let url = tursoEnv.url;
    if (url.startsWith('libsql://')) {
      url = 'https://' + url.slice('libsql://'.length);
    }
    const remote = createClient({ url, authToken: tursoEnv.token });

    // Sync tasks table (the most important one for dashboard)
    const TASK_COLS = [
      'id', 'agent', 'status', 'lane', 'description', 'input', 'input_hash',
      'output', 'tokens_used', 'cost_usd', 'started_at', 'completed_at',
      'error', 'parent_task_id', 'project_id', 'created_at',
    ];

    const rows = local.prepare(`SELECT ${TASK_COLS.join(',')} FROM tasks`).all() as Record<string, unknown>[];

    if (rows.length > 0) {
      await remote.execute('DELETE FROM tasks');

      const chunkSize = 50;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const placeholders = TASK_COLS.map(() => '?').join(',');
        const valuesSql = chunk.map(() => `(${placeholders})`).join(',');
        const args = chunk.flatMap(row => TASK_COLS.map(col => {
          const val = row[col];
          if (val === undefined || val === null) return null;
          if (typeof val === 'bigint') return Number(val);
          return val;
        }));

        await remote.execute({
          sql: `INSERT INTO tasks (${TASK_COLS.join(',')}) VALUES ${valuesSql}`,
          args: args as Array<string | number | null>,
        });
      }
    }

    // Sync agent_spend
    const spendCols = ['agent', 'date', 'project_id', 'tokens_in', 'tokens_out', 'cost_usd'];
    const spends = local.prepare(`SELECT ${spendCols.join(',')} FROM agent_spend`).all() as Record<string, unknown>[];
    if (spends.length > 0) {
      await remote.execute('DELETE FROM agent_spend');
      const stmts = spends.map(s => ({
        sql: `INSERT OR REPLACE INTO agent_spend (${spendCols.join(',')}) VALUES (?, ?, ?, ?, ?, ?)`,
        args: spendCols.map(col => {
          const val = s[col];
          if (val === undefined || val === null) return null;
          if (typeof val === 'bigint') return Number(val);
          return val;
        }) as Array<string | number | null>,
      }));
      await remote.batch(stmts, 'write');
    }

    // Sync audit_log
    const auditCols = ['id', 'ts', 'agent', 'task_id', 'action', 'payload', 'outcome', 'error_code'];
    const audits = local.prepare(`SELECT ${auditCols.join(',')} FROM audit_log`).all() as Record<string, unknown>[];
    if (audits.length > 0) {
      await remote.execute('DELETE FROM audit_log');
      const chunkSize = 50;
      for (let i = 0; i < audits.length; i += chunkSize) {
        const chunk = audits.slice(i, i + chunkSize);
        const stmts = chunk.map(a => ({
          sql: `INSERT INTO audit_log (${auditCols.join(',')}) VALUES (${auditCols.map(() => '?').join(',')})`,
          args: auditCols.map(col => {
            const val = a[col];
            if (val === undefined || val === null) return null;
            if (typeof val === 'bigint') return Number(val);
            return val;
          }) as Array<string | number | null>,
        }));
        await remote.batch(stmts, 'write');
      }
    }

    // Sync gates
    const gateCols = ['id', 'task_id', 'gate', 'decision', 'decided_by', 'reason', 'decided_at', 'patch_path', 'created_at'];
    const gates = local.prepare(`SELECT ${gateCols.join(',')} FROM gates`).all() as Record<string, unknown>[];
    if (gates.length > 0) {
      await remote.execute('DELETE FROM gates');
      const chunkSize = 50;
      for (let i = 0; i < gates.length; i += chunkSize) {
        const chunk = gates.slice(i, i + chunkSize);
        const stmts = chunk.map(g => ({
          sql: `INSERT OR REPLACE INTO gates (${gateCols.join(',')}) VALUES (${gateCols.map(() => '?').join(',')})`,
          args: gateCols.map(col => {
            const val = g[col];
            if (val === undefined || val === null) return null;
            if (typeof val === 'bigint') return Number(val);
            return val;
          }) as Array<string | number | null>,
        }));
        await remote.batch(stmts, 'write');
      }
    }

    daemonState.itemsSynced += rows.length;
    remote.close();
    local.close();
    console.log(`[Lifecycle] Sync cycle complete — ${rows.length} tasks, ${spends.length} spend entries, ${audits.length} audit entries, ${gates.length} gates`);
  } catch (err) {
    console.error('[Lifecycle] Sync cycle error:', err);
  }

  daemonState.lastSyncCycleMs = Date.now();
  persistStatus();
}

// ── Review cycle: daily full project review ───────────────────────────────

async function runReviewCycle(): Promise<void> {
  if (!DAEMON_CONFIG.enabled) return;
  if (isRateLimited()) {
    console.log('[Lifecycle] Review cycle skipped — rate limited');
    return;
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Only run once per day, at the configured hour
  if (daemonState.lastReviewDate === todayStr) return;
  if (now.getHours() !== DAEMON_CONFIG.reviewHour) return;

  console.log(`[Lifecycle] Review cycle starting at ${now.toISOString()}`);

  try {
    // Dispatch pending tasks (the scheduler's frequency-tier logic handles
    // which agents are due for daily/weekly/monthly reviews)
    const dispatched = await dispatchPendingTasks();
    daemonState.reviewsRun++;
    daemonState.lastReviewDate = todayStr;
    console.log(`[Lifecycle] Review cycle complete — dispatched ${dispatched} task(s)`);
  } catch (err) {
    console.error('[Lifecycle] Review cycle error:', err);
  }

  daemonState.lastReviewCycleMs = Date.now();
  persistStatus();
}

// ── Lifecycle tick — runs every 60s, checks if any cycle is due ───────────

async function lifecycleTick(): Promise<void> {
  try {
    await runExecuteCycle();
    await runSyncCycle();
    await runReviewCycle();
  } catch (err) {
    console.error('[Lifecycle] Tick error:', err);
  }
}

// --- Health check ---

function runHealthCheck(): void {
  console.log('\n=== Organism Health Check ===\n');

  let allOk = true;

  // LLM access — agents use `claude -p` CLI, so ANTHROPIC_API_KEY is optional
  process.stdout.write('LLM access: ');
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('OK (API key set — can use direct API)');
  } else {
    console.log('OK (using claude CLI — no API key needed)');
  }

  // State directory
  process.stdout.write('State directory: ');
  const stateDir = path.resolve(process.cwd(), 'state');
  if (fs.existsSync(stateDir)) {
    console.log('OK');
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
    console.log('Created');
  }

  // Database + migrations
  process.stdout.write('Database (tasks.db): ');
  try {
    const db = getDb(); // getDb() runs runMigrations() internally
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (row) {
      console.log('OK');
    } else {
      console.log('FAIL — tasks table missing after migration');
      allOk = false;
    }
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  // Capability registry
  process.stdout.write('Capability registry: ');
  const registryPath = path.resolve(process.cwd(), 'knowledge/capability-registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { capabilities: Array<{ status: string }> };
      const activeCount = reg.capabilities.filter((c) => c.status === 'active').length;
      console.log(`OK (${activeCount} active agents)`);
    } catch {
      console.log('FAIL — invalid JSON');
      allOk = false;
    }
  } else {
    console.log('FAIL — file not found');
    allOk = false;
  }

  // Turso credentials (optional)
  process.stdout.write('Turso credentials: ');
  const tursoEnv = loadTursoEnv();
  console.log(tursoEnv ? 'Present' : 'Missing — sync cycle will not function');

  // OpenAI (optional)
  process.stdout.write('OpenAI API key (optional): ');
  console.log(process.env.OPENAI_API_KEY ? 'Present' : 'Missing — Codex Review will not function');

  console.log('');

  if (!allOk) {
    console.error('Health check failed. Fix the issues above before running Organism.');
    process.exit(1);
  }
  console.log('Health check passed.\n');
}

// --- Startup banner ---

function printBanner(): void {
  const capabilities = loadRegistry();
  const activeAgents = capabilities.filter((c) => c.status === 'active').map((c) => c.owner);
  const shadowAgents = capabilities.filter((c) => c.status === 'shadow').map((c) => c.owner);
  const uniqueActive = [...new Set(activeAgents)];
  const uniqueShadow = [...new Set(shadowAgents)];

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║            O R G A N I S M                  ║');
  console.log(`║  Autonomous Multi-Agent Company  v${VERSION}      ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Started:    ${new Date().toISOString()}`);
  console.log(`  Dashboard:  http://localhost:${DASHBOARD_PORT}`);
  console.log(`  Active agents (${uniqueActive.length}): ${uniqueActive.join(', ') || 'none'}`);
  console.log(`  Shadow agents (${uniqueShadow.length}): ${uniqueShadow.join(', ') || 'none'}`);
  console.log('');
  console.log('  Lifecycle cycles:');
  console.log(`    Execute:  every ${DAEMON_CONFIG.executeIntervalMs / (60 * 60 * 1000)}h`);
  console.log(`    Sync:     every ${DAEMON_CONFIG.syncIntervalMs / (60 * 60 * 1000)}h`);
  console.log(`    Review:   daily at ${DAEMON_CONFIG.reviewHour}:00 (${DAEMON_CONFIG.reviewSchedule})`);
  console.log(`    Enabled:  ${DAEMON_CONFIG.enabled}`);
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  // 1. Health check — exits if critical secrets missing
  runHealthCheck();

  // 2. Startup banner
  printBanner();

  // 3. Dashboard is started by importing the server module (it calls server.listen() on import)
  //    Port is already logged by the dashboard module. Just confirm here.
  console.log(`[Daemon] Dashboard running on port ${DASHBOARD_PORT}`);

  // 4. Migrations already run inside getDb() (called during health check above).
  console.log('[Daemon] Database migrations OK');

  // 5. Start scheduler (60s tick)
  const schedulerHandle = startScheduler(SCHEDULER_TICK_MS);
  console.log(`[Daemon] Scheduler started (tick: ${SCHEDULER_TICK_MS / 1000}s)`);

  // 6. Start agent runner daemon (10s poll)
  const daemonHandle = startDaemon(DAEMON_POLL_MS);
  console.log(`[Daemon] Agent runner started (poll: ${DAEMON_POLL_MS / 1000}s)`);

  // 7. Start lifecycle ticker (checks every 60s if any cycle is due)
  const lifecycleHandle = setInterval(() => {
    lifecycleTick().catch(console.error);
  }, 60_000);
  console.log('[Daemon] Lifecycle manager started (execute: 3h, sync: 6h, review: daily)');

  // 8. Write initial daemon status
  persistStatus();
  console.log(`[Daemon] Status file: ${STATUS_FILE}`);

  // 9. Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\n[Daemon] Received ${signal} — shutting down gracefully...`);
    clearInterval(schedulerHandle);
    clearInterval(daemonHandle);
    clearInterval(lifecycleHandle);
    persistStatus(); // Write final status before exit
    dashboardServer.close(() => {
      console.log('[Daemon] Dashboard closed.');
    });
    console.log('[Daemon] Organism stopped. Goodbye.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 10. Ready message
  console.log('\nOrganism is running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('[Daemon] Fatal startup error:', err);
  process.exit(1);
});
