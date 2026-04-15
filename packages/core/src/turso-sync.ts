/**
 * turso-sync.ts — Incremental sync from local state/tasks.db to Turso.
 *
 * Exported function `syncToTurso()` is called by:
 *   - schedulerTick() every ~60s
 *   - CLI handleSubmitTask() after each manual command
 *
 * If Turso credentials are not configured, silently no-ops.
 * All errors are caught — Turso being down never crashes the daemon.
 */

import { createClient, type Client } from '@libsql/client';
import { getDb } from './task-queue.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Module-level state ───────────────────────────────────────────────────────

let remoteClient: Client | null = null;
let schemaCreated = false;
let lastSyncTs = 0; // epoch ms — only rows newer than this get synced
let lastDaemonStatusUpdatedAt = 0;

export type TursoSyncResult =
  | { status: 'ok'; reason?: null }
  | { status: 'skipped'; reason: 'not_configured' }
  | { status: 'blocked'; reason: 'write_blocked' };

export function resetTursoSyncState(): void {
  remoteClient = null;
  schemaCreated = false;
}

// ── Env loading ──────────────────────────────────────────────────────────────

function loadTursoEnv(): { url: string; token: string } | null {
  // Try environment first
  let url = process.env.TURSO_DATABASE_URL;
  let token = process.env.TURSO_AUTH_TOKEN;

  if (url && token) return { url, token };

  // Fallback: read from dashboard-v2 .env.production.local
  const candidates = [
    resolve(process.cwd(), 'packages/dashboard-v2/.env.production.local'),
  ];

  for (const envFile of candidates) {
    if (!existsSync(envFile)) continue;
    try {
      const lines = readFileSync(envFile, 'utf-8').split('\n');
      for (const line of lines) {
        const match = line.match(/^(\w+)="(.+)"$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2];
        }
      }
    } catch { /* ignore read errors */ }
  }

  url = process.env.TURSO_DATABASE_URL;
  token = process.env.TURSO_AUTH_TOKEN;

  if (url && token) return { url, token };
  return null;
}

function getRemote(): Client | null {
  if (remoteClient) return remoteClient;

  const env = loadTursoEnv();
  if (!env) return null;

  remoteClient = createClient({ url: env.url, authToken: env.token });
  return remoteClient;
}

export function isRemoteWriteBlockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /sql write operations are forbidden/i.test(message)
    || /writes are blocked/i.test(message)
    || /do you need to upgrade your plan/i.test(message);
}

