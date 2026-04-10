import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, getDb, getTask } from './task-queue.js';
import { createRunSession, createRunStep, ensureGoal, getRunSession } from './run-state.js';
import { recoverWorkOnStartup } from '../../../scripts/start-daemon.js';

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

describe('daemon startup recovery', () => {
  beforeEach(() => {
    resetRuntimeState();
  });

  it('recovers interrupted work before the scheduler and runner resume', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Daemon restart recovery',
      description: 'Recover interrupted work on daemon startup',
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
      detail: 'Execution was interrupted during startup test',
    });
    getDb().prepare(`UPDATE run_steps SET status = 'running' WHERE id = ?`).run(step.id);

    const task = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Recover daemon startup run',
      input: { projectId: 'organism', recovery: true },
      projectId: 'organism',
      goalId: goal.id,
      workflowKind: 'recover',
      sourceKind: 'monitor',
    });
    getDb().prepare(`UPDATE tasks SET status = 'in_progress', attempt_count = 1 WHERE id = ?`).run(task.id);

    const logs: string[] = [];
    const recovered = recoverWorkOnStartup((line) => logs.push(line));
    const updatedRun = getRunSession(run.id);
    const updatedTask = getTask(task.id);

    assert.equal(recovered.recoveredRuns, 1);
    assert.equal(recovered.retriedTasks, 1);
    assert.equal(updatedRun?.status, 'retry_scheduled');
    assert.equal(updatedTask?.status, 'retry_scheduled');
    assert.match(logs.join('\n'), /Recovered interrupted work: 1 run\(s\), 1 retry task\(s\), 0 paused task\(s\)/);
  });
});
