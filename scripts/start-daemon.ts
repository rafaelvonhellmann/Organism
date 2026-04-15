/**
 * start-daemon.ts — Main entry point for running Organism autonomously.
 *
 * Usage: pnpm start
 * Or:    tsx --experimental-sqlite scripts/start-daemon.ts
 *
 * Lifecycle cycles:
 *   - Agent runner: polls every DAEMON_POLL_MS (10s) for pending tasks
 *   - Scheduler: ticks every SCHEDULER_TICK_MS (60s) for frequency-tier dispatch
 *   - Execute cycle: every 60s — turns review outputs into follow-up work and dispatches ready tasks
 *   - Sync cycle: every 30s — pushes local state to Turso and keeps the hosted dashboard fresh
 *   - Review cycle: daily at configured hour — runs full project review if scheduled
 *
 * Daemon status is persisted to state/daemon-status.json for dashboard consumption.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDb } from '../packages/core/src/task-queue.js';
import { loadRegistry } from '../packages/core/src/registry.js';
import { listProjectPolicies } from '../packages/core/src/project-policy.js';
import { getProjectLaunchReadiness } from '../packages/core/src/project-readiness.js';
import { startScheduler } from '../packages/core/src/scheduler.js';
import { startDaemon, dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { listProjectAutonomyHealth } from '../packages/core/src/autonomy-governor.js';
import { autoHealPausedReviewTasks, recoverInterruptedWork, recoverStaleWork } from '../packages/core/src/run-recovery.js';
import { processDashboardActions } from '../packages/core/src/action-processor.js';
import { processApprovedFindings } from '../packages/core/src/auto-executor.js';
import { seedIdleAutonomyCycles } from '../packages/core/src/autonomy-loop.js';
import { isRateLimited, getRateLimitStatus, resolveModelBackend } from '../agents/_base/mcp-client.js';
import { resolveCodeExecutor } from '../packages/core/src/code-executor.js';
import { bootstrapRuntimeEnv } from '../packages/shared/src/runtime-env.js';
import { getSecretOrNull } from '../packages/shared/src/secrets.js';
// Dashboard import is conditional — skip if port is already in use (started by ensure-services)
let dashboardServer: unknown = null;
bootstrapRuntimeEnv();
const VERSION = '0.2.0';
const require = createRequire(import.meta.url);
const TSX_PACKAGE_JSON = require.resolve('tsx/package.json');
const TSX_CLI_PATH = path.resolve(path.dirname(TSX_PACKAGE_JSON), 'dist', 'cli.mjs');
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '7391');
const DAEMON_POLL_MS = 10_000;   // 10 seconds — agent runner polling interval
const SCHEDULER_TICK_MS = 60_000; // 60 seconds — scheduler tick interval
const DASHBOARD_ACTION_POLL_MS = 10_000; // 10 seconds — responsive website action pickup
const SYNC_TIMEOUT_MS = 90_000;

// ── Daemon config ─────────────────────────────────────────────────────────

const DAEMON_CONFIG = {
  /** How often to check for approved action items and execute ready tasks */
  executeIntervalMs: 60 * 1000,   // 60 seconds
  /** How often to sync local state to Turso */
  syncIntervalMs: 30 * 1000,       // 30 seconds
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
  updatedAt: string;
  lastExecuteCycle: string | null;
  nextExecuteCycle: string | null;
  lastSyncCycle: string | null;
  nextSyncCycle: string | null;
  lastReviewCycle: string | null;
  nextReviewCycle: string | null;
  itemsExecutedSinceRestart: number;
  itemsSyncedSinceRestart: number;
  reviewsRunSinceRestart: number;
  syncStatus: {
    status: 'idle' | 'ok' | 'blocked' | 'skipped' | 'error';
    reason: string | null;
  };
  rateLimitStatus: {
    limited: boolean;
    resetsAt: string | null;
    usagePct: number;
  };
  runtime: {
    modelBackend: string | null;
    codeExecutor: string | null;
    webSearchAvailable: boolean;
  };
  autonomy: Array<{
    projectId: string;
    autonomyMode: string;
    consecutiveHealthyRuns: number;
    requiredConsecutiveRuns: number;
    rolloutReady: boolean;
    blockers: string[];
  }>;
  readiness: Array<{
    projectId: string;
      cleanWorktree: boolean;
      workspaceMode: string;
      deployUnlocked: boolean;
      completedRuns: number;
      initialWorkflowLimit: number;
      initialAllowedWorkflows: string[];
      initialWorkflowGuardActive: boolean;
      prAuthReady: boolean;
      prAuthMode: string;
      vercelAuthReady: boolean;
      vercelAuthMode: string;
      blockers: string[];
      warnings: string[];
      minimax: {
      enabled: boolean;
      ready: boolean;
      allowedCommands: string[];
    };
  }>;
  config: typeof DAEMON_CONFIG;
  version: string;
}

