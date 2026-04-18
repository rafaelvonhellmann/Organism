/** Per-agent daily budget caps in USD — mirrors packages/core/src/budget.ts */
export const AGENT_CAPS: Record<string, number> = {
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
  'quality-agent': 3.00,
  'domain-model': 2.00,
  'grill-me': 2.00,
  'codex-review': 2.00,
  'quality-guardian': 5.00,
  'risk-classifier': 0.50,
};

export const DEFAULT_CAP = 2.00;
export const SYSTEM_DAILY_CAP = parseFloat(process.env.SYSTEM_DAILY_CAP_USD ?? '50');

export function getAgentCap(agent: string): number {
  const envKey = `BUDGET_${agent.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envKey]) return parseFloat(process.env[envKey]!);
  return AGENT_CAPS[agent] ?? DEFAULT_CAP;
}

/** Status thresholds for budget indicators */
export function getBudgetStatus(pct: number): 'ok' | 'warn' | 'crit' | 'idle' {
  if (pct === 0) return 'idle';
  if (pct >= 90) return 'crit';
  if (pct >= 80) return 'warn';
  return 'ok';
}

/** Colors for risk lanes */
export const LANE_COLORS = {
  LOW: { bg: 'bg-green-500/15', text: 'text-green-400', dot: 'bg-green-500' },
  MEDIUM: { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-500' },
  HIGH: { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-500' },
} as const;

/** Colors for task statuses */
export const STATUS_COLORS = {
  pending: { bg: 'bg-blue-500/15', text: 'text-blue-400', dot: 'bg-blue-500' },
  in_progress: { bg: 'bg-indigo-500/15', text: 'text-indigo-400', dot: 'bg-indigo-500' },
  completed: { bg: 'bg-green-500/15', text: 'text-green-400', dot: 'bg-green-500' },
  failed: { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-500' },
  dead_letter: { bg: 'bg-red-900/30', text: 'text-red-300', dot: 'bg-red-800' },
  rolled_back: { bg: 'bg-orange-500/15', text: 'text-orange-400', dot: 'bg-orange-500' },
  awaiting_review: { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-500' },
} as const;

/** Colors for Shape Up bet statuses */
export const BET_STATUS_COLORS = {
  pitch_draft: { bg: 'bg-zinc-500/15', text: 'text-zinc-400', dot: 'bg-zinc-500' },
  pitch_ready: { bg: 'bg-blue-500/15', text: 'text-blue-400', dot: 'bg-blue-500' },
  bet_approved: { bg: 'bg-indigo-500/15', text: 'text-indigo-400', dot: 'bg-indigo-500' },
  active: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-500' },
  paused: { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-500' },
  cooldown: { bg: 'bg-sky-500/15', text: 'text-sky-400', dot: 'bg-sky-500' },
  done: { bg: 'bg-green-500/15', text: 'text-green-400', dot: 'bg-green-500' },
  cancelled: { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-500' },
} as const;

/** Colors for agent statuses */
export const AGENT_STATUS_COLORS = {
  active: { bg: 'bg-green-500/15', text: 'text-green-400', dot: 'bg-green-500' },
  shadow: { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-500' },
  suspended: { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-500' },
} as const;

export const BUDGET_STATUS_COLORS = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  crit: 'bg-red-500',
  idle: 'bg-zinc-600',
} as const;
