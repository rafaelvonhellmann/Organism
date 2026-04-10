import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, getDb, getTask, releaseRetryScheduledTasks, updateTaskRuntimeState } from './task-queue.js';

function resetTasks() {
  getDb().exec(`
    DELETE FROM tasks;
  `);
}

describe('task-queue retry release', () => {
  beforeEach(() => {
    resetTasks();
  });

  it('releases retry_scheduled tasks back to pending when the retry window has passed', () => {
    const task = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Retry controller execution',
      input: { projectId: 'organism' },
      projectId: 'organism',
      retryClass: 'provider_overload',
      retryAt: null,
      providerFailureKind: 'overload',
    });

    getDb().prepare(`
      UPDATE tasks
      SET status = 'retry_scheduled', retry_at = ?, attempt_count = 2
      WHERE id = ?
    `).run(Date.now() - 1_000, task.id);

    const result = releaseRetryScheduledTasks(Date.now(), 5);
    const updated = getTask(task.id);

    assert.equal(result.released, 1);
    assert.equal(result.paused, 0);
    assert.equal(updated?.status, 'pending');
    assert.equal(updated?.retryAt, null);
  });

  it('pauses exhausted retries instead of looping forever', () => {
    const task = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Retry until exhausted',
      input: { projectId: 'organism' },
      projectId: 'organism',
    });

    updateTaskRuntimeState({
      taskId: task.id,
      status: 'retry_scheduled',
      retryClass: 'provider_overload',
      retryAt: Date.now() - 1_000,
      providerFailureKind: 'overload',
      error: 'Provider overloaded',
    });
    getDb().prepare('UPDATE tasks SET attempt_count = 5 WHERE id = ?').run(task.id);

    const result = releaseRetryScheduledTasks(Date.now(), 5);
    const updated = getTask(task.id);

    assert.equal(result.released, 0);
    assert.equal(result.paused, 1);
    assert.equal(updated?.status, 'paused');
    assert.equal(updated?.retryClass, 'manual_pause');
  });
});
