/**
 * Sync local state/tasks.db → Turso remote database.
 * Usage: npx tsx scripts/sync-to-turso.ts
 *
 * Reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from:
 *   1. Environment variables
 *   2. packages/dashboard-v2/.env.production.local
 */

import { createClient } from '@libsql/client';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// ── Load env from .env.production.local if not in environment ──────────────
function loadEnv() {
  const envFile = resolve(import.meta.dirname ?? '.', '../packages/dashboard-v2/.env.production.local');
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+)="(.+)"$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

loadEnv();

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
  process.exit(1);
}

const localDbPath = resolve(import.meta.dirname ?? '.', '../state/tasks.db');
if (!existsSync(localDbPath)) {
  console.error(`Local DB not found at ${localDbPath}`);
  process.exit(1);
}

const local = new DatabaseSync(localDbPath);
const remote = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// ── Schema creation (idempotent) ───────────────────────────────────────────
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
  // ── Shape Up tables ───────────────────────────────────────────
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
  // Indexes for Shape Up
  `CREATE INDEX IF NOT EXISTS idx_bets_project ON bets(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_bet_scopes_bet ON bet_scopes(bet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_hill_updates_bet ON hill_updates(bet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bet_decisions_bet ON bet_decisions(bet_id)`,
  // ── Palate tables ──────────────────────────────────────────────
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
];

