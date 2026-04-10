import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, getDb, getTask } from './task-queue.js';
import { createRunSession, createRunStep, ensureGoal, getRunSession, listArtifacts, listRunSteps } from './run-state.js';
import { recoverInterruptedWork } from './run-recovery.js';

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
});
