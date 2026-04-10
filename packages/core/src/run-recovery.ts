import { getDb, getTask, updateTaskRuntimeState } from './task-queue.js';
import { appendRunProgress } from './run-memory.js';
import { createArtifact, getRunSession, listRunSteps, updateRunStatus, updateRunStep } from './run-state.js';

const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

interface RecoveryCounts {
  recoveredRuns: number;
  retriedTasks: number;
  pausedTasks: number;
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
