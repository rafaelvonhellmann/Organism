/**
 * Shape Up service — bet-based execution for AI agents.
 *
 * Core Shape Up principles adapted for Organism:
 * - Fixed appetite, variable scope (not fixed scope, variable time)
 * - Shaping before execution (MEDIUM/HIGH tasks need an approved bet)
 * - Small integrated pods (agents work within bet boundaries)
 * - Hill-chart progress tracking
 * - Circuit breakers when bets exceed their boundaries
 */

import * as crypto from 'crypto';
import { getDb } from './task-queue.js';
import { writeAudit } from './audit.js';
import type {
  Pitch, Bet, BetScope, HillUpdate, BetDecision,
  BetStatus, ExceptionType, HillPhase,
} from '../../shared/src/types.js';

// ── Pitch CRUD ──────────────────────────────────────────────────────────────

export function createPitch(params: {
  title: string;
  problem: string;
  appetite?: string;
  solution_sketch?: string;
  rabbit_holes?: string;
  no_gos?: string;
  shaped_by: string;
  project_id?: string;
}): Pitch {
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = getDb();

  db.prepare(`
    INSERT INTO pitches (id, title, problem, appetite, solution_sketch, rabbit_holes, no_gos, shaped_by, project_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(
    id,
    params.title,
    params.problem,
    params.appetite ?? 'small batch',
    params.solution_sketch ?? '',
    params.rabbit_holes ?? '[]',
    params.no_gos ?? '[]',
    params.shaped_by,
    params.project_id ?? 'organism',
    now,
    now,
  );

  return getPitch(id)!;
}

export function getPitch(id: string): Pitch | null {
  const row = getDb().prepare('SELECT * FROM pitches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToPitch(row);
}

export function listPitches(projectId?: string, status?: string): Pitch[] {
  const db = getDb();
  let rows: unknown[];
  if (projectId && status) {
    rows = db.prepare('SELECT * FROM pitches WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
  } else if (projectId) {
    rows = db.prepare('SELECT * FROM pitches WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  } else if (status) {
    rows = db.prepare('SELECT * FROM pitches WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM pitches ORDER BY created_at DESC').all();
  }
  return (rows as Record<string, unknown>[]).map(rowToPitch);
}

export function markPitchReady(id: string): Pitch {
  const now = Date.now();
  getDb().prepare(`UPDATE pitches SET status = 'ready', updated_at = ? WHERE id = ?`).run(now, id);
  return getPitch(id)!;
}

// ── Bet CRUD ────────────────────────────────────────────────────────────────

export function createBet(params: {
  pitch_id?: string;
  title: string;
  problem: string;
  appetite?: string;
  shaped_by: string;
  token_budget?: number;
  cost_budget_usd?: number;
  no_gos?: string;
  rabbit_holes?: string;
  success_criteria?: string;
  project_id?: string;
}): Bet {
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = getDb();

  db.prepare(`
    INSERT INTO bets (id, pitch_id, title, problem, appetite, status, shaped_by, token_budget, cost_budget_usd, no_gos, rabbit_holes, success_criteria, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pitch_draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.pitch_id ?? null,
    params.title,
    params.problem,
    params.appetite ?? 'small batch',
    params.shaped_by,
    params.token_budget ?? 500000,
    params.cost_budget_usd ?? 5.00,
    params.no_gos ?? '[]',
    params.rabbit_holes ?? '[]',
    params.success_criteria ?? '[]',
    params.project_id ?? 'organism',
    now,
    now,
  );

  writeAudit({
    agent: 'shapeup',
    taskId: id,
    action: 'task_created',
    payload: { type: 'bet_created', title: params.title, appetite: params.appetite },
    outcome: 'success',
  });

  return getBet(id)!;
}

export function getBet(id: string): Bet | null {
  const row = getDb().prepare('SELECT * FROM bets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToBet(row);
}

export function listBets(projectId?: string, status?: BetStatus): Bet[] {
  const db = getDb();
  let rows: unknown[];
  if (projectId && status) {
    rows = db.prepare('SELECT * FROM bets WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
  } else if (projectId) {
    rows = db.prepare('SELECT * FROM bets WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  } else if (status) {
    rows = db.prepare('SELECT * FROM bets WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM bets ORDER BY created_at DESC').all();
  }
  return (rows as Record<string, unknown>[]).map(rowToBet);
}

export function getActiveBetForProject(projectId: string): Bet | null {
  const row = getDb().prepare(
    "SELECT * FROM bets WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToBet(row);
}

// ── Bet Lifecycle ───────────────────────────────────────────────────────────

export function approveBet(betId: string, approvedBy: string, reason?: string): Bet {
  const now = Date.now();
  const db = getDb();

  db.prepare(`
    UPDATE bets SET status = 'bet_approved', approved_by = ?, updated_at = ? WHERE id = ?
  `).run(approvedBy, now, betId);

  recordBetDecision(betId, 'approved', approvedBy, reason ?? 'Bet approved for execution');

  writeAudit({
    agent: 'shapeup',
    taskId: betId,
    action: 'gate_eval',
    payload: { type: 'bet_approved', approvedBy },
    outcome: 'success',
  });

  return getBet(betId)!;
}

export function rejectBet(betId: string, rejectedBy: string, reason?: string): Bet {
  const now = Date.now();
  const db = getDb();

  db.prepare(`
    UPDATE bets SET status = 'cancelled', updated_at = ? WHERE id = ?
  `).run(now, betId);

  recordBetDecision(betId, 'rejected', rejectedBy, reason ?? 'Bet rejected');

  writeAudit({
    agent: 'shapeup',
    taskId: betId,
    action: 'gate_eval',
    payload: { type: 'bet_rejected', rejectedBy, reason },
    outcome: 'blocked',
  });

  return getBet(betId)!;
}

export function activateBet(betId: string): Bet {
  const now = Date.now();
  getDb().prepare(`UPDATE bets SET status = 'active', updated_at = ? WHERE id = ?`).run(now, betId);
  return getBet(betId)!;
}

export function pauseBet(betId: string, reason: string, exceptionType: ExceptionType, pausedBy: string = 'system'): Bet {
  const now = Date.now();
  getDb().prepare(`UPDATE bets SET status = 'paused', updated_at = ? WHERE id = ?`).run(now, betId);

  recordBetDecision(betId, 'paused', pausedBy, reason, exceptionType);

  writeAudit({
    agent: 'shapeup',
    taskId: betId,
    action: 'gate_eval',
    payload: { type: 'bet_paused', reason, exceptionType },
    outcome: 'blocked',
  });

  return getBet(betId)!;
}

export function resumeBet(betId: string, resumedBy: string, reason?: string): Bet {
  const now = Date.now();
  getDb().prepare(`UPDATE bets SET status = 'active', updated_at = ? WHERE id = ?`).run(now, betId);

  recordBetDecision(betId, 'resumed', resumedBy, reason ?? 'Bet resumed');
  return getBet(betId)!;
}

export function completeBet(betId: string, completedBy: string = 'system', reason?: string): Bet {
  const now = Date.now();
  getDb().prepare(`UPDATE bets SET status = 'done', updated_at = ? WHERE id = ?`).run(now, betId);

  recordBetDecision(betId, 'completed', completedBy, reason ?? 'Bet completed');
  return getBet(betId)!;
}

export function cooldownBet(betId: string, reason?: string): Bet {
  const now = Date.now();
  getDb().prepare(`UPDATE bets SET status = 'cooldown', updated_at = ? WHERE id = ?`).run(now, betId);

  recordBetDecision(betId, 'completed', 'system', reason ?? 'Bet in cooldown');
  return getBet(betId)!;
}

export function cancelBet(betId: string, cancelledBy: string, reason?: string): Bet {
  const now = Date.now();
  getDb().prepare(`UPDATE bets SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, betId);

  recordBetDecision(betId, 'cancelled', cancelledBy, reason ?? 'Bet cancelled');
  return getBet(betId)!;
}

// ── Bet Spend Tracking ──────────────────────────────────────────────────────

export function recordBetSpend(betId: string, tokensUsed: number, costUsd: number): void {
  getDb().prepare(`
    UPDATE bets SET tokens_used = tokens_used + ?, cost_used_usd = cost_used_usd + ?, updated_at = ?
    WHERE id = ?
  `).run(tokensUsed, costUsd, Date.now(), betId);
}

// ── Circuit Breaker ─────────────────────────────────────────────────────────

export interface CircuitBreakerResult {
  tripped: boolean;
  exception?: ExceptionType;
  reason?: string;
}

/**
 * Check if an active bet has exceeded its boundaries.
 * Call this before or after each task execution within a bet.
 */
export function checkBetCircuitBreaker(betId: string): CircuitBreakerResult {
  const bet = getBet(betId);
  if (!bet || bet.status !== 'active') {
    return { tripped: false };
  }

  // Check token budget
  if (bet.tokens_used >= bet.token_budget) {
    pauseBet(betId, `Token budget exceeded: ${bet.tokens_used}/${bet.token_budget}`, 'token_budget_exceeded');
    return {
      tripped: true,
      exception: 'token_budget_exceeded',
      reason: `Token budget exceeded: ${bet.tokens_used}/${bet.token_budget}`,
    };
  }

  // Check cost budget
  if (bet.cost_used_usd >= bet.cost_budget_usd) {
    pauseBet(betId, `Cost budget exceeded: $${bet.cost_used_usd.toFixed(2)}/$${bet.cost_budget_usd.toFixed(2)}`, 'appetite_exceeded');
    return {
      tripped: true,
      exception: 'appetite_exceeded',
      reason: `Cost budget exceeded: $${bet.cost_used_usd.toFixed(2)}/$${bet.cost_budget_usd.toFixed(2)}`,
    };
  }

  return { tripped: false };
}

/**
 * Check if a task description hits any no-go or rabbit-hole markers.
 */
export function checkBetBoundaries(betId: string, taskDescription: string): CircuitBreakerResult {
  const bet = getBet(betId);
  if (!bet) return { tripped: false };

  const lower = taskDescription.toLowerCase();

  // Check no-gos
  let noGos: string[] = [];
  try { noGos = JSON.parse(bet.no_gos); } catch { /* not JSON, treat as single item */ noGos = bet.no_gos ? [bet.no_gos] : []; }
  for (const noGo of noGos) {
    if (noGo && lower.includes(noGo.toLowerCase())) {
      pauseBet(betId, `No-go boundary hit: "${noGo}" found in task description`, 'no_go_hit');
      return {
        tripped: true,
        exception: 'no_go_hit',
        reason: `No-go boundary hit: "${noGo}"`,
      };
    }
  }

  // Check rabbit holes
  let rabbitHoles: string[] = [];
  try { rabbitHoles = JSON.parse(bet.rabbit_holes); } catch { rabbitHoles = bet.rabbit_holes ? [bet.rabbit_holes] : []; }
  for (const hole of rabbitHoles) {
    if (hole && lower.includes(hole.toLowerCase())) {
      pauseBet(betId, `Rabbit hole detected: "${hole}" found in task description`, 'rabbit_hole_hit');
      return {
        tripped: true,
        exception: 'rabbit_hole_hit',
        reason: `Rabbit hole detected: "${hole}"`,
      };
    }
  }

  return { tripped: false };
}

// ── Scopes ──────────────────────────────────────────────────────────────────

export function addScope(betId: string, title: string, description?: string): BetScope {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO bet_scopes (id, bet_id, title, description, hill_phase, hill_progress, completed, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'figuring_out', 0, 0, ?, ?)
  `).run(id, betId, title, description ?? '', now, now);
  return getScope(id)!;
}

export function getScope(id: string): BetScope | null {
  const row = getDb().prepare('SELECT * FROM bet_scopes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToScope(row);
}

export function listScopes(betId: string): BetScope[] {
  const rows = getDb().prepare('SELECT * FROM bet_scopes WHERE bet_id = ? ORDER BY created_at ASC').all(betId) as Record<string, unknown>[];
  return rows.map(rowToScope);
}

export function updateScopeProgress(scopeId: string, hillProgress: number): BetScope {
  const phase: HillPhase = hillProgress <= 50 ? 'figuring_out' : 'making_it_happen';
  const completed = hillProgress >= 100 ? 1 : 0;
  const now = Date.now();
  getDb().prepare(`
    UPDATE bet_scopes SET hill_progress = ?, hill_phase = ?, completed = ?, updated_at = ?
    WHERE id = ?
  `).run(hillProgress, phase, completed, now, scopeId);
  return getScope(scopeId)!;
}

// ── Hill Updates ────────────────────────────────────────────────────────────

export function postHillUpdate(params: {
  bet_id: string;
  scope_id?: string;
  hill_progress: number;
  note?: string;
  agent: string;
}): HillUpdate {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO hill_updates (id, bet_id, scope_id, hill_progress, note, agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.bet_id, params.scope_id ?? null, params.hill_progress, params.note ?? '', params.agent, now);

  // If a scope is referenced, update its progress too
  if (params.scope_id) {
    updateScopeProgress(params.scope_id, params.hill_progress);
  }

  return getHillUpdate(id)!;
}

export function getHillUpdate(id: string): HillUpdate | null {
  const row = getDb().prepare('SELECT * FROM hill_updates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToHillUpdate(row);
}

export function listHillUpdates(betId: string, limit = 50): HillUpdate[] {
  const rows = getDb().prepare('SELECT * FROM hill_updates WHERE bet_id = ? ORDER BY created_at DESC LIMIT ?').all(betId, limit) as Record<string, unknown>[];
  return rows.map(rowToHillUpdate);
}

// ── Bet Decisions ───────────────────────────────────────────────────────────

function recordBetDecision(
  betId: string,
  decision: BetDecision['decision'],
  decidedBy: string,
  reason: string,
  exceptionType?: ExceptionType,
): void {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO bet_decisions (id, bet_id, decision, reason, decided_by, exception_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, betId, decision, reason, decidedBy, exceptionType ?? null, Date.now());
}

export function listBetDecisions(betId: string): BetDecision[] {
  const rows = getDb().prepare('SELECT * FROM bet_decisions WHERE bet_id = ? ORDER BY created_at ASC').all(betId) as Record<string, unknown>[];
  return rows.map(rowToBetDecision);
}

// ── Specialist Trigger System ───────────────────────────────────────────────

import type { RiskLane, SpecialistTrigger } from '../../shared/src/types.js';

/**
 * Default specialist trigger rules. Instead of running all specialists by default
 * for every MEDIUM/HIGH task, only invoke them when conditions are met.
 */
const SPECIALIST_TRIGGERS: SpecialistTrigger[] = [
  {
    agent: 'legal',
    conditions: ['legal', 'compliance', 'gdpr', 'copyright', 'license', 'terms of service', 'privacy policy'],
    min_lane: 'HIGH',
    requires_bet: true,
  },
  {
    agent: 'security-audit',
    conditions: ['auth', 'security', 'vulnerability', 'cve', 'password', 'token', 'session', 'oauth', 'encryption', 'injection'],
    min_lane: 'HIGH',
    requires_bet: true,
  },
  {
    agent: 'quality-guardian',
    conditions: ['release', 'deploy', 'ship', 'production', 'migration', 'database change'],
    min_lane: 'HIGH',
    requires_bet: true,
  },
];

const LANE_ORDER: Record<RiskLane, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Given a task description and lane, determine which specialist agents should be invoked.
 * Returns only the agents whose trigger conditions are met.
 */
export function resolveSpecialistTriggers(description: string, lane: RiskLane, hasBet: boolean): string[] {
  const lower = description.toLowerCase();
  const triggered: string[] = [];

  for (const trigger of SPECIALIST_TRIGGERS) {
    // Check minimum lane
    if (LANE_ORDER[lane] < LANE_ORDER[trigger.min_lane]) continue;

    // Check if bet is required but missing
    if (trigger.requires_bet && !hasBet) continue;

    // Check if any condition keyword matches
    const matches = trigger.conditions.some(cond => lower.includes(cond));
    if (matches) {
      triggered.push(trigger.agent);
    }
  }

  return triggered;
}

// ── Row mappers ─────────────────────────────────────────────────────────────

function rowToPitch(row: Record<string, unknown>): Pitch {
  return {
    id: row.id as string,
    title: row.title as string,
    problem: row.problem as string,
    appetite: row.appetite as string,
    solution_sketch: (row.solution_sketch as string) ?? '',
    rabbit_holes: (row.rabbit_holes as string) ?? '[]',
    no_gos: (row.no_gos as string) ?? '[]',
    shaped_by: row.shaped_by as string,
    project_id: row.project_id as string,
    status: row.status as Pitch['status'],
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function rowToBet(row: Record<string, unknown>): Bet {
  return {
    id: row.id as string,
    pitch_id: row.pitch_id as string | null,
    title: row.title as string,
    problem: row.problem as string,
    appetite: row.appetite as string,
    status: row.status as BetStatus,
    shaped_by: row.shaped_by as string,
    approved_by: row.approved_by as string | null,
    token_budget: row.token_budget as number,
    cost_budget_usd: row.cost_budget_usd as number,
    tokens_used: row.tokens_used as number,
    cost_used_usd: row.cost_used_usd as number,
    no_gos: (row.no_gos as string) ?? '[]',
    rabbit_holes: (row.rabbit_holes as string) ?? '[]',
    success_criteria: (row.success_criteria as string) ?? '[]',
    project_id: row.project_id as string,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function rowToScope(row: Record<string, unknown>): BetScope {
  return {
    id: row.id as string,
    bet_id: row.bet_id as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    hill_phase: row.hill_phase as HillPhase,
    hill_progress: row.hill_progress as number,
    completed: !!(row.completed as number),
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function rowToHillUpdate(row: Record<string, unknown>): HillUpdate {
  return {
    id: row.id as string,
    bet_id: row.bet_id as string,
    scope_id: row.scope_id as string | null,
    hill_progress: row.hill_progress as number,
    note: (row.note as string) ?? '',
    agent: row.agent as string,
    created_at: row.created_at as number,
  };
}

function rowToBetDecision(row: Record<string, unknown>): BetDecision {
  return {
    id: row.id as string,
    bet_id: row.bet_id as string,
    decision: row.decision as BetDecision['decision'],
    reason: (row.reason as string) ?? '',
    decided_by: row.decided_by as string,
    exception_type: row.exception_type as ExceptionType | null,
    created_at: row.created_at as number,
  };
}
