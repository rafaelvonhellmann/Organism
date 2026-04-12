import { createTask, getDb, getTask, updateTaskRuntimeState } from './task-queue.js';
import { appendRunProgress } from './run-memory.js';
import { createArtifact, getRunSession, listRunSteps, updateRunStatus, updateRunStep } from './run-state.js';
import type { RiskLane, WorkflowKind } from '../../shared/src/types.js';

const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_STALE_AGE_MS = 20 * 60 * 1000;
const DEFAULT_REVIEW_RETRY_DELAY_MS = 3 * 60 * 1000;
const DEFAULT_REVIEW_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_REVIEW_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REVIEW_MAX_ATTEMPTS = 8;
const REVIEW_RETRY_AGENTS = new Set(['quality-agent', 'quality-guardian', 'codex-review', 'grill-me', 'legal', 'security-audit']);
const AUTO_HEAL_PROVIDER_FAILURES = new Set(['transport_error', 'overload', 'timeout', 'rate_limit']);

interface RecoveryCounts {
  recoveredRuns: number;
  retriedTasks: number;
  pausedTasks: number;
}

interface AutoHealCounts {
  rescheduledTasks: number;
  resumedRuns: number;
  retiredTasks: number;
  reroutedTasks: number;
  skippedTasks: number;
}

interface RecoveryRow {
  id: string;
  goal_id: string;
  project_id: string;
  agent: string;
}

interface OrphanedTaskRow {
  id: string;
  goal_id: string | null;
  agent: string;
  attempt_count: number | null;
}

interface PausedReviewTaskRow {
  id: string;
  goal_id: string | null;
  project_id: string;
  agent: string;
  workflow_kind: string | null;
  attempt_count: number | null;
  provider_failure_kind: string | null;
  error: string | null;
  description: string;
  created_at: number;
  completed_at: number | null;
}

interface SupersedingExecutionRow {
  id: string;
  agent: string;
  workflow_kind: string | null;
  description: string;
  created_at: number;
}

function runningRuns(): RecoveryRow[] {
  return getDb().prepare(`
    SELECT id, goal_id, project_id, agent
    FROM run_sessions
    WHERE status = 'running'
    ORDER BY updated_at ASC
  `).all() as unknown as RecoveryRow[];
}

function orphanedInProgressTasks(): OrphanedTaskRow[] {
  return getDb().prepare(`
    SELECT id, goal_id, agent, attempt_count
    FROM tasks
    WHERE status = 'in_progress'
    ORDER BY started_at ASC, created_at ASC
  `).all() as unknown as OrphanedTaskRow[];
}

function staleRunningRuns(cutoff: number): RecoveryRow[] {
  return getDb().prepare(`
    SELECT id, goal_id, project_id, agent
    FROM run_sessions
    WHERE status = 'running'
      AND updated_at < ?
    ORDER BY updated_at ASC
  `).all(cutoff) as unknown as RecoveryRow[];
}

function staleInProgressTasks(cutoff: number): OrphanedTaskRow[] {
  return getDb().prepare(`
    SELECT id, goal_id, agent, attempt_count
    FROM tasks
    WHERE status = 'in_progress'
      AND COALESCE(started_at, created_at) < ?
    ORDER BY COALESCE(started_at, created_at) ASC
  `).all(cutoff) as unknown as OrphanedTaskRow[];
}

function pausedReviewTasks(options: { lookbackCutoff: number; cooldownCutoff: number }): PausedReviewTaskRow[] {
  return getDb().prepare(`
    SELECT id, goal_id, project_id, agent, workflow_kind, attempt_count, provider_failure_kind, error, description, created_at, completed_at
    FROM tasks
    WHERE status = 'paused'
      AND COALESCE(completed_at, created_at) >= ?
      AND COALESCE(completed_at, created_at) <= ?
    ORDER BY COALESCE(completed_at, created_at) ASC
  `).all(options.lookbackCutoff, options.cooldownCutoff) as unknown as PausedReviewTaskRow[];
}

