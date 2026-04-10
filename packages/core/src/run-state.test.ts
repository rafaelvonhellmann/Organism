import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './task-queue.js';
import { ensureGoal, createRunSession, updateRunStatus, getGoal, mapProviderFailure } from './run-state.js';
import { listRuntimeEvents, clearRuntimeEventsForTests } from './runtime-events.js';

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
    assert.equal(mapProviderFailure('Requested code executor "claude" is not available on PATH').providerFailureKind, 'tool_failure');
  });
});
