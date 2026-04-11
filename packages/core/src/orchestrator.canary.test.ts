import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getTask } from './task-queue.js';
import { submitTask } from './orchestrator.js';

describe('orchestrator early canary guard', () => {
  beforeEach(() => {
    getDb().exec(`
      DELETE FROM runtime_events;
      DELETE FROM approvals;
      DELETE FROM interrupts;
      DELETE FROM artifacts;
      DELETE FROM run_steps;
      DELETE FROM run_sessions;
      DELETE FROM goals;
      DELETE FROM tasks;
    `);
  });

  it('blocks disallowed early workflows for Tokens for Good', async () => {
    await assert.rejects(
      submitTask(
        {
          description: 'deploy the latest Tokens for Good portal changes',
          input: { projectId: 'tokens-for-good' },
          projectId: 'tokens-for-good',
        },
        {
          projectId: 'tokens-for-good',
          workflowKind: 'ship',
        },
      ),
      /EARLY CANARY GUARD/i,
    );
  });

  it('allows review workflows for Tokens for Good during the canary phase', async () => {
    const taskId = await submitTask(
      {
        description: 'review project',
        input: { projectId: 'tokens-for-good' },
        projectId: 'tokens-for-good',
      },
      {
        projectId: 'tokens-for-good',
        workflowKind: 'review',
      },
    );

    assert.ok(taskId);
    const task = getTask(taskId);
    assert.ok(task);
    assert.equal(task?.workflowKind, 'review');
    assert.equal(task?.description.startsWith('[SHAPING]'), false);
  });
});
