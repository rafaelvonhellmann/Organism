import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

import { createInterrupt, createRunSession, ensureGoal, updateRunStatus } from './run-state.js';
import { getDb } from './task-queue.js';
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
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Ship the controller',
      description: 'Ship the controller safely',
      sourceKind: 'user',
      workflowKind: 'implement',
    });

    for (let index = 0; index < 3; index++) {
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
});