function latestRunForGoalAgent(goalId: string | null, agent: string): { id: string; status: string } | null {
  if (!goalId) return null;
  const row = getDb().prepare(`
    SELECT id, status
    FROM run_sessions
    WHERE goal_id = ? AND agent = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(goalId, agent) as { id: string; status: string } | undefined;
  return row ?? null;
}

function hasActiveEquivalentTask(task: PausedReviewTaskRow): boolean {
  const row = getDb().prepare(`
    SELECT id
    FROM tasks
    WHERE id != ?
      AND COALESCE(goal_id, '') = COALESCE(?, '')
      AND agent = ?
      AND COALESCE(workflow_kind, '') = COALESCE(?, '')
      AND status IN ('pending', 'in_progress', 'retry_scheduled', 'awaiting_review')
    LIMIT 1
  `).get(task.id, task.goal_id ?? null, task.agent, task.workflow_kind ?? null) as { id: string } | undefined;
  return !!row;
}

function isReviewLaneTask(task: PausedReviewTaskRow): boolean {
  return task.workflow_kind === 'review'
    || task.workflow_kind === 'validate'
    || REVIEW_RETRY_AGENTS.has(task.agent);
}

function findSupersedingExecutionTask(task: PausedReviewTaskRow): SupersedingExecutionRow | null {
  if (!task.goal_id) return null;
  const row = getDb().prepare(`
    SELECT id, agent, workflow_kind, description, created_at
    FROM tasks
    WHERE id != ?
      AND goal_id = ?
      AND created_at > ?
      AND workflow_kind IN ('implement', 'recover', 'ship')
      AND status IN ('pending', 'in_progress', 'retry_scheduled', 'awaiting_review', 'completed')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(task.id, task.goal_id, task.created_at) as SupersedingExecutionRow | undefined;
  return row ?? null;
}

function retryClassForFailureKind(providerFailureKind: string | null): 'rate_limit' | 'provider_overload' | 'transient_error' {
  switch (providerFailureKind) {
    case 'rate_limit':
      return 'rate_limit';
    case 'overload':
      return 'provider_overload';
    default:
      return 'transient_error';
  }
}

function compactReviewFocus(description: string, maxLength = 120): string {
  let compacted = description
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = compacted.split(/(?<=[.!?])\s+/)[0];
  if (sentence) compacted = sentence.trim();

  if (compacted.length > 96) {
    const andMatch = /\s+and\s+/i.exec(compacted);
    if (andMatch && typeof andMatch.index === 'number') {
      const primaryClause = compacted.slice(0, andMatch.index).trim();
      if (primaryClause.length >= 32) {
        compacted = primaryClause;
      }
    }
  }

  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 3).trimEnd()}...` : compacted;
}

function normalizeFollowupDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function equivalentDescriptions(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 48 || right.length < 48) return false;
  return left.includes(right) || right.includes(left);
}

function hasEquivalentReviewFallback(params: {
  goalId: string | null;
  projectId: string;
  agent: string;
  workflowKind: WorkflowKind;
  description: string;
  sourceTaskId: string;
  originalTaskId?: string | null;
}): boolean {
  const db = getDb();
  const excludedIds = [params.sourceTaskId, params.originalTaskId].filter((value): value is string => !!value);
  const placeholders = excludedIds.map(() => '?').join(', ');
  const exclusionClause = excludedIds.length > 0 ? `AND id NOT IN (${placeholders})` : '';
  const normalizedDescription = normalizeFollowupDescription(params.description);

  const recentCandidates = db.prepare(`
    SELECT description
    FROM tasks
    WHERE project_id = ? AND agent = ? AND workflow_kind = ?
      ${exclusionClause}
      AND status NOT IN ('failed', 'dead_letter', 'rolled_back', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 20
  `).all(
    params.projectId,
    params.agent,
    params.workflowKind,
    ...excludedIds,
  ) as Array<{ description: string }>;

  return recentCandidates.some((candidate) =>
    equivalentDescriptions(normalizedDescription, normalizeFollowupDescription(candidate.description)),
  );
}

function createReviewFallbackTask(task: PausedReviewTaskRow): boolean {
  const fullTask = getTask(task.id);
  if (!fullTask) return false;

  const taskInput = fullTask.input && typeof fullTask.input === 'object'
    ? fullTask.input as Record<string, unknown>
    : null;
  const originalTaskId = typeof taskInput?.originalTaskId === 'string'
    ? taskInput.originalTaskId
    : typeof taskInput?.sourceTaskId === 'string'
      ? taskInput.sourceTaskId
      : null;
  const originalTask = originalTaskId ? getTask(originalTaskId) : null;
  const focus = compactReviewFocus(originalTask?.description ?? task.description);
  const executionParent = originalTask?.agent === 'engineering'
    || originalTask?.workflowKind === 'implement'
    || originalTask?.workflowKind === 'recover'
    || originalTask?.workflowKind === 'ship';

  const targetAgent = executionParent ? 'engineering' : 'quality-agent';
  const workflowKind: WorkflowKind = executionParent
    ? (originalTask?.workflowKind === 'recover' ? 'recover' : 'implement')
    : 'validate';
  const lane: RiskLane = executionParent ? 'MEDIUM' : 'LOW';
  const description = executionParent
    ? `Resolve blocked ${task.agent} review for "${focus}"`
    : `Continue bounded validation for "${focus}"`;

  if (hasEquivalentReviewFallback({
    goalId: task.goal_id,
    projectId: task.project_id,
    agent: targetAgent,
    workflowKind,
    description,
    sourceTaskId: task.id,
    originalTaskId: originalTask?.id ?? null,
  })) {
    return false;
  }

  createTask({
    agent: targetAgent,
    lane,
    description,
    input: {
      sourceTaskId: task.id,
      sourceAgent: task.agent,
      originalTaskId: originalTask?.id ?? null,
      originalDescription: originalTask?.description ?? null,
      reviewFallback: true,
      blockedReviewAgent: task.agent,
      sourceError: task.error ?? null,
      projectId: task.project_id,
      execution: executionParent,
    },
    parentTaskId: originalTask?.id ?? task.id,
    projectId: task.project_id,
    goalId: task.goal_id ?? undefined,
    workflowKind,
    sourceKind: 'agent_followup',
  });

  const summary = `Rerouted paused ${task.agent} review work into a bounded ${targetAgent} ${workflowKind} task after retry exhaustion.`;
  updateTaskRuntimeState({
    taskId: task.id,
    status: 'failed',
    error: `${task.error ?? 'Paused review task'} | ${summary}`,
    retryClass: 'manual_pause',
    retryAt: null,
    providerFailureKind: task.provider_failure_kind,
  });

  const run = latestRunForGoalAgent(task.goal_id, task.agent);
  if (run && (run.status === 'paused' || run.status === 'retry_scheduled')) {
    updateRunStatus({
      runId: run.id,
      status: 'failed',
      retryClass: 'manual_pause',
      retryAt: null,
      providerFailureKind: (task.provider_failure_kind ?? 'transport_error') as 'transport_error' | 'overload' | 'timeout' | 'rate_limit',
      summary,
    });
  }

  if (task.goal_id) {
    appendRunProgress(task.goal_id, [
      `- Rerouted exhausted **${task.agent}** review work into **${targetAgent}** (${workflowKind})`,
    ]);
  }

  return true;
}

function markRunningStepsPaused(runId: string, detail: string): void {
  for (const step of listRunSteps(runId)) {
    if (step.status === 'running') {
      updateRunStep({
        stepId: step.id,
        status: 'paused',
        detail,
      });
    }
  }
}

function recoverTask(taskId: string, summary: string, retryAt: number | null, maxAttempts: number): 'retried' | 'paused' {
  const task = getTask(taskId);
  if (!task) return retryAt ? 'retried' : 'paused';

  const shouldRetry = retryAt !== null && (task.attemptCount ?? 0) < maxAttempts;
  updateTaskRuntimeState({
    taskId,
    status: shouldRetry ? 'retry_scheduled' : 'paused',
    error: summary,
    retryClass: shouldRetry ? 'transient_error' : 'manual_pause',
    retryAt: shouldRetry ? retryAt : null,
    providerFailureKind: shouldRetry ? 'transport_error' : 'tool_failure',
  });
  return shouldRetry ? 'retried' : 'paused';
}

export function recoverInterruptedWork(options: {
  now?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
} = {}): RecoveryCounts {
  const now = options.now ?? Date.now();
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const counts: RecoveryCounts = {
    recoveredRuns: 0,
    retriedTasks: 0,
    pausedTasks: 0,
  };

  const db = getDb();
  const recoveredTaskIds = new Set<string>();

  for (const run of runningRuns()) {
    const summary = `Recovered orphaned run after daemon restart for ${run.agent}. Resuming from the latest verified checkpoint.`;
    const taskRow = db.prepare(`
      SELECT id, attempt_count
      FROM tasks
      WHERE goal_id = ? AND agent = ? AND status = 'in_progress'
      ORDER BY started_at DESC, created_at DESC
      LIMIT 1
    `).get(run.goal_id, run.agent) as { id: string; attempt_count: number | null } | undefined;

    markRunningStepsPaused(run.id, summary);

    const shouldRetry = !!taskRow && (taskRow.attempt_count ?? 0) < maxAttempts;
    const retryAt = shouldRetry ? now + retryDelayMs : null;
    updateRunStatus({
      runId: run.id,
      status: shouldRetry ? 'retry_scheduled' : 'paused',
      retryClass: shouldRetry ? 'transient_error' : 'manual_pause',
      retryAt,
      providerFailureKind: shouldRetry ? 'transport_error' : 'tool_failure',
      summary,
    });

    const recoveredRun = getRunSession(run.id);
    if (recoveredRun) {
      createArtifact({
        runId: recoveredRun.id,
        goalId: recoveredRun.goalId,
        kind: 'checkpoint',
        title: 'Daemon recovery checkpoint',
        content: summary,
      });
      appendRunProgress(recoveredRun.goalId, [
        `- Daemon recovery: ${shouldRetry ? 'retry scheduled' : 'manual pause'} for **${run.agent}**`,
      ]);
    }

    if (taskRow) {
      const outcome = recoverTask(taskRow.id, summary, retryAt, maxAttempts);
      recoveredTaskIds.add(taskRow.id);
      if (outcome === 'retried') counts.retriedTasks++;
      else counts.pausedTasks++;
    }

    counts.recoveredRuns++;
  }

  for (const task of orphanedInProgressTasks()) {
    if (recoveredTaskIds.has(task.id)) continue;

    const shouldRetry = (task.attempt_count ?? 0) < maxAttempts;
    const retryAt = shouldRetry ? now + retryDelayMs : null;
    const summary = `Recovered orphaned task after daemon restart for ${task.agent}. ${shouldRetry ? 'Retry scheduled automatically.' : 'Manual intervention required after repeated attempts.'}`;
    const outcome = recoverTask(task.id, summary, retryAt, maxAttempts);
    if (outcome === 'retried') counts.retriedTasks++;
    else counts.pausedTasks++;
  }

  return counts;
}

export function recoverStaleWork(options: {
  now?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  staleAgeMs?: number;
} = {}): RecoveryCounts {
  const now = options.now ?? Date.now();
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
  const cutoff = now - staleAgeMs;
  const counts: RecoveryCounts = {
    recoveredRuns: 0,
    retriedTasks: 0,
    pausedTasks: 0,
  };

  const db = getDb();
  const recoveredTaskIds = new Set<string>();

  for (const run of staleRunningRuns(cutoff)) {
    const summary = `Recovered stale run for ${run.agent} after ${Math.round(staleAgeMs / 60_000)} minutes without a heartbeat. Scheduling a retry from the latest checkpoint.`;
    const taskRow = db.prepare(`
      SELECT id, attempt_count
      FROM tasks
      WHERE goal_id = ? AND agent = ? AND status = 'in_progress'
      ORDER BY started_at DESC, created_at DESC
      LIMIT 1
    `).get(run.goal_id, run.agent) as { id: string; attempt_count: number | null } | undefined;

    markRunningStepsPaused(run.id, summary);

    const shouldRetry = !!taskRow && (taskRow.attempt_count ?? 0) < maxAttempts;
    const retryAt = shouldRetry ? now + retryDelayMs : null;
    updateRunStatus({
      runId: run.id,
      status: shouldRetry ? 'retry_scheduled' : 'paused',
      retryClass: shouldRetry ? 'transient_error' : 'manual_pause',
      retryAt,
      providerFailureKind: shouldRetry ? 'timeout' : 'tool_failure',
      summary,
    });

    const recoveredRun = getRunSession(run.id);
    if (recoveredRun) {
      createArtifact({
        runId: recoveredRun.id,
        goalId: recoveredRun.goalId,
        kind: 'checkpoint',
        title: 'Stale run recovery checkpoint',
        content: summary,
      });
      appendRunProgress(recoveredRun.goalId, [
        `- Stale run recovery: ${shouldRetry ? 'retry scheduled' : 'manual pause'} for **${run.agent}**`,
      ]);
    }

    if (taskRow) {
      const outcome = recoverTask(taskRow.id, summary, retryAt, maxAttempts);
      recoveredTaskIds.add(taskRow.id);
      if (outcome === 'retried') counts.retriedTasks++;
      else counts.pausedTasks++;
    }

    counts.recoveredRuns++;
  }

  for (const task of staleInProgressTasks(cutoff)) {
    if (recoveredTaskIds.has(task.id)) continue;
    const shouldRetry = (task.attempt_count ?? 0) < maxAttempts;
    const retryAt = shouldRetry ? now + retryDelayMs : null;
    const summary = `Recovered stale task for ${task.agent} after ${Math.round(staleAgeMs / 60_000)} minutes without a heartbeat. ${shouldRetry ? 'Retry scheduled automatically.' : 'Manual intervention required after repeated attempts.'}`;
    const outcome = recoverTask(task.id, summary, retryAt, maxAttempts);
    if (outcome === 'retried') counts.retriedTasks++;
    else counts.pausedTasks++;
  }

  return counts;
}

export function autoHealPausedReviewTasks(options: {
  now?: number;
  retryDelayMs?: number;
  cooldownMs?: number;
  lookbackMs?: number;
  maxAttempts?: number;
  reviewMaxAttempts?: number;
} = {}): AutoHealCounts {
  const now = options.now ?? Date.now();
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_REVIEW_RETRY_DELAY_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_REVIEW_COOLDOWN_MS;
  const lookbackMs = options.lookbackMs ?? DEFAULT_REVIEW_LOOKBACK_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const reviewMaxAttempts = options.reviewMaxAttempts ?? DEFAULT_REVIEW_MAX_ATTEMPTS;
  const counts: AutoHealCounts = {
    rescheduledTasks: 0,
    resumedRuns: 0,
    retiredTasks: 0,
    reroutedTasks: 0,
    skippedTasks: 0,
  };

  for (const task of pausedReviewTasks({
    lookbackCutoff: now - lookbackMs,
    cooldownCutoff: now - cooldownMs,
  })) {
    const providerFailureKind = task.provider_failure_kind ?? 'none';
    const allowedAttempts = isReviewLaneTask(task) ? reviewMaxAttempts : maxAttempts;
    const supersedingExecution = findSupersedingExecutionTask(task);
    if (!isReviewLaneTask(task) || !AUTO_HEAL_PROVIDER_FAILURES.has(providerFailureKind)) {
      counts.skippedTasks += 1;
      continue;
    }
    if (supersedingExecution) {
      const summary = `Retired paused review task for ${task.agent} because a newer ${supersedingExecution.workflow_kind ?? 'execution'} pass (${supersedingExecution.agent}) superseded it.`;
      updateTaskRuntimeState({
        taskId: task.id,
        status: 'failed',
        error: `${task.error ?? 'Paused review task'} | ${summary}`,
        retryClass: 'manual_pause',
        retryAt: null,
        providerFailureKind: providerFailureKind,
      });

      const run = latestRunForGoalAgent(task.goal_id, task.agent);
      if (run && (run.status === 'paused' || run.status === 'retry_scheduled')) {
        updateRunStatus({
          runId: run.id,
          status: 'failed',
          retryClass: 'manual_pause',
          retryAt: null,
          providerFailureKind: providerFailureKind as 'transport_error' | 'overload' | 'timeout' | 'rate_limit',
          summary,
        });
      }

      if (task.goal_id) {
        appendRunProgress(task.goal_id, [
          `- Retired superseded paused review task **${task.agent}** after a newer execution pass took over`,
        ]);
      }

      counts.retiredTasks += 1;
      continue;
    }
    if ((task.attempt_count ?? 0) >= allowedAttempts) {
      if (createReviewFallbackTask(task)) {
        counts.reroutedTasks += 1;
        continue;
      }
      counts.skippedTasks += 1;
      continue;
    }
    if (hasActiveEquivalentTask(task)) {
      counts.skippedTasks += 1;
      continue;
    }

    const retryAt = now + retryDelayMs;
    const retryClass = retryClassForFailureKind(providerFailureKind);
    const summary = `Auto-healed paused review task for ${task.agent} after ${Math.round(cooldownMs / 60_000)} minutes. Scheduling a bounded retry.`;
    updateTaskRuntimeState({
      taskId: task.id,
      status: 'retry_scheduled',
      error: task.error ?? summary,
      retryClass,
      retryAt,
      providerFailureKind,
    });

    const run = latestRunForGoalAgent(task.goal_id, task.agent);
    if (run && run.status === 'paused') {
      updateRunStatus({
        runId: run.id,
        status: 'retry_scheduled',
        retryClass,
        retryAt,
        providerFailureKind: providerFailureKind as 'transport_error' | 'overload' | 'timeout' | 'rate_limit',
        summary,
      });
      counts.resumedRuns += 1;
    }

    if (task.goal_id) {
      appendRunProgress(task.goal_id, [
        `- Auto-heal scheduled a new retry for paused review task **${task.agent}**`,
      ]);
    }

    counts.rescheduledTasks += 1;
  }

  return counts;
}
