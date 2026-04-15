import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

import { createInterrupt, createRunSession, ensureGoal, updateRunStatus } from './run-state.js';
import { createTask, getDb, updateTaskRuntimeState } from './task-queue.js';
import { getProjectAutonomyHealth } from './autonomy-governor.js';

function resetRuntimeState() {
  getDb().exec(`
    DELETE FROM runtime_events;
    DELETE FROM approvals;
    DELETE FROM interrupts;
    DELETE FROM artifacts;
    DELETE FROM run_steps;
    DELETE FROM run_sessions;
    DELETE FROM goals;
  `);
}

describe('autonomy-governor', () => {
  beforeEach(() => {
    resetRuntimeState();
  });

  it('tracks consecutive healthy runs for a project', () => {
    for (let index = 0; index < 3; index++) {
      const goal = ensureGoal({
        projectId: 'organism',
        title: `Ship the controller ${index + 1}`,
        description: `Ship the controller safely ${index + 1}`,
        sourceKind: 'user',
        workflowKind: 'implement',
        dedupeSeed: `controller-${index + 1}`,
      });
      const run = createRunSession({
        goalId: goal.id,
        projectId: 'organism',
        agent: 'engineering',
        workflowKind: 'implement',
      });
      updateRunStatus({ runId: run.id, status: 'completed', summary: `Run ${index + 1} completed` });
    }

    const health = getProjectAutonomyHealth('organism');
    assert.equal(health.consecutiveHealthyRuns, 3);
    assert.equal(health.rolloutReady, false);
    assert.equal(health.rolloutStage, 'bounded');
    assert.equal(health.nextRolloutStage, 'deploy_ready');
    assert.equal(health.nextRolloutThreshold, 5);
    assert.ok(health.blockers.some((blocker) => blocker.includes('low-risk deploys')));
  });

  it('ignores superseded provider failures once the latest run for the same goal and agent completes cleanly', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Recover review lane',
      description: 'Recover review lane after transport noise',
      sourceKind: 'system',
      workflowKind: 'recover',
    });

    const failedAttempt = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'codex-review',
      workflowKind: 'recover',
    });
    updateRunStatus({
      runId: failedAttempt.id,
      status: 'retry_scheduled',
      retryClass: 'transient_error',
      retryAt: Date.now() + 60_000,
      providerFailureKind: 'transport_error',
      summary: 'fetch failed',
    });

    const recoveredAttempt = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'codex-review',
      workflowKind: 'recover',
    });
    updateRunStatus({
      runId: recoveredAttempt.id,
      status: 'completed',
      summary: 'Recovered cleanly',
    });

    const health = getProjectAutonomyHealth('organism');
    assert.equal(health.consecutiveHealthyRuns, 1);
    assert.equal(health.recentProviderFailures, 0);
    assert.equal(
      health.blockers.some((blocker) => blocker.includes('provider failures')),
      false,
    );
  });

  it('surfaces pending interrupts as rollout blockers', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Handle deployment pause',
      description: 'Handle deployment pause after approval requirement',
      sourceKind: 'monitor',
      workflowKind: 'recover',
    });

    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'devops',
      workflowKind: 'recover',
    });

    createInterrupt({
      runId: run.id,
      type: 'approval',
      summary: 'Deploy requires approval',
      detail: 'Waiting for rollout approval',
    });

    const health = getProjectAutonomyHealth('organism');
    assert.equal(health.pendingInterrupts, 1);
    assert.ok(health.blockers.some((blocker) => blocker.includes('interrupts')));
  });

  it('does not count completed runs as healthy when the latest related task still has retry debt', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Bounded implementation run',
      description: 'Bounded implementation run',
      sourceKind: 'system',
      workflowKind: 'implement',
    });

    const run = createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'engineering',
      workflowKind: 'implement',
    });
    updateRunStatus({
      runId: run.id,
      status: 'completed',
      summary: 'Implementation finished',
    });

    const task = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Implementation finished with hidden retry debt',
      input: { projectId: 'organism' },
      projectId: 'organism',
      goalId: goal.id,
      workflowKind: 'implement',
      sourceKind: 'system',
    });
    updateTaskRuntimeState({
      taskId: task.id,
      status: 'paused',
      retryClass: 'manual_pause',
      providerFailureKind: 'transport_error',
      error: 'fetch failed | Retry limit reached after repeated autonomous attempts',
    });

    const health = getProjectAutonomyHealth('organism');
    assert.equal(health.consecutiveHealthyRuns, 0);
    assert.ok(health.blockers.some((blocker) => blocker.includes('healthy runs')));
  });
});
