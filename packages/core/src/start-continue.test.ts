import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { getDb } = await import('./task-queue.js');
const { decideProjectStart } = await import('./start-continue.js');
const { loadProjectPolicy } = await import('./project-policy.js');

function resetState() {
  const db = getDb();
  db.exec(`
    DELETE FROM tasks;
    DELETE FROM goals;
    DELETE FROM run_sessions;
    DELETE FROM run_steps;
    DELETE FROM interrupts;
    DELETE FROM approvals;
    DELETE FROM artifacts;
    DELETE FROM runtime_events;
  `);
}

function insertCompletedGoal(projectId: string, workflowKind: string, updatedAt: number) {
  const db = getDb();
  db.prepare(`
    INSERT INTO goals (
      id, project_id, title, description, status, source_kind, workflow_kind, input_hash, created_at, updated_at, latest_run_id
    ) VALUES (?, ?, ?, ?, 'completed', 'dashboard', ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    projectId,
    `${workflowKind} goal`,
    `${workflowKind} goal`,
    workflowKind,
    crypto.randomUUID(),
    updatedAt - 1_000,
    updatedAt,
    crypto.randomUUID(),
  );
}

describe('start-continue', () => {
  beforeEach(() => {
    resetState();
  });

  it('defaults to review when the project is still inside the early launch guard', () => {
    const decision = decideProjectStart('tokens-for-good');
    assert.equal(decision.workflowKind, 'review');
    assert.equal(decision.mode, 'review');
  });

  it('continues current work when active tasks or runs already exist', () => {
    const db = getDb();
    const now = Date.now();

    db.prepare(`
      INSERT INTO tasks (
        id, agent, status, lane, description, input, input_hash, project_id, created_at, workflow_kind
      ) VALUES (?, ?, 'pending', 'LOW', ?, '{}', ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      'quality-agent',
      'Project review of tokens-for-good',
      crypto.randomUUID(),
      'tokens-for-good',
      now,
      'review',
    );

    const decision = decideProjectStart('tokens-for-good');
    assert.equal(decision.mode, 'continue');
  });

  it('chooses implement after a recent completed review once the initial guard is satisfied', () => {
    const policy = loadProjectPolicy('tokens-for-good');
    const now = Date.now();

    for (let index = 0; index < policy.launchGuards.initialWorkflowLimit; index++) {
      insertCompletedGoal('tokens-for-good', index === 0 ? 'review' : 'validate', now - (policy.launchGuards.initialWorkflowLimit - index) * 60_000);
    }

    const decision = decideProjectStart('tokens-for-good');
    assert.equal(decision.workflowKind, 'implement');
    assert.equal(decision.mode, 'implement');
  });

  it('chooses validate after a recent completed implementation', () => {
    const policy = loadProjectPolicy('tokens-for-good');
    const now = Date.now();

    for (let index = 0; index < policy.launchGuards.initialWorkflowLimit - 1; index++) {
      insertCompletedGoal('tokens-for-good', 'review', now - (index + 2) * 60_000);
    }
    insertCompletedGoal('tokens-for-good', 'implement', now);

    const decision = decideProjectStart('tokens-for-good');
    assert.equal(decision.workflowKind, 'validate');
    assert.equal(decision.mode, 'validate');
  });
});
