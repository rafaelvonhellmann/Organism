import { createClient, type Client } from '@libsql/client';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import registryData from '@/data/capability-registry.json';

let _client: Client | null = null;
let _dbError: string | null = null;
let _migrationsRun = false;

export function getClient(): Client | null {
  if (_client) return _client;

  // Reset error on each attempt (serverless may cache between invocations)
  _dbError = null;

  try {
    const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
    if (tursoUrl) {
      let url = tursoUrl;
      if (url.startsWith('libsql://')) {
        url = 'https://' + url.slice('libsql://'.length);
      }
      const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
      _client = createClient({ url, authToken });
      return _client;
    }

    // Local fallback
    const dbPath = resolve(process.cwd(), '../../state/tasks.db');
    if (!existsSync(dbPath)) {
      _dbError = `No TURSO_DATABASE_URL and no local DB at ${dbPath}`;
      return null;
    }
    _client = createClient({ url: `file:${dbPath}` });
    return _client;
  } catch (err) {
    _dbError = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error('[dashboard] DB error:', _dbError);
    return null;
  }
}

/**
 * Ensure the review_decisions table exists. Runs once per process.
 * The gates table is managed by core; this table is dashboard-owned.
 */
export async function ensureTables(): Promise<void> {
  if (_migrationsRun) return;
  const client = getClient();
  if (!client) return;

  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS review_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        decided_by TEXT NOT NULL DEFAULT 'rafael',
        decided_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Index for fast lookups by task_id
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_review_decisions_task
      ON review_decisions(task_id)
    `);

    // Indexes on tasks table for the review queue query
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status_agent
      ON tasks(status, agent)
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_tasks_project_created
      ON tasks(project_id, created_at)
    `);

    // Index on gates for the NOT EXISTS subquery
    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_gates_task_gate
      ON gates(task_id, gate)
    `);

    // Action items table — dashboard-owned, stores approved findings as actionable tasks
    await client.execute(`
      CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT NOT NULL DEFAULT 'MEDIUM',
        status TEXT NOT NULL DEFAULT 'todo',
        source_task_id TEXT,
        source_agent TEXT,
        due_date TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        rafael_notes TEXT
      )
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_action_items_project_status
      ON action_items(project_id, status)
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_action_items_priority
      ON action_items(priority)
    `);

    // ── Shape Up tables (readable from dashboard, written by core) ──
    // These are created by core migrations too, but ensure they exist for Turso
    await client.execute(`
      CREATE TABLE IF NOT EXISTS pitches (
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
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS bets (
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
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS bet_scopes (
        id TEXT PRIMARY KEY,
        bet_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        hill_phase TEXT NOT NULL DEFAULT 'figuring_out',
        hill_progress INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS hill_updates (
        id TEXT PRIMARY KEY,
        bet_id TEXT NOT NULL,
        scope_id TEXT,
        hill_progress INTEGER NOT NULL,
        note TEXT,
        agent TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS bet_decisions (
        id TEXT PRIMARY KEY,
        bet_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        decided_by TEXT NOT NULL,
        exception_type TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    // Indexes for Shape Up queries
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_bets_project ON bets(project_id)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_bet_scopes_bet ON bet_scopes(bet_id)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_hill_updates_bet ON hill_updates(bet_id)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_bet_decisions_bet ON bet_decisions(bet_id)`);

    // ── External Feedback (Agentation pilot) ──
    await client.execute(`
      CREATE TABLE IF NOT EXISTS external_feedback (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'agentation',
        session_id TEXT,
        external_id TEXT NOT NULL,
        page_url TEXT,
        annotation_kind TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        severity TEXT,
        raw_payload TEXT,
        linked_task_id TEXT,
        linked_action_item_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_feedback_ext
      ON external_feedback(source, external_id)
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_external_feedback_status
      ON external_feedback(status)
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_external_feedback_session
      ON external_feedback(session_id)
    `);

    // ── Dashboard Actions (queue for triggering Organism from serverless) ──
    await client.execute(`
      CREATE TABLE IF NOT EXISTS dashboard_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        completed_at INTEGER
      )
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_dashboard_actions_status
      ON dashboard_actions(status)
    `);

    _migrationsRun = true;
  } catch {
    // Tables may already exist or DB may not support these — not fatal
    _migrationsRun = true;
  }
}

export function getDbError(): string | null { return _dbError; }

export interface RegistryCapability {
  id: string;
  owner: string;
  collaborators: string[];
  reviewerLane: string;
  description: string;
  status: 'active' | 'shadow' | 'suspended';
  model: string;
  frequencyTier: string;
  projectScope?: string[] | 'all';
  knowledgeSources?: string[];
}

export function getRegistry(): RegistryCapability[] {
  const raw = registryData as { capabilities?: RegistryCapability[] };
  return raw.capabilities ?? [];
}

export function getAgentMeta(): Map<string, {
  status: 'active' | 'shadow' | 'suspended';
  model: string;
  description: string;
  capabilities: string[];
  frequencyTier: string;
}> {
  const caps = getRegistry();
  const agents = new Map<string, {
    status: 'active' | 'shadow' | 'suspended';
    model: string;
    description: string;
    capabilities: string[];
    frequencyTier: string;
  }>();

  for (const cap of caps) {
    const existing = agents.get(cap.owner);
    if (existing) {
      existing.capabilities.push(cap.id);
      if (cap.status === 'active') existing.status = 'active';
    } else {
      agents.set(cap.owner, {
        status: cap.status,
        model: cap.model,
        description: cap.description,
        capabilities: [cap.id],
        frequencyTier: cap.frequencyTier,
      });
    }
  }

  return agents;
}
