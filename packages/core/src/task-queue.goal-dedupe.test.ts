import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, getDb } from './task-queue.js';

function resetTasks() {
  getDb().exec(`
    DELETE FROM tasks;
  `);
}

describe('task-queue goal dedupe', () => {
  beforeEach(() => {
    resetTasks();
  });

  it('blocks duplicate active tasks for the same goal, agent, and workflow', () => {
    createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Recover goal: stabilize runtime',
      input: { recovery: true },
      projectId: 'organism',
      goalId: 'goal-1',
      workflowKind: 'recover',
      sourceKind: 'monitor',
    });

    assert.throws(() => {
      createTask({
        agent: 'engineering',
        lane: 'MEDIUM',
        description: 'Recover goal: stabilize runtime again',
        input: { recovery: true, duplicate: true },
        projectId: 'organism',
        goalId: 'goal-1',
        workflowKind: 'recover',
        sourceKind: 'monitor',
      });
    }, /Active goal task already exists/i);
  });
});
