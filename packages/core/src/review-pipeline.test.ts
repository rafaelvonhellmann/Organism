import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTaskReviewDecision } from './review-pipeline.js';
import {
  awaitReviewTask,
  createTask,
  getDb,
  getTask,
  getTaskReviewSummary,
  registerTaskReviewRequirement,
} from './task-queue.js';
import { getPendingG4Gates, resolveG4Gate } from './gates.js';
import type { RiskLane } from '../../shared/src/types.js';

function createAwaitingReviewTask(lane: RiskLane) {
  const task = createTask({
    agent: 'engineering',
    lane,
    description: `${lane} lane parent task`,
    input: { test: true },
    projectId: 'organism',
    workflowKind: 'implement',
    sourceKind: 'user',
  });
  awaitReviewTask(task.id, { summary: `${lane} lane output` }, 42, 0.12);
  return getTask(task.id)!;
}

describe('review pipeline control plane', () => {
  beforeEach(() => {
    getDb().exec(`
      DELETE FROM task_review_requirements;
      DELETE FROM gates;
      DELETE FROM tasks;
    `);
  });

  it('keeps MEDIUM work awaiting review until all required reviewers approve', () => {
    const parent = createAwaitingReviewTask('MEDIUM');
    registerTaskReviewRequirement({ parentTaskId: parent.id, reviewer: 'quality-agent' });
    registerTaskReviewRequirement({ parentTaskId: parent.id, reviewer: 'codex-review' });

    const first = applyTaskReviewDecision({
      parentTaskId: parent.id,
      reviewer: 'quality-agent',
      reviewTaskId: 'review-quality',
      approved: true,
      decision: 'APPROVED',
      summary: 'Quality review approved.',
    });

    assert.equal(first.tracked, true);
    assert.equal(first.finalized, false);
    assert.equal(getTask(parent.id)?.status, 'awaiting_review');

    const second = applyTaskReviewDecision({
      parentTaskId: parent.id,
      reviewer: 'codex-review',
      reviewTaskId: 'review-codex',
      approved: true,
      decision: 'APPROVED',
      summary: 'Codex review approved.',
    });

    assert.equal(second.finalized, true);
    assert.equal(getTask(parent.id)?.status, 'completed');

    const summary = getTaskReviewSummary(parent.id);
    assert.equal(summary.total, 2);
    assert.equal(summary.pending, 0);
    assert.equal(summary.allApproved, true);
  });

  it('creates a single G4 gate after HIGH required reviewers approve and resolves on approval', () => {
    const parent = createAwaitingReviewTask('HIGH');
    for (const reviewer of ['quality-agent', 'codex-review', 'quality-guardian']) {
      registerTaskReviewRequirement({ parentTaskId: parent.id, reviewer });
    }

    applyTaskReviewDecision({
      parentTaskId: parent.id,
      reviewer: 'quality-agent',
      reviewTaskId: 'review-quality',
      approved: true,
      decision: 'APPROVED',
      summary: 'Quality review approved.',
    });
    applyTaskReviewDecision({
      parentTaskId: parent.id,
      reviewer: 'codex-review',
      reviewTaskId: 'review-codex',
      approved: true,
      decision: 'APPROVED',
      summary: 'Codex review approved.',
    });

    assert.equal(getPendingG4Gates().length, 0);
    assert.equal(getTask(parent.id)?.status, 'awaiting_review');

    const guardian = applyTaskReviewDecision({
      parentTaskId: parent.id,
      reviewer: 'quality-guardian',
      reviewTaskId: 'review-guardian',
      approved: true,
      decision: 'APPROVED',
      summary: 'Guardian approved the platform health score.',
    });

    assert.equal(guardian.g4Triggered, true);
    assert.equal(getTask(parent.id)?.status, 'awaiting_review');

    const pendingGates = getPendingG4Gates();
    assert.equal(pendingGates.length, 1);

    resolveG4Gate(pendingGates[0]!.id, 'approved', 'Board approved the patch.');
    assert.equal(getTask(parent.id)?.status, 'completed');
  });

  it('fails the parent task when a required reviewer requests revision', () => {
    const parent = createAwaitingReviewTask('LOW');
    registerTaskReviewRequirement({ parentTaskId: parent.id, reviewer: 'quality-agent' });

    const result = applyTaskReviewDecision({
      parentTaskId: parent.id,
      reviewer: 'quality-agent',
      reviewTaskId: 'review-quality',
      approved: false,
      decision: 'NEEDS_REVISION',
      summary: 'Quality review found blocking issues.',
      reason: 'Blocking review findings remain unresolved.',
    });

    assert.equal(result.blocked, true);
    assert.equal(getTask(parent.id)?.status, 'failed');

    const summary = getTaskReviewSummary(parent.id);
    assert.equal(summary.needsRevision, 1);
    assert.equal(summary.blockingReviewers[0], 'quality-agent');
  });
});