// ── Schema (idempotent) ──────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
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
    bet_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    agent TEXT NOT NULL,
    task_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT,
    outcome TEXT NOT NULL,
    error_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agent_spend (
    agent TEXT NOT NULL,
    date TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'organism',
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    PRIMARY KEY (agent, date, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS gates (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    gate TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    reason TEXT,
    decided_at INTEGER,
    patch_path TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS shadow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    task_id TEXT NOT NULL,
    output TEXT,
    quality_score REAL,
    ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE TABLE IF NOT EXISTS innovation_radar_feedback (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    opportunity_title TEXT,
    feedback_code TEXT NOT NULL,
    notes TEXT,
    trigger TEXT,
    created_by TEXT NOT NULL DEFAULT 'rafael',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_innovation_feedback_project ON innovation_radar_feedback(project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_innovation_feedback_task ON innovation_radar_feedback(task_id)`,
  `CREATE TABLE IF NOT EXISTS perspective_fitness (
    perspective_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    invocations INTEGER DEFAULT 0,
    total_cost_usd REAL DEFAULT 0,
    avg_quality_score REAL DEFAULT 0,
    avg_rating REAL DEFAULT 0,
    useful_count INTEGER DEFAULT 0,
    dismissed_count INTEGER DEFAULT 0,
    last_invoked INTEGER,
    PRIMARY KEY (perspective_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS pitches (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    problem TEXT NOT NULL,
    appetite TEXT NOT NULL DEFAULT 'small batch',
    solution_sketch TEXT,
    rabbit_holes TEXT,
    no_gos TEXT,
    shaped_by TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'organism',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    pitch_id TEXT,
    title TEXT NOT NULL,
    problem TEXT NOT NULL,
    appetite TEXT NOT NULL DEFAULT 'small batch',
    status TEXT NOT NULL DEFAULT 'pitch_draft',
    shaped_by TEXT NOT NULL,
    approved_by TEXT,
    token_budget INTEGER NOT NULL DEFAULT 500000,
    cost_budget_usd REAL NOT NULL DEFAULT 5.00,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    cost_used_usd REAL NOT NULL DEFAULT 0,
    no_gos TEXT,
    rabbit_holes TEXT,
    success_criteria TEXT,
    project_id TEXT NOT NULL DEFAULT 'organism',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bet_scopes (
    id TEXT PRIMARY KEY,
    bet_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    hill_phase TEXT NOT NULL DEFAULT 'figuring_out',
    hill_progress INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hill_updates (
    id TEXT PRIMARY KEY,
    bet_id TEXT NOT NULL,
    scope_id TEXT,
    hill_progress INTEGER NOT NULL,
    note TEXT,
    agent TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bet_decisions (
    id TEXT PRIMARY KEY,
    bet_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    decided_by TEXT NOT NULL,
    exception_type TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bets_project ON bets(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_bet_scopes_bet ON bet_scopes(bet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hill_updates_bet ON hill_updates(bet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bet_decisions_bet ON bet_decisions(bet_id)`,
  `CREATE TABLE IF NOT EXISTS source_fitness (
    source_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'all',
    fitness_score REAL DEFAULT 0.5,
    injections INTEGER DEFAULT 0,
    cited_in_good INTEGER DEFAULT 0,
    cited_in_bad INTEGER DEFAULT 0,
    last_injected INTEGER,
    PRIMARY KEY (source_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS wiki_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page TEXT NOT NULL,
    rating INTEGER NOT NULL,
    notes TEXT,
    rated_by TEXT NOT NULL DEFAULT 'rafael',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wiki_ratings_page ON wiki_ratings(page)`,
  `CREATE TABLE IF NOT EXISTS dashboard_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'organism',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_kind TEXT NOT NULL DEFAULT 'user',
    workflow_kind TEXT NOT NULL DEFAULT 'implement',
    input_hash TEXT NOT NULL,
    latest_run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_sessions (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'organism',
    agent TEXT NOT NULL,
    workflow_kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_class TEXT NOT NULL DEFAULT 'none',
    retry_at INTEGER,
    provider_failure_kind TEXT NOT NULL DEFAULT 'none',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS interrupts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT,
    content TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    ts INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS daemon_status (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_goals_project_status ON goals(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_run_sessions_project_status ON run_sessions(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_run_steps_run_created ON run_steps(run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_interrupts_run_status ON interrupts(run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_run_status ON approvals(run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_runtime_events_goal_id ON runtime_events(goal_id, id)`,
];

async function ensureSchema(remote: Client): Promise<void> {
  if (schemaCreated) return;
  for (const sql of SCHEMA) {
    await remote.execute(sql);
  }
  await ensureColumn(remote, 'tasks', 'goal_id', 'TEXT');
  await ensureColumn(remote, 'tasks', 'workflow_kind', 'TEXT');
  await ensureColumn(remote, 'tasks', 'source_kind', 'TEXT');
  await ensureColumn(remote, 'tasks', 'retry_class', 'TEXT');
  await ensureColumn(remote, 'tasks', 'retry_at', 'INTEGER');
  await ensureColumn(remote, 'tasks', 'provider_failure_kind', 'TEXT');
  await ensureColumn(remote, 'tasks', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  schemaCreated = true;
}

async function ensureColumn(remote: Client, table: string, column: string, definition: string): Promise<void> {
  const info = await remote.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((row) => String(row.name) === column);
  if (exists) return;
  await remote.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function queryLocal(sql: string, ...params: unknown[]): Row[] {
  try {
    return getDb().prepare(sql).all(...params as Array<string | number | null>) as Row[];
  } catch {
    return []; // table may not exist locally yet
  }
}

function readDaemonStatusSnapshot(): { payload: string; updatedAt: number } | null {
  const stateDir = process.env.ORGANISM_STATE_DIR
    ?? resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.organism', 'state');
  const statusPath = resolve(stateDir, 'daemon-status.json');
  if (!existsSync(statusPath)) return null;

  try {
    const payload = readFileSync(statusPath, 'utf-8');
    const parsed = JSON.parse(payload) as { startedAt?: string };
    const updatedAt = Math.round(statSync(statusPath).mtimeMs);
    if (!parsed || typeof parsed !== 'object') return null;
    return { payload, updatedAt };
  } catch {
    return null;
  }
}

async function syncDaemonStatus(remote: Client): Promise<number> {
  const daemonStatus = readDaemonStatusSnapshot();
  if (!daemonStatus) return 0;
  if (daemonStatus.updatedAt < lastDaemonStatusUpdatedAt) return 0;

  await batchUpsert(remote, [{
    sql: `INSERT OR REPLACE INTO daemon_status (id, payload, updated_at) VALUES (?, ?, ?)`,
    args: ['primary', daemonStatus.payload, daemonStatus.updatedAt],
  }]);

  lastDaemonStatusUpdatedAt = daemonStatus.updatedAt + 1;
  return 1;
}

async function batchUpsert(remote: Client, stmts: Array<{ sql: string; args: unknown[] }>): Promise<void> {
  if (stmts.length === 0) return;
  const batchSize = 50;
  for (let i = 0; i < stmts.length; i += batchSize) {
    await remote.batch(stmts.slice(i, i + batchSize) as any, 'write');
  }
}

// ── Main sync function ───────────────────────────────────────────────────────

export async function syncToTurso(): Promise<TursoSyncResult> {
  const remote = getRemote();
  if (!remote) return { status: 'skipped', reason: 'not_configured' };

  try {
    await ensureSchema(remote);
  } catch (error) {
    if (isRemoteWriteBlockedError(error)) {
      console.warn('[turso-sync] Remote writes are blocked; continuing in local-bridge degraded mode');
      return { status: 'blocked', reason: 'write_blocked' };
    }
    throw error;
  }

  let daemonStatusRows = 0;
  try {
    daemonStatusRows = await syncDaemonStatus(remote);
  } catch (err) {
    if (isRemoteWriteBlockedError(err)) {
      console.warn('[turso-sync] Remote writes are blocked; continuing in local-bridge degraded mode');
      return { status: 'blocked', reason: 'write_blocked' };
    }
    console.warn('[turso-sync] Failed to sync daemon status early:', err);
  }

  try {
    const local = getDb();
    const syncStart = Date.now();
    const isFirstSync = lastSyncTs === 0;

  // ── Tasks (upsert by id; use created_at for new, but tasks can be updated so just re-upsert all changed) ──
  // Tasks don't have an updated_at column, so we use a full upsert for all tasks.
  // On first sync: all rows. On subsequent: tasks created or completed since last sync.
  let tasks: Row[];
  if (isFirstSync) {
    tasks = queryLocal('SELECT * FROM tasks');
  } else {
    tasks = queryLocal(
      `SELECT * FROM tasks
       WHERE status IN ('pending', 'in_progress', 'awaiting_review', 'paused', 'retry_scheduled')
          OR created_at > ?
          OR started_at > ?
          OR completed_at > ?
          OR created_at > ?`,
      lastSyncTs, lastSyncTs, lastSyncTs, Date.now() - 7 * 24 * 60 * 60 * 1000,
    );
  }

  if (tasks.length > 0) {
    const stmts = tasks.map(t => ({
      sql: `INSERT OR REPLACE INTO tasks (
        id, agent, status, lane, description, input, input_hash, output, tokens_used, cost_usd,
        started_at, completed_at, error, parent_task_id, project_id, bet_id, created_at,
        goal_id, workflow_kind, source_kind, retry_class, retry_at, provider_failure_kind, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id, t.agent, t.status, t.lane, t.description, t.input, t.input_hash,
        t.output, t.tokens_used, t.cost_usd, t.started_at, t.completed_at,
        t.error, t.parent_task_id, t.project_id, t.bet_id, t.created_at,
        t.goal_id, t.workflow_kind, t.source_kind, t.retry_class, t.retry_at, t.provider_failure_kind, t.attempt_count ?? 0,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Audit log (append-only, use ts) ──
  let audits: Row[];
  if (isFirstSync) {
    audits = queryLocal('SELECT * FROM audit_log');
  } else {
    audits = queryLocal('SELECT * FROM audit_log WHERE ts > ?', lastSyncTs);
  }

  if (audits.length > 0) {
    const stmts = audits.map(a => ({
      sql: `INSERT OR REPLACE INTO audit_log (id, ts, agent, task_id, action, payload, outcome, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [a.id, a.ts, a.agent, a.task_id, a.action, a.payload, a.outcome, a.error_code],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Agent spend (small table, always full upsert) ──
  const spends = queryLocal('SELECT * FROM agent_spend');
  if (spends.length > 0) {
    const stmts = spends.map(s => ({
      sql: `INSERT OR REPLACE INTO agent_spend (agent, date, project_id, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [s.agent, s.date, s.project_id, s.tokens_in, s.tokens_out, s.cost_usd],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Gates ──
  let gates: Row[];
  if (isFirstSync) {
    gates = queryLocal('SELECT * FROM gates');
  } else {
    gates = queryLocal('SELECT * FROM gates WHERE created_at > ? OR decided_at > ?', lastSyncTs, lastSyncTs);
  }

  if (gates.length > 0) {
    const stmts = gates.map(g => ({
      sql: `INSERT OR REPLACE INTO gates (id, task_id, gate, decision, decided_by, reason, decided_at, patch_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [g.id, g.task_id, g.gate, g.decision, g.decided_by, g.reason, g.decided_at, g.patch_path, g.created_at],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Shadow runs (append-only) ──
  let shadowRuns: Row[];
  if (isFirstSync) {
    shadowRuns = queryLocal('SELECT * FROM shadow_runs');
  } else {
    shadowRuns = queryLocal('SELECT * FROM shadow_runs WHERE ts > ?', lastSyncTs);
  }

  if (shadowRuns.length > 0) {
    const stmts = shadowRuns.map((run) => ({
      sql: `INSERT OR REPLACE INTO shadow_runs (id, agent, task_id, output, quality_score, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [run.id, run.agent, run.task_id, run.output, run.quality_score, run.ts],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Innovation radar feedback (bidirectional) ──
  let innovationFeedback: Row[];
  if (isFirstSync) {
    innovationFeedback = queryLocal('SELECT * FROM innovation_radar_feedback');
  } else {
    innovationFeedback = queryLocal('SELECT * FROM innovation_radar_feedback WHERE created_at > ?', lastSyncTs);
  }

  if (innovationFeedback.length > 0) {
    const stmts = innovationFeedback.map((row) => ({
      sql: `INSERT OR REPLACE INTO innovation_radar_feedback (id, task_id, project_id, opportunity_title, feedback_code, notes, trigger, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.task_id,
        row.project_id,
        row.opportunity_title,
        row.feedback_code,
        row.notes,
        row.trigger,
        row.created_by,
        row.created_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Perspective fitness (small table, always full upsert) ──
  const fitness = queryLocal('SELECT * FROM perspective_fitness');
  if (fitness.length > 0) {
    const stmts = fitness.map(f => ({
      sql: `INSERT OR REPLACE INTO perspective_fitness (perspective_id, project_id, invocations, total_cost_usd, avg_quality_score, avg_rating, useful_count, dismissed_count, last_invoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        f.perspective_id, f.project_id, f.invocations, f.total_cost_usd,
        f.avg_quality_score, f.avg_rating, f.useful_count, f.dismissed_count, f.last_invoked,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Pitches ──
  let pitches: Row[];
  if (isFirstSync) {
    pitches = queryLocal('SELECT * FROM pitches');
  } else {
    pitches = queryLocal('SELECT * FROM pitches WHERE updated_at > ?', lastSyncTs);
  }

  if (pitches.length > 0) {
    const stmts = pitches.map(p => ({
      sql: `INSERT OR REPLACE INTO pitches (id, title, problem, appetite, solution_sketch, rabbit_holes, no_gos, shaped_by, project_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        p.id, p.title, p.problem, p.appetite, p.solution_sketch, p.rabbit_holes,
        p.no_gos, p.shaped_by, p.project_id, p.status, p.created_at, p.updated_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Bets ──
  let bets: Row[];
  if (isFirstSync) {
    bets = queryLocal('SELECT * FROM bets');
  } else {
    bets = queryLocal('SELECT * FROM bets WHERE updated_at > ?', lastSyncTs);
  }

  if (bets.length > 0) {
    const stmts = bets.map(b => ({
      sql: `INSERT OR REPLACE INTO bets (id, pitch_id, title, problem, appetite, status, shaped_by, approved_by, token_budget, cost_budget_usd, tokens_used, cost_used_usd, no_gos, rabbit_holes, success_criteria, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        b.id, b.pitch_id, b.title, b.problem, b.appetite, b.status, b.shaped_by,
        b.approved_by, b.token_budget, b.cost_budget_usd, b.tokens_used, b.cost_used_usd,
        b.no_gos, b.rabbit_holes, b.success_criteria, b.project_id, b.created_at, b.updated_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Bet scopes ──
  let betScopes: Row[];
  if (isFirstSync) {
    betScopes = queryLocal('SELECT * FROM bet_scopes');
  } else {
    betScopes = queryLocal('SELECT * FROM bet_scopes WHERE updated_at > ?', lastSyncTs);
  }

  if (betScopes.length > 0) {
    const stmts = betScopes.map(bs => ({
      sql: `INSERT OR REPLACE INTO bet_scopes (id, bet_id, title, description, hill_phase, hill_progress, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        bs.id, bs.bet_id, bs.title, bs.description, bs.hill_phase,
        bs.hill_progress, bs.completed, bs.created_at, bs.updated_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Hill updates (append-only) ──
  let hillUpdates: Row[];
  if (isFirstSync) {
    hillUpdates = queryLocal('SELECT * FROM hill_updates');
  } else {
    hillUpdates = queryLocal('SELECT * FROM hill_updates WHERE created_at > ?', lastSyncTs);
  }

  if (hillUpdates.length > 0) {
    const stmts = hillUpdates.map(hu => ({
      sql: `INSERT OR REPLACE INTO hill_updates (id, bet_id, scope_id, hill_progress, note, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [hu.id, hu.bet_id, hu.scope_id, hu.hill_progress, hu.note, hu.agent, hu.created_at],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Bet decisions (append-only) ──
  let betDecisions: Row[];
  if (isFirstSync) {
    betDecisions = queryLocal('SELECT * FROM bet_decisions');
  } else {
    betDecisions = queryLocal('SELECT * FROM bet_decisions WHERE created_at > ?', lastSyncTs);
  }

  if (betDecisions.length > 0) {
    const stmts = betDecisions.map(bd => ({
      sql: `INSERT OR REPLACE INTO bet_decisions (id, bet_id, decision, reason, decided_by, exception_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [bd.id, bd.bet_id, bd.decision, bd.reason, bd.decided_by, bd.exception_type, bd.created_at],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Source fitness (small table, always full upsert) ──
  const sourceFitness = queryLocal('SELECT * FROM source_fitness');
  if (sourceFitness.length > 0) {
    const stmts = sourceFitness.map(sf => ({
      sql: `INSERT OR REPLACE INTO source_fitness (source_id, project_id, fitness_score, injections, cited_in_good, cited_in_bad, last_injected) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [sf.source_id, sf.project_id, sf.fitness_score, sf.injections, sf.cited_in_good, sf.cited_in_bad, sf.last_injected],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Wiki ratings (append-only) ──
  let wikiRatings: Row[];
  if (isFirstSync) {
    wikiRatings = queryLocal('SELECT * FROM wiki_ratings');
  } else {
    wikiRatings = queryLocal('SELECT * FROM wiki_ratings WHERE created_at > ?', lastSyncTs);
  }

  if (wikiRatings.length > 0) {
    const stmts = wikiRatings.map(wr => ({
      sql: `INSERT OR REPLACE INTO wiki_ratings (id, page, rating, notes, rated_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [wr.id, wr.page, wr.rating, wr.notes, wr.rated_by, wr.created_at],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Runtime v2 state ──
  let goals: Row[];
  if (isFirstSync) {
    goals = queryLocal('SELECT * FROM goals');
  } else {
    goals = queryLocal('SELECT * FROM goals WHERE updated_at > ?', lastSyncTs);
  }

  if (goals.length > 0) {
    const stmts = goals.map((goal) => ({
      sql: `INSERT OR REPLACE INTO goals (id, project_id, title, description, status, source_kind, workflow_kind, input_hash, latest_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        goal.id,
        goal.project_id,
        goal.title,
        goal.description,
        goal.status,
        goal.source_kind,
        goal.workflow_kind,
        goal.input_hash,
        goal.latest_run_id,
        goal.created_at,
        goal.updated_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  let runSessions: Row[];
  if (isFirstSync) {
    runSessions = queryLocal('SELECT * FROM run_sessions');
  } else {
    runSessions = queryLocal('SELECT * FROM run_sessions WHERE updated_at > ? OR completed_at > ?', lastSyncTs, lastSyncTs);
  }

  if (runSessions.length > 0) {
    const stmts = runSessions.map((run) => ({
      sql: `INSERT OR REPLACE INTO run_sessions (id, goal_id, project_id, agent, workflow_kind, status, retry_class, retry_at, provider_failure_kind, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        run.id,
        run.goal_id,
        run.project_id,
        run.agent,
        run.workflow_kind,
        run.status,
        run.retry_class,
        run.retry_at,
        run.provider_failure_kind,
        run.created_at,
        run.updated_at,
        run.completed_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  let runSteps: Row[];
  if (isFirstSync) {
    runSteps = queryLocal('SELECT * FROM run_steps');
  } else {
    runSteps = queryLocal('SELECT * FROM run_steps WHERE updated_at > ? OR completed_at > ?', lastSyncTs, lastSyncTs);
  }

  if (runSteps.length > 0) {
    const stmts = runSteps.map((step) => ({
      sql: `INSERT OR REPLACE INTO run_steps (id, run_id, name, status, detail, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        step.id,
        step.run_id,
        step.name,
        step.status,
        step.detail,
        step.created_at,
        step.updated_at,
        step.completed_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  let interrupts: Row[];
  if (isFirstSync) {
    interrupts = queryLocal('SELECT * FROM interrupts');
  } else {
    interrupts = queryLocal('SELECT * FROM interrupts WHERE created_at > ? OR resolved_at > ?', lastSyncTs, lastSyncTs);
  }

  if (interrupts.length > 0) {
    const stmts = interrupts.map((interrupt) => ({
      sql: `INSERT OR REPLACE INTO interrupts (id, run_id, type, status, summary, detail, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        interrupt.id,
        interrupt.run_id,
        interrupt.type,
        interrupt.status,
        interrupt.summary,
        interrupt.detail,
        interrupt.created_at,
        interrupt.resolved_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  let artifacts: Row[];
  if (isFirstSync) {
    artifacts = queryLocal('SELECT * FROM artifacts');
  } else {
    artifacts = queryLocal('SELECT * FROM artifacts WHERE created_at > ?', lastSyncTs);
  }

  if (artifacts.length > 0) {
    const stmts = artifacts.map((artifact) => ({
      sql: `INSERT OR REPLACE INTO artifacts (id, run_id, goal_id, kind, title, path, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        artifact.id,
        artifact.run_id,
        artifact.goal_id,
        artifact.kind,
        artifact.title,
        artifact.path,
        artifact.content,
        artifact.created_at,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  let approvals: Row[];
  if (isFirstSync) {
    approvals = queryLocal('SELECT * FROM approvals');
  } else {
    approvals = queryLocal('SELECT * FROM approvals WHERE requested_at > ? OR decided_at > ?', lastSyncTs, lastSyncTs);
  }

  if (approvals.length > 0) {
    const stmts = approvals.map((approval) => ({
      sql: `INSERT OR REPLACE INTO approvals (id, run_id, action, status, requested_by, requested_at, decided_at, decided_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        approval.id,
        approval.run_id,
        approval.action,
        approval.status,
        approval.requested_by,
        approval.requested_at,
        approval.decided_at,
        approval.decided_by,
        approval.reason,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  let runtimeEvents: Row[];
  if (isFirstSync) {
    runtimeEvents = queryLocal('SELECT * FROM runtime_events');
  } else {
    runtimeEvents = queryLocal('SELECT * FROM runtime_events WHERE ts > ? OR id > ?', lastSyncTs, lastSyncTs);
  }

  if (runtimeEvents.length > 0) {
    const stmts = runtimeEvents.map((event) => ({
      sql: `INSERT OR REPLACE INTO runtime_events (id, run_id, goal_id, event_type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        event.id,
        event.run_id,
        event.goal_id,
        event.event_type,
        event.payload,
        event.ts,
      ],
    }));
    await batchUpsert(remote, stmts);
  }

  // ── Pull dashboard decisions back to local ──
  // When Rafael approves/dismisses on the dashboard, it updates Turso directly.
  // Pull those status changes back so the local daemon knows.
  let pulledDecisions = 0;
  try {
    const remoteDecisions = await remote.execute(
      `SELECT task_id, decision FROM review_decisions WHERE decided_at > ?`,
      [lastSyncTs > 0 ? lastSyncTs : Date.now() - 24 * 60 * 60 * 1000]
    );
    if (remoteDecisions.rows.length > 0) {
      const local = getDb();
      for (const row of remoteDecisions.rows) {
        const taskId = row.task_id as string;
        const decision = row.decision as string;
        if (decision === 'approved') {
          local.prepare("UPDATE tasks SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ? AND status = 'awaiting_review'").run(Date.now(), taskId);
        } else if (decision === 'rejected' || decision === 'dismissed') {
          local.prepare("UPDATE tasks SET status = 'failed' WHERE id = ? AND status = 'awaiting_review'").run(taskId);
        }
      }
      pulledDecisions = remoteDecisions.rows.length;
      if (pulledDecisions > 0) console.log(`[turso-sync] Pulled ${pulledDecisions} dashboard decisions → local`);
    }
  } catch { /* review_decisions table may not exist yet */ }

  let pulledInnovationFeedback = 0;
  try {
    const remoteFeedback = await remote.execute(
      `SELECT id, task_id, project_id, opportunity_title, feedback_code, notes, trigger, created_by, created_at
       FROM innovation_radar_feedback
       WHERE created_at > ?`,
      [lastSyncTs > 0 ? lastSyncTs : Date.now() - 90 * 24 * 60 * 60 * 1000],
    );

    if (remoteFeedback.rows.length > 0) {
      const insert = local.prepare(`
        INSERT OR REPLACE INTO innovation_radar_feedback
        (id, task_id, project_id, opportunity_title, feedback_code, notes, trigger, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of remoteFeedback.rows) {
        insert.run(
          row.id as string,
          row.task_id as string,
          row.project_id as string,
          row.opportunity_title as string | null,
          row.feedback_code as string,
          row.notes as string | null,
          row.trigger as string | null,
          row.created_by as string,
          row.created_at as number,
        );
      }
      pulledInnovationFeedback = remoteFeedback.rows.length;
      console.log(`[turso-sync] Pulled ${pulledInnovationFeedback} innovation feedback row(s) → local`);
    }
  } catch { /* innovation_radar_feedback may not exist remotely yet */ }

  // ── Dashboard actions (BIDIRECTIONAL) ──
  // 1. Pull pending actions FROM Turso → local
  let pulledActions = 0;
  try {
    const remotePending = await remote.execute(
      "SELECT id, action, payload, status, created_at FROM dashboard_actions WHERE status = 'pending'"
    );
    if (remotePending.rows.length > 0) {
      const local = getDb();
      const upsertStmt = local.prepare(
        `INSERT OR IGNORE INTO dashboard_actions (id, action, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const row of remotePending.rows) {
        upsertStmt.run(
          row.id as number, row.action as string, row.payload as string | null,
          row.status as string, row.created_at as number,
        );
      }
      pulledActions = remotePending.rows.length;
    }
  } catch { /* dashboard_actions may not exist remotely yet */ }

  // 2. Push active/completed results FROM local → Turso
  let pushedActions = 0;
  const localActionUpdates = queryLocal(
    `SELECT * FROM dashboard_actions
     WHERE status = 'in_progress'
        OR (status IN ('completed', 'failed') AND completed_at > ?)`,
    lastSyncTs
  );
  if (localActionUpdates.length > 0) {
    const stmts = localActionUpdates.map(a => ({
      sql: `UPDATE dashboard_actions SET status = ?, result = ?, completed_at = ? WHERE id = ?`,
      args: [a.status, a.result, a.completed_at, a.id],
    }));
    await batchUpsert(remote, stmts);
    pushedActions = localActionUpdates.length;
  }

  // ── Log summary ──
  const totalRows = tasks.length + audits.length + spends.length + gates.length + shadowRuns.length + innovationFeedback.length +
    fitness.length + pitches.length + bets.length + betScopes.length +
    hillUpdates.length + betDecisions.length + sourceFitness.length + wikiRatings.length +
    goals.length + runSessions.length + runSteps.length + interrupts.length +
    artifacts.length + approvals.length + runtimeEvents.length + daemonStatusRows +
    pulledActions + pushedActions + pulledInnovationFeedback;

  if (totalRows > 0) {
    console.log(
      `[turso-sync] Synced ${tasks.length} tasks, ${goals.length} goals, ${runSessions.length} runs, ${runtimeEvents.length} runtime events, ${audits.length} audit entries, ${daemonStatusRows} daemon status row(s) (${Date.now() - syncStart}ms)`,
    );
  }

  // Advance watermark
    lastSyncTs = syncStart;
    return { status: 'ok' };
  } catch (error) {
    if (isRemoteWriteBlockedError(error)) {
      console.warn('[turso-sync] Remote writes are blocked; continuing in local-bridge degraded mode');
      return { status: 'blocked', reason: 'write_blocked' };
    }
    throw error;
  }
}