async function sync() {
  console.log(`Syncing ${localDbPath} → ${TURSO_URL}`);

  // Create tables
  console.log('Creating schema...');
  for (const sql of SCHEMA) {
    await remote.execute(sql);
  }

  // ── Sync tasks ─────────────────────────────────────────────────────────
  const tasks = local.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
  console.log(`Tasks to sync: ${tasks.length}`);

  if (tasks.length > 0) {
    // Clear remote tasks for fresh sync
    await remote.execute('DELETE FROM tasks');

    // Batch insert
    const batchSize = 20;
    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      const stmts = batch.map(t => ({
        sql: `INSERT OR REPLACE INTO tasks (id, agent, status, lane, description, input, input_hash, output, tokens_used, cost_usd, started_at, completed_at, error, parent_task_id, project_id, bet_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          t.id as string, t.agent as string, t.status as string, t.lane as string,
          t.description as string, t.input as string | null, t.input_hash as string | null,
          t.output as string | null, t.tokens_used as number | null, t.cost_usd as number | null,
          t.started_at as number | null, t.completed_at as number | null,
          t.error as string | null, t.parent_task_id as string | null,
          t.project_id as string, t.bet_id as string | null, t.created_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
      process.stdout.write(`  Tasks: ${Math.min(i + batchSize, tasks.length)}/${tasks.length}\r`);
    }
    console.log(`  Tasks: ${tasks.length}/${tasks.length} ✓`);
  }

  // ── Sync audit_log ─────────────────────────────────────────────────────
  const audits = local.prepare('SELECT * FROM audit_log').all() as Record<string, unknown>[];
  console.log(`Audit entries to sync: ${audits.length}`);

  if (audits.length > 0) {
    await remote.execute('DELETE FROM audit_log');

    const batchSize = 50;
    for (let i = 0; i < audits.length; i += batchSize) {
      const batch = audits.slice(i, i + batchSize);
      const stmts = batch.map(a => ({
        sql: `INSERT INTO audit_log (id, ts, agent, task_id, action, payload, outcome, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          a.id as number, a.ts as number, a.agent as string, a.task_id as string,
          a.action as string, a.payload as string | null, a.outcome as string, a.error_code as string | null,
        ],
      }));
      await remote.batch(stmts, 'write');
      process.stdout.write(`  Audit: ${Math.min(i + batchSize, audits.length)}/${audits.length}\r`);
    }
    console.log(`  Audit: ${audits.length}/${audits.length} ✓`);
  }

  // ── Sync agent_spend ───────────────────────────────────────────────────
  const spends = local.prepare('SELECT * FROM agent_spend').all() as Record<string, unknown>[];
  console.log(`Agent spend entries to sync: ${spends.length}`);

  if (spends.length > 0) {
    await remote.execute('DELETE FROM agent_spend');

    const stmts = spends.map(s => ({
      sql: `INSERT OR REPLACE INTO agent_spend (agent, date, project_id, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        s.agent as string, s.date as string, s.project_id as string,
        s.tokens_in as number, s.tokens_out as number, s.cost_usd as number,
      ],
    }));
    await remote.batch(stmts, 'write');
    console.log(`  Agent spend: ${spends.length} ✓`);
  }

  // ── Sync gates ─────────────────────────────────────────────────────────
  const gates = local.prepare('SELECT * FROM gates').all() as Record<string, unknown>[];
  console.log(`Gates to sync: ${gates.length}`);

  if (gates.length > 0) {
    await remote.execute('DELETE FROM gates');

    const batchSize = 50;
    for (let i = 0; i < gates.length; i += batchSize) {
      const batch = gates.slice(i, i + batchSize);
      const stmts = batch.map(g => ({
        sql: `INSERT OR REPLACE INTO gates (id, task_id, gate, decision, decided_by, reason, decided_at, patch_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          g.id as string, g.task_id as string, g.gate as string, g.decision as string,
          g.decided_by as string | null, g.reason as string | null, g.decided_at as number | null,
          g.patch_path as string | null, g.created_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
    }
    console.log(`  Gates: ${gates.length} ✓`);
  }

  // ── Sync perspective_fitness ───────────────────────────────────────────
  const fitness = local.prepare('SELECT * FROM perspective_fitness').all() as Record<string, unknown>[];
  if (fitness.length > 0) {
    await remote.execute('DELETE FROM perspective_fitness');
    const stmts = fitness.map(f => ({
      sql: `INSERT OR REPLACE INTO perspective_fitness (perspective_id, project_id, invocations, total_cost_usd, avg_quality_score, avg_rating, useful_count, dismissed_count, last_invoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        f.perspective_id as string, f.project_id as string, f.invocations as number,
        f.total_cost_usd as number, f.avg_quality_score as number, f.avg_rating as number,
        f.useful_count as number, f.dismissed_count as number, f.last_invoked as number | null,
      ],
    }));
    await remote.batch(stmts, 'write');
    console.log(`  Perspective fitness: ${fitness.length} ✓`);
  }

  // ── Sync pitches ───────────────────────────────────────────────
  const pitches = local.prepare('SELECT * FROM pitches').all() as Record<string, unknown>[];
  console.log(`Pitches to sync: ${pitches.length}`);

  if (pitches.length > 0) {
    await remote.execute('DELETE FROM pitches');

    const batchSize = 50;
    for (let i = 0; i < pitches.length; i += batchSize) {
      const batch = pitches.slice(i, i + batchSize);
      const stmts = batch.map(p => ({
        sql: `INSERT OR REPLACE INTO pitches (id, title, problem, appetite, solution_sketch, rabbit_holes, no_gos, shaped_by, project_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          p.id as string, p.title as string, p.problem as string, p.appetite as string,
          p.solution_sketch as string | null, p.rabbit_holes as string | null,
          p.no_gos as string | null, p.shaped_by as string, p.project_id as string,
          p.status as string, p.created_at as number, p.updated_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
    }
    console.log(`  Pitches: ${pitches.length} ✓`);
  }

  // ── Sync bets ─────────────────────────────────────────────────
  const bets = local.prepare('SELECT * FROM bets').all() as Record<string, unknown>[];
  console.log(`Bets to sync: ${bets.length}`);

  if (bets.length > 0) {
    await remote.execute('DELETE FROM bets');

    const batchSize = 50;
    for (let i = 0; i < bets.length; i += batchSize) {
      const batch = bets.slice(i, i + batchSize);
      const stmts = batch.map(b => ({
        sql: `INSERT OR REPLACE INTO bets (id, pitch_id, title, problem, appetite, status, shaped_by, approved_by, token_budget, cost_budget_usd, tokens_used, cost_used_usd, no_gos, rabbit_holes, success_criteria, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          b.id as string, b.pitch_id as string | null, b.title as string, b.problem as string,
          b.appetite as string, b.status as string, b.shaped_by as string,
          b.approved_by as string | null, b.token_budget as number, b.cost_budget_usd as number,
          b.tokens_used as number, b.cost_used_usd as number,
          b.no_gos as string | null, b.rabbit_holes as string | null,
          b.success_criteria as string | null, b.project_id as string,
          b.created_at as number, b.updated_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
    }
    console.log(`  Bets: ${bets.length} ✓`);
  }

  // ── Sync bet_scopes ───────────────────────────────────────────
  const betScopes = local.prepare('SELECT * FROM bet_scopes').all() as Record<string, unknown>[];
  console.log(`Bet scopes to sync: ${betScopes.length}`);

  if (betScopes.length > 0) {
    await remote.execute('DELETE FROM bet_scopes');

    const batchSize = 50;
    for (let i = 0; i < betScopes.length; i += batchSize) {
      const batch = betScopes.slice(i, i + batchSize);
      const stmts = batch.map(bs => ({
        sql: `INSERT OR REPLACE INTO bet_scopes (id, bet_id, title, description, hill_phase, hill_progress, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          bs.id as string, bs.bet_id as string, bs.title as string,
          bs.description as string | null, bs.hill_phase as string,
          bs.hill_progress as number, bs.completed as number,
          bs.created_at as number, bs.updated_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
    }
    console.log(`  Bet scopes: ${betScopes.length} ✓`);
  }

  // ── Sync hill_updates ─────────────────────────────────────────
  const hillUpdates = local.prepare('SELECT * FROM hill_updates').all() as Record<string, unknown>[];
  console.log(`Hill updates to sync: ${hillUpdates.length}`);

  if (hillUpdates.length > 0) {
    await remote.execute('DELETE FROM hill_updates');

    const batchSize = 50;
    for (let i = 0; i < hillUpdates.length; i += batchSize) {
      const batch = hillUpdates.slice(i, i + batchSize);
      const stmts = batch.map(hu => ({
        sql: `INSERT OR REPLACE INTO hill_updates (id, bet_id, scope_id, hill_progress, note, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          hu.id as string, hu.bet_id as string, hu.scope_id as string | null,
          hu.hill_progress as number, hu.note as string | null,
          hu.agent as string, hu.created_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
    }
    console.log(`  Hill updates: ${hillUpdates.length} ✓`);
  }

  // ── Sync bet_decisions ────────────────────────────────────────
  const betDecisions = local.prepare('SELECT * FROM bet_decisions').all() as Record<string, unknown>[];
  console.log(`Bet decisions to sync: ${betDecisions.length}`);

  if (betDecisions.length > 0) {
    await remote.execute('DELETE FROM bet_decisions');

    const batchSize = 50;
    for (let i = 0; i < betDecisions.length; i += batchSize) {
      const batch = betDecisions.slice(i, i + batchSize);
      const stmts = batch.map(bd => ({
        sql: `INSERT OR REPLACE INTO bet_decisions (id, bet_id, decision, reason, decided_by, exception_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          bd.id as string, bd.bet_id as string, bd.decision as string,
          bd.reason as string | null, bd.decided_by as string,
          bd.exception_type as string | null, bd.created_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
    }
    console.log(`  Bet decisions: ${betDecisions.length} ✓`);
  }

  // ── Sync source_fitness ────────────────────────────────────────
  try {
    const sourceFitness = local.prepare('SELECT * FROM source_fitness').all() as Record<string, unknown>[];
    if (sourceFitness.length > 0) {
      await remote.execute('DELETE FROM source_fitness');
      const stmts = sourceFitness.map(sf => ({
        sql: `INSERT OR REPLACE INTO source_fitness (source_id, project_id, fitness_score, injections, cited_in_good, cited_in_bad, last_injected) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          sf.source_id as string, sf.project_id as string, sf.fitness_score as number,
          sf.injections as number, sf.cited_in_good as number, sf.cited_in_bad as number,
          sf.last_injected as number | null,
        ],
      }));
      await remote.batch(stmts, 'write');
      console.log(`  Source fitness: ${sourceFitness.length} ✓`);
    }
  } catch { console.log('  Source fitness: table not yet created locally, skipping'); }

  // ── Sync wiki_ratings ────────────────────────────────────────
  try {
    const wikiRatings = local.prepare('SELECT * FROM wiki_ratings').all() as Record<string, unknown>[];
    if (wikiRatings.length > 0) {
      await remote.execute('DELETE FROM wiki_ratings');
      const stmts = wikiRatings.map(wr => ({
        sql: `INSERT INTO wiki_ratings (id, page, rating, notes, rated_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          wr.id as number, wr.page as string, wr.rating as number,
          wr.notes as string | null, wr.rated_by as string, wr.created_at as number,
        ],
      }));
      await remote.batch(stmts, 'write');
      console.log(`  Wiki ratings: ${wikiRatings.length} ✓`);
    }
  } catch { console.log('  Wiki ratings: table not yet created locally, skipping'); }

  // ── Summary ────────────────────────────────────────────────────────────
  const remoteCount = await remote.execute('SELECT COUNT(*) as c FROM tasks');
  console.log(`\nSync complete. Remote tasks: ${remoteCount.rows[0].c}`);

  const remoteTfg = await remote.execute("SELECT COUNT(*) as c FROM tasks WHERE project_id = 'tokens-for-good'");
  console.log(`TfG tasks on Turso: ${remoteTfg.rows[0].c}`);

  remote.close();
}

sync().catch(err => { console.error('Sync failed:', err); process.exit(1); });
