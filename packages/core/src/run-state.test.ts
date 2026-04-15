import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { getDb } = await import('./task-queue.js');
const { ensureGoal, createRunSession, createRunStep, updateRunStatus, updateRunStep, getGoal, getRunSession, mapProviderFailure } = await import('./run-state.js');
const { listRuntimeEvents, clearRuntimeEventsForTests } = await import('./runtime-events.js');

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
  `);
  clearRuntimeEventsForTests();
}

describe('run-state', () => {
  beforeEach(() => {
    resetRuntimeState();
  });

  it('reuses the same goal id for repeated submissions of the same work', () => {
    const goalA = ensureGoal({
      projectId: 'organism',
      title: 'Stabilize runtime controller',
      description: 'Stabilize runtime controller for the forked dashboard',
      sourceKind: 'user',
      workflowKind: 'implement',
    });
    const goalB = ensureGoal({
      projectId: 'organism',
      title: 'Stabilize runtime controller',
      description: 'Stabilize runtime controller for the forked dashboard',
      sourceKind: 'user',
      workflowKind: 'implement',
    });

    assert.equal(goalA.id, goalB.id);
  });

  it('updates goal status and emits runtime events when a run is paused for retry', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Recover provider outage',
      description: 'Recover provider outage in the autonomous loop',
      sourceKind: 'monitor',
      workflowKind: 'recover',
    });

    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'engineering',
      workflowKind: 'recover',
    });

    assert.equal(run.status, 'running');

    updateRunStatus({
      runId: run.id,
      status: 'retry_scheduled',
      retryClass: 'provider_overload',
      retryAt: Date.now() + 60_000,
      providerFailureKind: 'overload',
      summary: 'Provider overloaded',
    });

    const updatedGoal = getGoal(goal.id);
    assert.equal(updatedGoal?.status, 'retry_scheduled');

    const events = listRuntimeEvents({ goalId: goal.id });
    assert.ok(events.some((event) => event.eventType === 'run.started'));
    assert.ok(events.some((event) => event.eventType === 'run.paused'));
  });

  it('maps overloaded provider errors into retry scheduling metadata', () => {
    const mapped = mapProviderFailure('Error 529: overloaded');
    assert.equal(mapped.retryClass, 'provider_overload');
    assert.equal(mapped.providerFailureKind, 'overload');
    assert.ok(mapped.pauseUntilMs);
  });

  it('clears transient provider failure metadata when a run resumes cleanly', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Recover validator transport failure',
      description: 'Recover validator transport failure',
      sourceKind: 'system',
      workflowKind: 'recover',
    });

    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'codex-review',
      workflowKind: 'recover',
    });

    updateRunStatus({
      runId: run.id,
      status: 'retry_scheduled',
      retryClass: 'transient_error',
      retryAt: Date.now() + 60_000,
      providerFailureKind: 'transport_error',
      summary: 'fetch failed',
    });

    updateRunStatus({
      runId: run.id,
      status: 'completed',
      summary: 'Recovered cleanly',
    });

    const recovered = getRunSession(run.id);
    assert.equal(recovered?.status, 'completed');
    assert.equal(recovered?.retryClass, 'none');
    assert.equal(recovered?.providerFailureKind, 'none');
    assert.equal(recovered?.retryAt, null);
  });

  it('supports source-specific dedupe seeds for goals', () => {
    const goalA = ensureGoal({
      projectId: 'organism',
      title: 'Git-triggered review',
      description: 'Git-triggered review: feat runtime',
      sourceKind: 'git_watcher',
      workflowKind: 'validate',
      dedupeSeed: 'git:abc123',
    });
    const goalB = ensureGoal({
      projectId: 'organism',
      title: 'Git-triggered review',
      description: 'Git-triggered review: feat runtime',
      sourceKind: 'git_watcher',
      workflowKind: 'validate',
      dedupeSeed: 'git:def456',
    });

    assert.notEqual(goalA.id, goalB.id);
  });

  it('maps auth, policy, and tool failures into non-retryable runtime states', () => {
    assert.equal(mapProviderFailure('Unauthorized: invalid API key').providerFailureKind, 'auth_failure');
    assert.equal(mapProviderFailure('Action "deploy" is not allowed by policy').providerFailureKind, 'policy_block');
    assert.equal(mapProviderFailure('SQL write operations are forbidden (writes are blocked, do you need to upgrade your plan?)').providerFailureKind, 'policy_block');
    assert.equal(mapProviderFailure('Requested code executor "claude" is not available on PATH').providerFailureKind, 'tool_failure');
  });

  it('treats missing run steps as a warning instead of crashing the worker', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Recover missing step',
      description: 'Make run-step updates resilient',
      sourceKind: 'monitor',
      workflowKind: 'recover',
    });

    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'quality-agent',
      workflowKind: 'recover',
    });

    const step = createRunStep({
      runId: run.id,
      name: 'recover-step',
      detail: 'initial',
    });

    getDb().prepare('DELETE FROM run_steps WHERE id = ?').run(step.id);

    const updated = updateRunStep({
      stepId: step.id,
      status: 'failed',
      detail: 'missing',
    });

    assert.equal(updated, null);
  });
});
