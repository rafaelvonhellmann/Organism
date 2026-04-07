import { getDb } from './task-queue.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';
import { RiskLane } from '../../shared/src/types.js';

// Per-agent daily budget caps (USD). Override via BUDGET_<AGENT_NAME> env var.
// Calibrated from observed review runs. Tiered by cost profile:
//   - Cheap triage/classification agents: $5/day
//   - Standard domain agents: $15/day
//   - Quality-sensitive reviewers (legal, security, guardian): $25/day
//   - Perspective runs: $50/day
const DEFAULT_CAPS: Record<string, number> = {
  // Cheap: triage, interrogation, formatting, classification
  'grill-me': 5.00,
  'codex-review': 5.00,
  'risk-classifier': 5.00,
  // Standard: domain agents
  'ceo': 15.00,
  'cto': 15.00,
  'cfo': 15.00,
  'product-manager': 15.00,
  'engineering': 15.00,
  'marketing-strategist': 10.00,
  'marketing-executor': 10.00,
  'seo': 10.00,
  'sales': 10.00,
  'design': 10.00,
  'devops': 10.00,
  'hr': 10.00,
  'customer-success': 10.00,
  'data-analyst': 10.00,
  'customer-support': 10.00,
  'competitive-intel': 10.00,
  'community-manager': 10.00,
  'pr-comms': 10.00,
  'copyright': 10.00,
  'synthesis': 15.00,
  // Quality-sensitive: keep strong budgets
  'legal': 25.00,
  'security-audit': 25.00,
  'security-offensive': 15.00,
  'security-knowledge': 15.00,
  'medical-content-reviewer': 20.00,
  'quality-agent': 15.00,
  'quality-guardian': 25.00,
  // Palate knowledge system
  'palate-distiller': 5.00,
  'palate-wiki': 10.00,
  // Perspectives
  'perspectives': 50.00,
};

const PER_TASK_HARD_CAPS: Record<string, number> = {
  'security-audit': 3.00,
  'product-manager': 2.00,
};

export function getPerTaskHardCap(agent: string): number | null {
  return PER_TASK_HARD_CAPS[agent] ?? null;
}

export const MAX_REVISIONS = 2;
export const REVISION_COST_CAP = 2.00;

// ── Per-task estimated budget by lane ──────────────────────────────────────
// Used for pre-flight budget checks and overspend detection.
const TASK_BUDGET_BY_LANE: Record<RiskLane, number> = {
  LOW: 0.05,
  MEDIUM: 0.15,
  HIGH: 0.50,
};

// Per-task budget multiplier for expensive agents (quality-sensitive)
const AGENT_COST_MULTIPLIER: Record<string, number> = {
  'quality-guardian': 2.0,
  'legal': 1.5,
  'security-audit': 1.5,
  'perspectives': 3.0,
};

export function getTaskBudget(agent: string, lane: RiskLane): number {
  const base = TASK_BUDGET_BY_LANE[lane];
  const multiplier = AGENT_COST_MULTIPLIER[agent] ?? 1.0;
  return base * multiplier;
}

export interface OverspendSignal {
  agent: string;
  taskId: string;
  estimatedBudget: number;
  actualCost: number;
  overBy: number;
  overPct: number;
  action: 'LOG' | 'PAUSE' | 'ESCALATE';
}

/**
 * Check if a completed task overspent its estimated budget.
 * Returns an OverspendSignal if overspent, null otherwise.
 * Overspend thresholds:
 *   - >150% of estimate: LOG
 *   - >300% of estimate: PAUSE (soft block — next task deferred)
 *   - >500% of estimate: ESCALATE (flag for Rafael)
 */
export function checkOverspend(
  agent: string,
  taskId: string,
  lane: RiskLane,
  actualCost: number,
): OverspendSignal | null {
  const estimated = getTaskBudget(agent, lane);
  if (actualCost <= estimated) return null;

  const overBy = actualCost - estimated;
  const overPct = ((actualCost / estimated) - 1) * 100;

  let action: OverspendSignal['action'] = 'LOG';
  if (overPct > 400) action = 'ESCALATE';
  else if (overPct > 200) action = 'PAUSE';

  return { agent, taskId, estimatedBudget: estimated, actualCost, overBy, overPct, action };
}

