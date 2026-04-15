import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, getDb, getTask } from './task-queue.js';
import { createRunSession, createRunStep, ensureGoal, getRunSession, listArtifacts, listRunSteps } from './run-state.js';
import { autoHealPausedReviewTasks, recoverInterruptedWork } from './run-recovery.js';

function resetRuntimeState() {
  const db = getDb();
  db.exec(`
    DELETE FROM runtime_events;
    DELETE FROM approvals;
    DELETE FROM interrupts;
    DELETE FROM artifacts;
    DELETE FROM run_steps;
    DELETE FROM run_sessions;
    DELETE FROM goals;
    DELETE FROM tasks;
  `);
}

describe('run-recovery', () => {
  beforeEach(() => {
    resetRuntimeState();
  });

  it('recovers orphaned running work into a scheduled retry', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Resume controller work',
      description: 'Resume controller work after daemon restart',
      sourceKind: 'monitor',
      workflowKind: 'recover',
    });
    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'engineering',
      workflowKind: 'recover',
    });
    getDb().prepare(`UPDATE run_sessions SET status = 'running' WHERE id = ?`).run(run.id);
    const step = createRunStep({
      runId: run.id,
      name: 'agent:engineering:execute',
      detail: 'Controller was mid-flight',
    });
    getDb().prepare(`UPDATE run_steps SET status = 'running' WHERE id = ?`).run(step.id);

    const task = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Recover goal: Resume controller work',
      input: { projectId: 'organism', recovery: true },
      projectId: 'organism',
      goalId: goal.id,
      workflowKind: 'recover',
      sourceKind: 'monitor',
    });
    getDb().prepare(`UPDATE tasks SET status = 'in_progress', attempt_count = 1 WHERE id = ?`).run(task.id);

    const recovered = recoverInterruptedWork({ now: 1_000_000, retryDelayMs: 60_000 });
    const updatedRun = getRunSession(run.id);
    const updatedTask = getTask(task.id);
    const updatedStep = listRunSteps(run.id).find((item) => item.id === step.id);
    const artifacts = listArtifacts(goal.id);

    assert.equal(recovered.recoveredRuns, 1);
    assert.equal(recovered.retriedTasks, 1);
    assert.equal(updatedRun?.status, 'retry_scheduled');
    assert.equal(updatedRun?.providerFailureKind, 'transport_error');
    assert.equal(updatedTask?.status, 'retry_scheduled');
    assert.equal(updatedTask?.retryAt, 1_060_000);
    assert.equal(updatedStep?.status, 'paused');
    assert.ok(artifacts.some((artifact) => artifact.kind === 'checkpoint'));
  });

  it('pauses exhausted orphaned work instead of retrying forever', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Exhausted recovery',
      description: 'Pause exhausted orphaned work',
      sourceKind: 'monitor',
      workflowKind: 'recover',
    });
    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'engineering',
      workflowKind: 'recover',
    });
    getDb().prepare(`UPDATE run_sessions SET status = 'running' WHERE id = ?`).run(run.id);
    const task = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Recover exhausted task',
      input: { projectId: 'organism', recovery: true },
      projectId: 'organism',
      goalId: goal.id,
      workflowKind: 'recover',
      sourceKind: 'monitor',
    });

    getDb().prepare(`UPDATE tasks SET status = 'in_progress', attempt_count = 5 WHERE id = ?`).run(task.id);

    recoverInterruptedWork({ now: 2_000_000, retryDelayMs: 60_000, maxAttempts: 5 });

    const updatedRun = getRunSession(run.id);
    const updatedTask = getTask(task.id);

    assert.equal(updatedRun?.status, 'paused');
    assert.equal(updatedTask?.status, 'paused');
    assert.equal(updatedTask?.retryClass, 'manual_pause');
  });

  it('preserves recoverable provider failures when exhausted recovery pauses a task', () => {
    const goal = ensureGoal({
      projectId: 'tokens-for-good',
      title: 'Preserve provider failure history',
      description: 'Keep transport errors visible after stale recovery',
      sourceKind: 'monitor',
      workflowKind: 'validate',
    });
    const run = createRunSession({
      goalId: goal.id,
      projectId: 'tokens-for-good',
      agent: 'codex-review',
      workflowKind: 'validate',
    });
    getDb().prepare(`UPDATE run_sessions SET status = 'running' WHERE id = ?`).run(run.id);
    const task = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review: preserve transport failure',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          attempt_count = 8,
          provider_failure_kind = 'transport_error',
          error = 'TypeError: fetch failed'
      WHERE id = ?
    `).run(task.id);

    recoverInterruptedWork({ now: 2_000_000, retryDelayMs: 60_000, maxAttempts: 5 });

    const updatedRun = getRunSession(run.id);
    const updatedTask = getTask(task.id);

    assert.equal(updatedRun?.status, 'paused');
    assert.equal(updatedRun?.providerFailureKind, 'transport_error');
    assert.equal(updatedTask?.status, 'paused');
    assert.equal(updatedTask?.providerFailureKind, 'transport_error');
    assert.match(updatedTask?.error ?? '', /fetch failed/i);
    assert.match(updatedTask?.error ?? '', /Recovered orphaned run/i);
  });

  it('does not reschedule policy-blocked work during daemon recovery', () => {
    const goal = ensureGoal({
      projectId: 'tokens-for-good',
      title: 'Respect external write blocks',
      description: 'Do not retry plan-blocked SQL writes automatically',
      sourceKind: 'monitor',
      workflowKind: 'recover',
    });
    const run = createRunSession({
      goalId: goal.id,
      projectId: 'tokens-for-good',
      agent: 'engineering',
      workflowKind: 'recover',
    });
    getDb().prepare(`UPDATE run_sessions SET status = 'running' WHERE id = ?`).run(run.id);

    const task = createTask({
      agent: 'engineering',
      lane: 'HIGH',
      description: 'Recover blocked SQL write implementation',
      input: { projectId: 'tokens-for-good', recovery: true },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'recover',
      sourceKind: 'monitor',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          attempt_count = 1,
          error = 'SQL write operations are forbidden (writes are blocked, do you need to upgrade your plan?)'
      WHERE id = ?
    `).run(task.id);

    const recovered = recoverInterruptedWork({ now: 3_000_000, retryDelayMs: 60_000, maxAttempts: 5 });
    const updatedRun = getRunSession(run.id);
    const updatedTask = getTask(task.id);

    assert.equal(recovered.recoveredRuns, 1);
    assert.equal(recovered.retriedTasks, 0);
    assert.equal(recovered.pausedTasks, 1);
    assert.equal(updatedRun?.status, 'paused');
    assert.equal(updatedRun?.providerFailureKind, 'policy_block');
    assert.equal(updatedTask?.status, 'paused');
    assert.equal(updatedTask?.providerFailureKind, 'policy_block');
    assert.equal(updatedTask?.retryAt, null);
  });

  it('auto-heals paused review work after transport failures', () => {
    const goal = ensureGoal({
      projectId: 'tokens-for-good',
      title: 'Resume paused review pipeline',
      description: 'Resume the paused review pipeline after transport issues',
      sourceKind: 'monitor',
      workflowKind: 'validate',
    });
    const run = createRunSession({
      goalId: goal.id,
      projectId: 'tokens-for-good',
      agent: 'quality-agent',
      workflowKind: 'validate',
      status: 'paused',
    });
    const task = createTask({
      agent: 'quality-agent',
      lane: 'LOW',
      description: 'Batch quality review: 5 tasks',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'paused',
          attempt_count = 5,
          provider_failure_kind = 'transport_error',
          error = 'Error: Connection error. | Retry limit reached after repeated autonomous attempts',
          completed_at = ?
      WHERE id = ?
    `).run(1_000_000 - 10_000, task.id);

    const healed = autoHealPausedReviewTasks({
      now: 1_000_000,
      retryDelayMs: 120_000,
      cooldownMs: 1_000,
      lookbackMs: 60_000,
      maxAttempts: 5,
      reviewMaxAttempts: 8,
    });

    const updatedRun = getRunSession(run.id);
    const updatedTask = getTask(task.id);

    assert.equal(healed.rescheduledTasks, 1);
    assert.equal(healed.resumedRuns, 1);
    assert.equal(updatedRun?.status, 'retry_scheduled');
    assert.equal(updatedTask?.status, 'retry_scheduled');
    assert.equal(updatedTask?.retryAt, 1_120_000);
  });

  it('retires paused review debt when a newer execution pass supersedes it', () => {
    const goal = ensureGoal({
      projectId: 'tokens-for-good',
      title: 'Autonomy cycle: tokens-for-good',
      description: 'Run the next bounded autonomy cycle',
      sourceKind: 'system',
      workflowKind: 'review',
    });
    const pausedRun = createRunSession({
      goalId: goal.id,
      projectId: 'tokens-for-good',
      agent: 'codex-review',
      workflowKind: 'validate',
      status: 'paused',
    });
    const pausedTask = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review: "Extend hosted validator canary mode"',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });
    const executionTask = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Recover the preserved implementation from branch `agent/engineering/fix-hosted-validator`',
      input: { projectId: 'tokens-for-good', execution: true },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'recover',
      sourceKind: 'agent_followup',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'paused',
          attempt_count = 8,
          provider_failure_kind = 'transport_error',
          error = 'TypeError: fetch failed | Retry limit reached after repeated autonomous attempts',
          created_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(900_000, 990_000, pausedTask.id);
    getDb().prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          created_at = ?
      WHERE id = ?
    `).run(1_000_000, executionTask.id);

    const healed = autoHealPausedReviewTasks({
      now: 1_200_000,
      retryDelayMs: 120_000,
      cooldownMs: 1_000,
      lookbackMs: 1_000_000,
      maxAttempts: 5,
      reviewMaxAttempts: 8,
    });

    const updatedRun = getRunSession(pausedRun.id);
    const updatedTask = getTask(pausedTask.id);

    assert.equal(healed.retiredTasks, 1);
    assert.equal(updatedRun?.status, 'failed');
    assert.equal(updatedTask?.status, 'failed');
    assert.match(updatedTask?.error ?? '', /superseded/i);
  });

  it('reroutes exhausted paused review work into one bounded fallback task', () => {
    const goal = ensureGoal({
      projectId: 'tokens-for-good',
      title: 'Recover hosted validator work',
      description: 'Recover hosted validator work after review failures',
      sourceKind: 'system',
      workflowKind: 'implement',
    });
    const original = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Extend hosted validator canary mode with bounded seeded data',
      input: { projectId: 'tokens-for-good', execution: true },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'implement',
      sourceKind: 'agent_followup',
    });
    getDb().prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(1_300_000, original.id);
    const pausedRun = createRunSession({
      goalId: goal.id,
      projectId: 'tokens-for-good',
      agent: 'codex-review',
      workflowKind: 'validate',
      status: 'paused',
    });
    const pausedTask = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review: "Extend hosted validator canary mode with bounded seeded data"',
      input: { projectId: 'tokens-for-good', originalTaskId: original.id, sourceTaskId: original.id },
      projectId: 'tokens-for-good',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'paused',
          attempt_count = 8,
          provider_failure_kind = 'transport_error',
          error = 'TypeError: fetch failed | Retry limit reached after repeated autonomous attempts',
          completed_at = ?
      WHERE id = ?
    `).run(1_400_000, pausedTask.id);

    const healed = autoHealPausedReviewTasks({
      now: 1_500_000,
      retryDelayMs: 120_000,
      cooldownMs: 1_000,
      lookbackMs: 1_000_000,
      maxAttempts: 5,
      reviewMaxAttempts: 8,
    });

    const updatedRun = getRunSession(pausedRun.id);
    const updatedTask = getTask(pausedTask.id);
    const fallback = getDb().prepare(`
      SELECT agent, workflow_kind, description, parent_task_id, source_kind
      FROM tasks
      WHERE id != ?
        AND source_kind = 'agent_followup'
        AND description LIKE 'Resolve blocked %'
      LIMIT 1
    `).get(pausedTask.id) as {
      agent: string;
      workflow_kind: string;
      description: string;
      parent_task_id: string;
      source_kind: string;
    };

    assert.equal(healed.reroutedTasks, 1);
    assert.equal(updatedRun?.status, 'failed');
    assert.equal(updatedTask?.status, 'failed');
    assert.equal(fallback.agent, 'engineering');
    assert.equal(fallback.workflow_kind, 'implement');
    assert.equal(fallback.parent_task_id, original.id);
    assert.match(fallback.description, /Resolve blocked codex-review review/i);
  });

  it('reroutes exhausted Synapse review work into one allowed read-only fallback task', () => {
    const goal = ensureGoal({
      projectId: 'synapse',
      title: 'Medical-safe review recovery',
      description: 'Recover protected grading review debt without autonomous implementation',
      sourceKind: 'system',
      workflowKind: 'review',
    });
    const original = createTask({
      agent: 'engineering',
      lane: 'HIGH',
      description: 'Update grading rubric answer-key validation pipeline',
      input: { projectId: 'synapse', execution: true },
      projectId: 'synapse',
      goalId: goal.id,
      workflowKind: 'implement',
      sourceKind: 'agent_followup',
    });
    getDb().prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?`).run(1_300_000, original.id);
    const pausedRun = createRunSession({
      goalId: goal.id,
      projectId: 'synapse',
      agent: 'codex-review',
      workflowKind: 'validate',
      status: 'paused',
    });
    const pausedTask = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review: "Update grading rubric answer-key validation pipeline"',
      input: { projectId: 'synapse', originalTaskId: original.id, sourceTaskId: original.id },
      projectId: 'synapse',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'paused',
          attempt_count = 8,
          provider_failure_kind = 'transport_error',
          error = 'TypeError: fetch failed | Retry limit reached after repeated autonomous attempts',
          completed_at = ?
      WHERE id = ?
    `).run(1_400_000, pausedTask.id);

    const healed = autoHealPausedReviewTasks({
      now: 1_500_000,
      retryDelayMs: 120_000,
      cooldownMs: 1_000,
      lookbackMs: 1_000_000,
      maxAttempts: 5,
      reviewMaxAttempts: 8,
    });

    const fallback = getDb().prepare(`
      SELECT agent, workflow_kind, description
      FROM tasks
      WHERE id != ?
        AND source_kind = 'agent_followup'
        AND description LIKE 'Resolve blocked %'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(pausedTask.id) as { agent: string; workflow_kind: string; description: string };

    assert.equal(healed.reroutedTasks, 1);
    assert.equal(fallback.agent, 'quality-agent');
    assert.equal(fallback.workflow_kind, 'validate');
    assert.match(fallback.description, /Resolve blocked codex-review review/i);
    assert.equal(getRunSession(pausedRun.id)?.status, 'failed');
  });

  it('auto-heals masked paused review work by inferring historical transport failures', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Scheduled self-audit of organism',
      description: 'Recover paused validator after daemon restart masking',
      sourceKind: 'system',
      workflowKind: 'review',
    });
    const historicalTask = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review historical retry',
      input: { projectId: 'organism' },
      projectId: 'organism',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });
    getDb().prepare(`
      UPDATE tasks
      SET status = 'failed',
          attempt_count = 4,
          provider_failure_kind = 'transport_error',
          error = 'TypeError: fetch failed',
          completed_at = ?
      WHERE id = ?
    `).run(850_000, historicalTask.id);

    const pausedRun = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'codex-review',
      workflowKind: 'validate',
      status: 'paused',
    });
    const pausedTask = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review paused after restart masking',
      input: { projectId: 'organism' },
      projectId: 'organism',
      goalId: goal.id,
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });
    getDb().prepare(`
      UPDATE tasks
      SET status = 'paused',
          attempt_count = 5,
          provider_failure_kind = 'tool_failure',
          error = 'Recovered orphaned run after daemon restart for codex-review. Resuming from the latest verified checkpoint.',
          completed_at = ?
      WHERE id = ?
    `).run(900_000, pausedTask.id);

    const healed = autoHealPausedReviewTasks({
      now: 1_000_000,
      retryDelayMs: 120_000,
      cooldownMs: 1_000,
      lookbackMs: 500_000,
      maxAttempts: 5,
      reviewMaxAttempts: 8,
    });

    const updatedRun = getRunSession(pausedRun.id);
    const updatedTask = getTask(pausedTask.id);

    assert.equal(healed.rescheduledTasks, 1);
    assert.equal(updatedRun?.status, 'retry_scheduled');
    assert.equal(updatedRun?.providerFailureKind, 'transport_error');
    assert.equal(updatedTask?.status, 'retry_scheduled');
    assert.equal(updatedTask?.providerFailureKind, 'transport_error');
    assert.equal(updatedTask?.retryAt, 1_120_000);
  });
});
