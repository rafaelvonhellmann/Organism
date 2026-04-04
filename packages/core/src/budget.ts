import { getDb } from './task-queue.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';

// Per-agent daily budget caps (USD). Override via BUDGET_<AGENT_NAME> env var.
// Weeks 1-2 defaults — adjust upward as Organism grows.
// Calibrated from 3 review runs (v1: $0.33, v1.5: $1.43, v2: $2.70)
// Each agent gets ~10x their observed per-task cost as daily headroom
const DEFAULT_CAPS: Record<string, number> = {
  'ceo': 2.00,
  'cto': 1.00,
  'cfo': 1.00,
  'product-manager': 1.00,
  'engineering': 2.00,
  'marketing-strategist': 1.00,
  'marketing-executor': 1.00,
  'seo': 1.00,
  'sales': 1.00,
  'design': 1.00,
  'devops': 1.00,
  'hr': 1.00,
  'customer-success': 1.00,
  'data-analyst': 1.00,
  'customer-support': 1.00,
  'competitive-intel': 0.50,
  'community-manager': 1.00,
  'pr-comms': 1.00,
  'copyright': 0.50,
  'legal': 2.00,
  'security-audit': 1.00,
  'security-offensive': 1.00,
  'security-knowledge': 0.50,
  'medical-content-reviewer': 1.00,
  'quality-agent': 3.00,       // runs on every task — highest volume
  'grill-me': 2.00,            // runs on every MEDIUM/HIGH task
  'codex-review': 2.00,        // GPT-4o, auto-chained on MEDIUM/HIGH
  'quality-guardian': 5.00,    // Opus — one deep audit per day
  'risk-classifier': 0.50,
};

const SYSTEM_DAILY_CAP = parseFloat(process.env.SYSTEM_DAILY_CAP_USD ?? '50');

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
