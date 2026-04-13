import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { getDb } = await import('./task-queue.js');
const { getIdleAutonomyProjects, cleanupStaleOrphanedReviewTasks, cleanupStaleBlockedReviewGoals } = await import('./autonomy-loop.js');

describe('autonomy loop', () => {
  it('targets Organism, Tokens for Good, and the Synapse medical-safe canary lane', () => {
    const projects = getIdleAutonomyProjects();
    assert.ok(projects.includes('organism'));
    assert.ok(projects.includes('tokens-for-good'));
    assert.ok(projects.includes('synapse'));
  });

  it('archives stale orphaned paused review tasks so they stop blocking idle autonomy', () => {
    const db = getDb();
    const taskId = crypto.randomUUID();
    const now = Date.now();

    db.prepare(`
      INSERT INTO tasks (
        id, agent, status, lane, description, input, input_hash, project_id, created_at, error, workflow_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      'quality-agent',
      'paused',
      'LOW',
      'Batch quality review: 5 tasks',
      '{}',
      'hash',
      'tokens-for-good',
      now - (2 * 60 * 60 * 1000),
      'Recovered orphaned task after daemon restart for quality-agent. Manual intervention required after repeated attempts.',
      'validate',
    );

    const archived = cleanupStaleOrphanedReviewTasks('tokens-for-good', now);
    assert.equal(archived, 1);

    const row = db.prepare('SELECT status, completed_at, error FROM tasks WHERE id = ?').get(taskId) as {
      status: string;
      completed_at: number | null;
      error: string;
    };
    assert.equal(row.status, 'failed');
    assert.ok(row.completed_at);
    assert.match(row.error, /Archived stale orphaned review blocker/);
  });

  it('fails stale blocked monitor goals with no active queue work', () => {
    const db = getDb();
    const goalId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const now = Date.now();

    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, status, source_kind, workflow_kind, input_hash, created_at, updated_at, latest_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goalId,
      'tokens-for-good',
      'Resume paused review pipeline',
      'Resume the paused review pipeline after transport issues',
      'retry_scheduled',
      'monitor',
      'validate',
      crypto.randomUUID(),
      now - (2 * 60 * 60 * 1000),
      now - (2 * 60 * 60 * 1000),
      runId,
    );

    db.prepare(`
      INSERT INTO run_sessions (
        id, goal_id, project_id, agent, workflow_kind, status, retry_class, retry_at, provider_failure_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      goalId,
      'tokens-for-good',
      'quality-agent',
      'validate',
      'retry_scheduled',
      'transient_error',
      now - 60_000,
      'transport_error',
      now - (2 * 60 * 60 * 1000),
      now - (2 * 60 * 60 * 1000),
    );

    const cleaned = cleanupStaleBlockedReviewGoals('tokens-for-good', now);
    assert.equal(cleaned.goals, 1);
    assert.equal(cleaned.runs, 1);

    const goalRow = db.prepare('SELECT status FROM goals WHERE id = ?').get(goalId) as { status: string };
    const runRow = db.prepare('SELECT status FROM run_sessions WHERE id = ?').get(runId) as { status: string };
    assert.equal(goalRow.status, 'failed');
    assert.equal(runRow.status, 'failed');
  });
});
