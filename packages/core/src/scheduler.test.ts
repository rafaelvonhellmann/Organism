import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { loadProjectPolicy } = await import('./project-policy.js');
const { getDb } = await import('./task-queue.js');
const { ensureGoal, createRunSession, updateRunStatus, getGoal, getRunSession } = await import('./run-state.js');
const { buildScheduledProjectRuns, getSchedulePeriodKey, isScheduledProjectRunDue, autoCompleteEligibleAwaitingReviewTasks } = await import('./scheduler.js');

describe('scheduler self-audit lane', () => {
  it('builds a dedicated Organism self-audit schedule from project policy', () => {
    const organismPolicy = loadProjectPolicy('organism');
    const schedules = buildScheduledProjectRuns([organismPolicy]);
    const schedule = schedules.find((entry) => entry.id === 'self-audit:organism');

    assert.ok(schedule);
    assert.equal(schedule?.kind, 'self_audit');
    assert.equal(schedule?.projectId, 'organism');
    assert.equal(schedule?.cadence, 'daily');
    assert.equal(schedule?.hour, 8);
    assert.equal(schedule?.agent, 'quality-agent');
    assert.equal(schedule?.workflowKind, 'review');
    assert.equal(schedule?.input.selfAudit, true);
  });

  it('runs the self-audit once per daily period after its configured hour', () => {
    const organismPolicy = loadProjectPolicy('organism');
    const schedule = buildScheduledProjectRuns([organismPolicy]).find((entry) => entry.id === 'self-audit:organism');
    assert.ok(schedule);

    const beforeWindow = new Date('2026-04-12T07:59:00+10:00');
    const dueWindow = new Date('2026-04-12T08:05:00+10:00');
    const periodKey = getSchedulePeriodKey(schedule!, dueWindow);

    assert.equal(isScheduledProjectRunDue(schedule!, beforeWindow, null), false);
    assert.equal(isScheduledProjectRunDue(schedule!, dueWindow, null), true);
    assert.equal(isScheduledProjectRunDue(schedule!, dueWindow, periodKey), false);
  });

  it('auto-completes legacy Synapse read-only reviews that no longer need a human gate', () => {
    const db = getDb();
    const now = Date.now();
    const goal = ensureGoal({
      projectId: 'synapse',
      title: 'Medical-safe read-only canary review for synapse',
      description: 'medical-safe read-only canary review for synapse',
      sourceKind: 'dashboard',
      workflowKind: 'review',
    });
    const run = createRunSession({
      goalId: goal.id,
      projectId: 'synapse',
      agent: 'ceo',
      workflowKind: 'review',
    });
    updateRunStatus({
      runId: run.id,
      status: 'paused',
      retryClass: 'manual_pause',
      summary: 'Awaiting Rafael review',
    });

    const taskId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO tasks (
        id, agent, status, lane, description, input, input_hash, output, project_id, goal_id, workflow_kind, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      'ceo',
      'awaiting_review',
      'HIGH',
      'medical-safe read-only canary review for synapse grading and viva feedback posture',
      '{}',
      crypto.randomUUID(),
      '{}',
      'synapse',
      goal.id,
      'review',
      now - 10_000,
      now - 9_000,
      now - 5_000,
    );

    const completed = autoCompleteEligibleAwaitingReviewTasks(now);
    assert.equal(completed, 1);

    const taskRow = db.prepare('SELECT status, lane FROM tasks WHERE id = ?').get(taskId) as {
      status: string;
      lane: string;
    };
    assert.equal(taskRow.status, 'completed');
    assert.equal(taskRow.lane, 'MEDIUM');

    const goalRow = getGoal(goal.id);
    const runRow = getRunSession(run.id);
    assert.equal(goalRow?.status, 'completed');
    assert.equal(runRow?.status, 'completed');
  });
});