const SYSTEM_DAILY_CAP = parseFloat(process.env.SYSTEM_DAILY_CAP_USD ?? '500');

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getAgentCap(agent: string): number {
  const envKey = `BUDGET_${agent.toUpperCase().replace(/-/g, '_')}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return parseFloat(fromEnv);
  return DEFAULT_CAPS[agent] ?? 2.00;
}

export function getAgentSpend(agent: string, date = todayStr(), projectId?: string): number {
  const db = getDb();
  const row = projectId
    ? db.prepare('SELECT SUM(cost_usd) as total FROM agent_spend WHERE agent = ? AND date = ? AND project_id = ?').get(agent, date, projectId) as { total: number } | undefined
    : db.prepare('SELECT SUM(cost_usd) as total FROM agent_spend WHERE agent = ? AND date = ?').get(agent, date) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function getSystemSpend(date = todayStr()): number {
  const row = getDb().prepare(
    'SELECT SUM(cost_usd) as total FROM agent_spend WHERE date = ?'
  ).get(date) as { total: number } | undefined;
  return row?.total ?? 0;
}

// Call before every LLM invocation. Throws if over budget.
export function assertBudget(agent: string, estimatedCostUsd: number): void {
  const cap = getAgentCap(agent);
  const spent = getAgentSpend(agent);
  if (spent + estimatedCostUsd > cap) {
    throw new Error(
      `Agent '${agent}' would exceed daily cap of $${cap.toFixed(2)} ` +
      `(spent: $${spent.toFixed(2)}, estimated: $${estimatedCostUsd.toFixed(2)}). ` +
      `Code: ${OrganismError.BUDGET_CAP_EXCEEDED}`
    );
  }
  const systemSpent = getSystemSpend();
  if (systemSpent + estimatedCostUsd > SYSTEM_DAILY_CAP) {
    throw new Error(
      `System daily cap of $${SYSTEM_DAILY_CAP} would be exceeded. ` +
      `Code: ${OrganismError.BUDGET_CAP_EXCEEDED}`
    );
  }
}

export function recordSpend(agent: string, tokensIn: number, tokensOut: number, costUsd: number, projectId = 'organism'): void {
  const date = todayStr();
  getDb().prepare(`
    INSERT INTO agent_spend (agent, date, project_id, tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, date, project_id) DO UPDATE SET
      tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out,
      cost_usd = cost_usd + excluded.cost_usd
  `).run(agent, date, projectId, tokensIn, tokensOut, costUsd);
}

// Cost estimates by model (per 1M tokens)
const MODEL_COSTS = {
  haiku: { input: 0.80, output: 4.00 },
  sonnet: { input: 3.00, output: 15.00 },
  opus: { input: 15.00, output: 75.00 },
  gpt4o: { input: 2.50, output: 10.00 },
  'gpt5.4': { input: 5.00, output: 20.00 },
} as const;

export function estimateCost(model: keyof typeof MODEL_COSTS, tokensIn: number, tokensOut: number): number {
  const rates = MODEL_COSTS[model];
  return (tokensIn / 1_000_000) * rates.input + (tokensOut / 1_000_000) * rates.output;
}

export function getSpendSummary(date = todayStr(), projectId?: string): Array<{ agent: string; spent: number; cap: number; pct: number }> {
  const db = getDb();
  const rows = projectId
    ? db.prepare('SELECT agent, SUM(cost_usd) as cost_usd FROM agent_spend WHERE date = ? AND project_id = ? GROUP BY agent ORDER BY cost_usd DESC').all(date, projectId) as Array<{ agent: string; cost_usd: number }>
    : db.prepare('SELECT agent, SUM(cost_usd) as cost_usd FROM agent_spend WHERE date = ? GROUP BY agent ORDER BY cost_usd DESC').all(date) as Array<{ agent: string; cost_usd: number }>;

  return rows.map((r) => {
    const cap = getAgentCap(r.agent);
    return { agent: r.agent, spent: r.cost_usd, cap, pct: (r.cost_usd / cap) * 100 };
  });
}

// ── Cost observability queries ─────────────────────────────────────────────

/** Top N agents by total spend (all time or for a date range). */
export function getTopCostAgents(limit = 10, sinceDate?: string): Array<{ agent: string; totalCost: number; totalTokensIn: number; totalTokensOut: number; taskCount: number }> {
  const db = getDb();
  const query = sinceDate
    ? `SELECT agent, SUM(cost_usd) as total_cost, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out, COUNT(*) as task_count FROM agent_spend WHERE date >= ? GROUP BY agent ORDER BY total_cost DESC LIMIT ?`
    : `SELECT agent, SUM(cost_usd) as total_cost, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out, COUNT(*) as task_count FROM agent_spend GROUP BY agent ORDER BY total_cost DESC LIMIT ?`;
  const rows = sinceDate
    ? db.prepare(query).all(sinceDate, limit) as Array<Record<string, number | string>>
    : db.prepare(query).all(limit) as Array<Record<string, number | string>>;
  return rows.map(r => ({
    agent: r.agent as string,
    totalCost: (r.total_cost as number) ?? 0,
    totalTokensIn: (r.total_tokens_in as number) ?? 0,
    totalTokensOut: (r.total_tokens_out as number) ?? 0,
    taskCount: (r.task_count as number) ?? 0,
  }));
}

/** Cost breakdown by risk lane — which lane burns the most? */
export function getCostByLane(date?: string): Array<{ lane: string; totalCost: number; taskCount: number; avgCost: number }> {
  const db = getDb();
  const dateFilter = date ?? todayStr();
  const rows = db.prepare(`
    SELECT t.lane, SUM(t.cost_usd) as total_cost, COUNT(*) as task_count
    FROM tasks t
    WHERE t.cost_usd IS NOT NULL AND t.completed_at > ?
    GROUP BY t.lane
    ORDER BY total_cost DESC
  `).all(Date.now() - (date ? 30 * 86_400_000 : 86_400_000)) as Array<Record<string, number | string>>;
  return rows.map(r => ({
    lane: r.lane as string,
    totalCost: (r.total_cost as number) ?? 0,
    taskCount: (r.task_count as number) ?? 0,
    avgCost: (r.task_count as number) > 0 ? ((r.total_cost as number) ?? 0) / (r.task_count as number) : 0,
  }));
}

/** Highest-cost individual tasks. */
export function getHighestCostTasks(limit = 10): Array<{ taskId: string; agent: string; lane: string; description: string; costUsd: number; tokensUsed: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, agent, lane, description, cost_usd, tokens_used
    FROM tasks
    WHERE cost_usd IS NOT NULL AND cost_usd > 0
    ORDER BY cost_usd DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, number | string>>;
  return rows.map(r => ({
    taskId: r.id as string,
    agent: r.agent as string,
    lane: r.lane as string,
    description: (r.description as string).slice(0, 120),
    costUsd: (r.cost_usd as number) ?? 0,
    tokensUsed: (r.tokens_used as number) ?? 0,
  }));
}

/** Budget overrun history — tasks that exceeded their estimated lane budget. */
export function getBudgetOverruns(limit = 20): Array<{ taskId: string; agent: string; lane: string; estimated: number; actual: number; overPct: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, agent, lane, cost_usd
    FROM tasks
    WHERE cost_usd IS NOT NULL AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 200
  `).all() as Array<Record<string, number | string>>;

  const overruns: Array<{ taskId: string; agent: string; lane: string; estimated: number; actual: number; overPct: number }> = [];
  for (const r of rows) {
    const lane = r.lane as RiskLane;
    const agent = r.agent as string;
    const actual = (r.cost_usd as number) ?? 0;
    const estimated = getTaskBudget(agent, lane);
    if (actual > estimated * 1.5) {
      overruns.push({
        taskId: r.id as string,
        agent,
        lane,
        estimated,
        actual,
        overPct: ((actual / estimated) - 1) * 100,
      });
    }
    if (overruns.length >= limit) break;
  }
  return overruns;
}