import { PIDS_DIR, STATE_DIR } from '../packages/shared/src/state-dir.js';
const STATUS_FILE = path.join(STATE_DIR, 'daemon-status.json');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock.json');
const PID_FILE = path.join(PIDS_DIR, 'daemon.pid');

const daemonState = {
  startedAt: new Date().toISOString(),
  lastExecuteCycleMs: 0,
  lastSyncCycleMs: 0,
  lastReviewCycleMs: 0,
  lastReviewDate: '',  // YYYY-MM-DD — prevents running review twice in one day
  itemsExecuted: 0,
  itemsSynced: 0,
  reviewsRun: 0,
  lastSyncStatus: 'idle' as 'idle' | 'ok' | 'blocked' | 'skipped' | 'error',
  lastSyncReason: null as string | null,
};

let syncCycleInFlight: Promise<void> | null = null;

async function syncWithTimeout(): Promise<{ status: 'ok' | 'blocked' | 'skipped'; reason: string | null }> {
  try {
    const stdout = execFileSync(
      process.execPath,
      [TSX_CLI_PATH, '--experimental-sqlite', 'scripts/sync-state.ts'],
      {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: SYNC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const text = String(stdout ?? '').trim();
    const lastLine = text.split(/\r?\n/).filter(Boolean).at(-1) ?? '{}';
    const parsed = JSON.parse(lastLine) as { status?: 'ok' | 'blocked' | 'skipped'; reason?: string | null };
    return {
      status: parsed.status ?? 'ok',
      reason: parsed.reason ?? null,
    };
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      const detail = [
        String((error as { stdout?: Buffer | string }).stdout ?? '').trim(),
        String((error as { stderr?: Buffer | string }).stderr ?? '').trim(),
        error.message,
      ].filter(Boolean).join('\n');
      throw new Error(detail);
    }
    throw error;
  }
}

function computeNextCycle(lastMs: number, intervalMs: number): string | null {
  if (lastMs === 0) {
    return new Date().toISOString();
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
  let modelBackend: ReturnType<typeof resolveModelBackend> | null = null;
  let codeExecutor: ReturnType<typeof resolveCodeExecutor> | null = null;
  try {
    modelBackend = resolveModelBackend();
  } catch {
    modelBackend = null;
  }
  try {
    codeExecutor = resolveCodeExecutor();
  } catch {
    codeExecutor = null;
  }
  const autonomy = listProjectAutonomyHealth().map((project) => ({
    projectId: project.projectId,
    autonomyMode: project.autonomyMode,
    consecutiveHealthyRuns: project.consecutiveHealthyRuns,
    requiredConsecutiveRuns: project.requiredConsecutiveRuns,
    rolloutReady: project.rolloutReady,
    blockers: project.blockers,
  }));
  const readiness = listProjectPolicies().map((policy) => {
    const project = getProjectLaunchReadiness(policy.projectId);
    return {
      projectId: project.projectId,
      cleanWorktree: project.cleanWorktree,
      workspaceMode: project.workspaceMode,
      deployUnlocked: project.deployUnlocked,
      completedRuns: project.completedRuns,
      initialWorkflowLimit: project.initialWorkflowLimit,
      initialAllowedWorkflows: project.initialAllowedWorkflows,
      initialWorkflowGuardActive: project.initialWorkflowGuardActive,
      prAuthReady: project.prAuthReady,
      prAuthMode: project.prAuthMode,
      vercelAuthReady: project.vercelAuthReady,
      vercelAuthMode: project.vercelAuthMode,
      blockers: project.blockers,
      warnings: project.warnings,
      minimax: {
        enabled: project.minimax.enabled,
        ready: project.minimax.ready,
        allowedCommands: project.minimax.allowedCommands,
      },
    };
  });
  return {
    startedAt: daemonState.startedAt,
    updatedAt: new Date().toISOString(),
    lastExecuteCycle: daemonState.lastExecuteCycleMs ? new Date(daemonState.lastExecuteCycleMs).toISOString() : null,
    nextExecuteCycle: computeNextCycle(daemonState.lastExecuteCycleMs, DAEMON_CONFIG.executeIntervalMs),
    lastSyncCycle: daemonState.lastSyncCycleMs ? new Date(daemonState.lastSyncCycleMs).toISOString() : null,
    nextSyncCycle: computeNextCycle(daemonState.lastSyncCycleMs, DAEMON_CONFIG.syncIntervalMs),
    lastReviewCycle: daemonState.lastReviewCycleMs ? new Date(daemonState.lastReviewCycleMs).toISOString() : null,
    nextReviewCycle: computeNextReview(),
    itemsExecutedSinceRestart: daemonState.itemsExecuted,
    itemsSyncedSinceRestart: daemonState.itemsSynced,
    reviewsRunSinceRestart: daemonState.reviewsRun,
    syncStatus: {
      status: daemonState.lastSyncStatus,
      reason: daemonState.lastSyncReason,
    },
    rateLimitStatus: {
      limited: rlStatus.limited,
      resetsAt: rlStatus.resetsAt ? new Date(rlStatus.resetsAt).toISOString() : null,
      usagePct: rlStatus.usagePct,
    },
    runtime: {
      modelBackend: modelBackend?.selected ?? null,
      codeExecutor: codeExecutor?.selected ?? null,
      webSearchAvailable: modelBackend?.capabilities.webSearch ?? false,
    },
    autonomy,
    readiness,
    config: DAEMON_CONFIG,
    version: VERSION,
  };
}

function persistStatus(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(PIDS_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    fs.writeFileSync(STATUS_FILE, JSON.stringify(buildStatus(), null, 2));
  } catch (err) {
    console.error('[Lifecycle] Failed to write daemon status:', err);
  }
}

function processExists(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseDaemonLock(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    if (!fs.existsSync(LOCK_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as { pid?: number };
    if (raw.pid && raw.pid !== process.pid) return;
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Best-effort cleanup only.
  }
}

function acquireDaemonLock(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(PIDS_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as { pid?: number; startedAt?: string };
      if (processExists(raw.pid ?? null)) {
        throw new Error(`Another Organism daemon is already running (PID ${raw.pid}, started ${raw.startedAt ?? 'unknown'}).`);
      }
      fs.unlinkSync(LOCK_FILE);
    } catch (err) {
      if (err instanceof Error && err.message.includes('already running')) {
        throw err;
      }
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        // Ignore stale lock cleanup failures here; create below will surface any real issue.
      }
    }
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  }, null, 2), { flag: 'wx' });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

export function recoverWorkOnStartup(logger: (line: string) => void = console.log): ReturnType<typeof recoverInterruptedWork> {
  const recovered = recoverInterruptedWork();
  if (recovered.recoveredRuns > 0 || recovered.retriedTasks > 0 || recovered.pausedTasks > 0) {
    logger(
      `[Daemon] Recovered interrupted work: ${recovered.recoveredRuns} run(s), ${recovered.retriedTasks} retry task(s), ${recovered.pausedTasks} paused task(s)`,
    );
  } else {
    logger('[Daemon] No interrupted runs to recover');
  }
  const healed = autoHealPausedReviewTasks();
  if (healed.rescheduledTasks > 0 || healed.resumedRuns > 0 || healed.retiredTasks > 0 || healed.reroutedTasks > 0) {
    logger(
      `[Daemon] Auto-healed paused review work: ${healed.rescheduledTasks} task(s) rescheduled, ${healed.resumedRuns} run(s) resumed, ${healed.retiredTasks} superseded task(s) retired, ${healed.reroutedTasks} bounded fallback task(s) created`,
    );
  }
  return recovered;
}

async function bootstrapIdleAutonomy(logger: (line: string) => void = console.log): Promise<number> {
  const created = await seedIdleAutonomyCycles();
  if (created > 0) {
    logger(`[Daemon] Seeded ${created} idle autonomy cycle(s) during startup`);
    const dispatched = await dispatchPendingTasks();
    logger(`[Daemon] Startup dispatch launched ${dispatched} worker(s) after autonomy reseed`);
  } else {
    logger('[Daemon] No idle autonomy cycles needed at startup');
  }
  return created;
}

// ── Execute cycle: approved action items + pending tasks ──────────────────

async function runExecuteCycle(): Promise<void> {
  if (!DAEMON_CONFIG.enabled) return;
  if (isRateLimited()) {
    console.log('[Lifecycle] Execute cycle skipped — rate limited');
    return;
  }

  const now = Date.now();
  const isFirstCycle = daemonState.lastExecuteCycleMs === 0;
  const elapsed = isFirstCycle ? Infinity : now - daemonState.lastExecuteCycleMs;
  if (!isFirstCycle && elapsed < DAEMON_CONFIG.executeIntervalMs) return;

  console.log(`[Lifecycle] Execute cycle starting at ${new Date().toISOString()}`);

  // 1. Check local DB for approved action items (status = 'in_progress' in the tasks table)
  //    The action_items table lives on Turso (dashboard-owned), so we look at the local
  //    tasks table for tasks that are ready to execute.
  try {
    const followupsCreated = await processApprovedFindings();
    const dispatched = await dispatchPendingTasks();
    if (followupsCreated > 0) {
      console.log(`[Lifecycle] Execute cycle created ${followupsCreated} follow-up task(s) from completed reviews`);
    }
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

async function runSyncCycle(force = false): Promise<void> {
  if (syncCycleInFlight) {
    await syncCycleInFlight;
    return;
  }

  syncCycleInFlight = (async () => {
  if (!DAEMON_CONFIG.enabled) return;

  const now = Date.now();
  const isFirstCycle = daemonState.lastSyncCycleMs === 0;
  const elapsed = isFirstCycle ? Infinity : now - daemonState.lastSyncCycleMs;
  if (!force && !isFirstCycle && elapsed < DAEMON_CONFIG.syncIntervalMs) return;

  console.log(`[Lifecycle] Sync cycle starting at ${new Date().toISOString()}`);

  const tursoEnv = loadTursoEnv();
  if (!tursoEnv) {
    console.warn('[Lifecycle] Sync cycle skipped — no Turso credentials found');
    daemonState.lastSyncCycleMs = Date.now();
    persistStatus();
    return;
  }

  const { DB_PATH: LOCAL_DB_PATH } = await import('../packages/shared/src/state-dir.js');
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.warn('[Lifecycle] Sync cycle skipped — local DB not found');
    daemonState.lastSyncCycleMs = Date.now();
    persistStatus();
    return;
  }

  try {
    const result = await syncWithTimeout();
    daemonState.lastSyncStatus = result.status;
    daemonState.lastSyncReason = result.reason;
    if (result.status === 'ok') {
      daemonState.itemsSynced += 1;
      console.log('[Lifecycle] Sync cycle complete — Turso sync finished');
    } else if (result.status === 'blocked') {
      console.warn('[Lifecycle] Sync cycle in degraded mode — remote writes are blocked, localhost bridge remains authoritative');
    } else {
      console.log('[Lifecycle] Sync cycle skipped — Turso not configured');
    }
  } catch (err) {
    daemonState.lastSyncStatus = 'error';
    daemonState.lastSyncReason = err instanceof Error ? err.message : String(err);
    console.error('[Lifecycle] Sync cycle error:', err);
  }

  daemonState.lastSyncCycleMs = Date.now();
  persistStatus();
  })();

  try {
    await syncCycleInFlight;
  } finally {
    syncCycleInFlight = null;
  }
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
    const stale = recoverStaleWork();
    if (stale.recoveredRuns > 0 || stale.retriedTasks > 0 || stale.pausedTasks > 0) {
      console.log(
        `[Lifecycle] Recovered stale work: ${stale.recoveredRuns} run(s), ${stale.retriedTasks} retry task(s), ${stale.pausedTasks} paused task(s)`,
      );
    }
    const healed = autoHealPausedReviewTasks();
    if (healed.rescheduledTasks > 0 || healed.resumedRuns > 0 || healed.retiredTasks > 0 || healed.reroutedTasks > 0) {
      console.log(
        `[Lifecycle] Auto-healed paused review work: ${healed.rescheduledTasks} task(s) rescheduled, ${healed.resumedRuns} run(s) resumed, ${healed.retiredTasks} superseded task(s) retired, ${healed.reroutedTasks} bounded fallback task(s) created`,
      );
    }
    persistStatus();
    await runExecuteCycle();
    await runSyncCycle();
    await runReviewCycle();
  } catch (err) {
    console.error('[Lifecycle] Tick error:', err);
  }
}

async function dashboardActionTick(): Promise<void> {
  try {
    persistStatus();
    await processDashboardActions();
    await dispatchPendingTasks();
    persistStatus();
    await runSyncCycle(true);
    persistStatus();
  } catch (err) {
    console.error('[Dashboard Actions] Tick error:', err);
  }
}

// --- Health check ---

function runHealthCheck(): void {
  console.log('\n=== Organism Health Check ===\n');

  let allOk = true;

  process.stdout.write('Model backend: ');
  try {
    const backend = resolveModelBackend();
    console.log(
      `${backend.selected} (preferred=${backend.preferred}, claudeCli=${backend.available.claudeCli}, anthropicApi=${backend.available.anthropicApi}, codexCli=${backend.available.codexCli}, openaiApi=${backend.available.openaiApi}, webSearch=${backend.capabilities.webSearch})`,
    );
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  process.stdout.write('Code executor: ');
  try {
    const executor = resolveCodeExecutor();
    console.log(`${executor.selected} (preferred=${executor.preferred}, claude=${executor.available.claude}, codex=${executor.available.codex})`);
  } catch (err) {
    console.log(`FAIL — ${err}`);
    allOk = false;
  }

  process.stdout.write('OpenAI API key: ');
  console.log(getSecretOrNull('OPENAI_API_KEY') ? 'Present' : 'Missing — Codex CLI remains primary, API fallback disabled');

  process.stdout.write('Anthropic API key (legacy optional): ');
  console.log(getSecretOrNull('ANTHROPIC_API_KEY') ? 'Present — legacy fallback available' : 'Missing — legacy fallback disabled');

  // State directory
  process.stdout.write('State directory: ');
  if (fs.existsSync(STATE_DIR)) {
    console.log('OK');
  } else {
    fs.mkdirSync(STATE_DIR, { recursive: true });
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
  let modelBackendLabel = 'unavailable';
  let codeExecutorLabel = 'unavailable';
  try {
    const backend = resolveModelBackend();
    modelBackendLabel = `${backend.selected}${backend.capabilities.webSearch ? ' (web search)' : ''}`;
  } catch {
    modelBackendLabel = 'unavailable';
  }
  try {
    codeExecutorLabel = resolveCodeExecutor().selected;
  } catch {
    codeExecutorLabel = 'unavailable';
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║            O R G A N I S M                  ║');
  console.log(`║  Autonomous Multi-Agent Company  v${VERSION}      ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Started:    ${new Date().toISOString()}`);
  console.log(`  Dashboard:  http://localhost:${DASHBOARD_PORT}`);
  console.log(`  Runtime:    model=${modelBackendLabel}, executor=${codeExecutorLabel}`);
  console.log(`  Active agents (${uniqueActive.length}): ${uniqueActive.join(', ') || 'none'}`);
  console.log(`  Shadow agents (${uniqueShadow.length}): ${uniqueShadow.join(', ') || 'none'}`);
  console.log('');
  console.log('  Lifecycle cycles:');
  console.log(`    Execute:  every ${DAEMON_CONFIG.executeIntervalMs / 1000}s`);
  console.log(`    Sync:     every ${DAEMON_CONFIG.syncIntervalMs / 1000}s`);
  console.log(`    Review:   daily at ${DAEMON_CONFIG.reviewHour}:00 (${DAEMON_CONFIG.reviewSchedule})`);
  console.log(`    Enabled:  ${DAEMON_CONFIG.enabled}`);
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  // 1. Health check — exits if critical secrets missing
  runHealthCheck();
  acquireDaemonLock();
  process.env.ORGANISM_DISABLE_SCHEDULER_SYNC = '1';

  // 2. Startup banner
  printBanner();

  // 3. Dashboard — only start if port is free (ensure-services may have started it already)
  try {
    const net = await import('net');
    const portFree = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => { s.close(); resolve(true); });
      s.listen(DASHBOARD_PORT);
    });
    if (portFree) {
      dashboardServer = await import('../packages/dashboard/src/server.js');
      console.log(`[Daemon] Dashboard started on port ${DASHBOARD_PORT}`);
    } else {
      console.log(`[Daemon] Dashboard already running on port ${DASHBOARD_PORT}`);
    }
  } catch {
    console.log(`[Daemon] Dashboard already running on port ${DASHBOARD_PORT}`);
  }

  // 4. Migrations already run inside getDb() (called during health check above).
  console.log('[Daemon] Database migrations OK');

  // 4b. Recover any interrupted work before the scheduler/runner resume.
  recoverWorkOnStartup();
  await bootstrapIdleAutonomy();
  persistStatus();
  await runSyncCycle(true);
  persistStatus();

  // 5. Start scheduler (60s tick)
  const schedulerHandle = startScheduler(SCHEDULER_TICK_MS);
  console.log(`[Daemon] Scheduler started (tick: ${SCHEDULER_TICK_MS / 1000}s)`);

  // 6. Start agent runner daemon (10s poll)
  const daemonHandle = startDaemon(DAEMON_POLL_MS);
  console.log(`[Daemon] Agent runner started (poll: ${DAEMON_POLL_MS / 1000}s)`);

  // 7. Start lifecycle ticker (checks every 15s if any cycle is due)
  const lifecycleHandle = setInterval(() => {
    lifecycleTick().catch(console.error);
  }, 15_000);
  lifecycleTick().catch(console.error);
  console.log(`[Daemon] Lifecycle manager started (execute: ${DAEMON_CONFIG.executeIntervalMs / 1000}s, sync: ${DAEMON_CONFIG.syncIntervalMs / 1000}s, review: daily)`);

  // 7b. Pull and execute dashboard-triggered actions on a shorter cadence.
  const dashboardActionHandle = setInterval(() => {
    dashboardActionTick().catch(console.error);
  }, DASHBOARD_ACTION_POLL_MS);
  dashboardActionTick().catch(console.error);
  console.log(`[Daemon] Dashboard action bridge started (poll: ${DASHBOARD_ACTION_POLL_MS / 1000}s)`);

  // 8. Write initial daemon status
  persistStatus();
  console.log(`[Daemon] Status file: ${STATUS_FILE}`);

  // 9. Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`\n[Daemon] Received ${signal} — shutting down gracefully...`);
    clearInterval(schedulerHandle);
    clearInterval(daemonHandle);
    clearInterval(lifecycleHandle);
    clearInterval(dashboardActionHandle);
    persistStatus(); // Write final status before exit
    releaseDaemonLock();
    if (dashboardServer && typeof (dashboardServer as any).close === 'function') {
      (dashboardServer as any).close(() => {
        console.log('[Daemon] Dashboard closed.');
      });
    }
    console.log('[Daemon] Organism stopped. Goodbye.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[Daemon] Uncaught exception:', err);
    persistStatus();
    releaseDaemonLock();
  });
  process.on('unhandledRejection', (err) => {
    console.error('[Daemon] Unhandled rejection:', err);
    persistStatus();
    releaseDaemonLock();
  });

  // 10. Ready message
  console.log('\nOrganism is running. Press Ctrl+C to stop.\n');
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  main().catch((err) => {
    console.error('[Daemon] Fatal startup error:', err);
    process.exit(1);
  });
}
