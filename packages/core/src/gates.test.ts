import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { createGate, getGate, resolveG4Gate } = await import('./gates.js');
const { awaitReviewTask, createTask, getDb, getTask } = await import('./task-queue.js');

function resetGateState() {
  getDb().exec(`
    DELETE FROM gates;
    DELETE FROM tasks;
  `);
}

function createAwaitingReviewTask(description: string) {
  const task = createTask({
    agent: 'engineering',
    lane: 'HIGH',
    description,
    input: { test: description },
    projectId: 'organism',
  });
  awaitReviewTask(task.id, { summary: description }, 100, 0.01);
  return task;
}

describe('G4 gate resolution', () => {
  beforeEach(() => {
    resetGateState();
  });

  it('approves a pending G4 gate and completes the awaiting_review parent task', () => {
    const task = createAwaitingReviewTask('approve G4 task');
    const gate = createGate(task.id, 'G4');

    const resolved = resolveG4Gate(gate.id, 'approved', 'Looks safe');

    assert.equal(resolved.id, gate.id);
    assert.equal(resolved.gate, 'G4');
    assert.equal(resolved.decision, 'approved');
    assert.equal(resolved.decidedBy, 'rafael');
    assert.equal(resolved.reason, 'Looks safe');
    assert.equal(getTask(task.id)?.status, 'completed');
  });

  it('rejects a pending G4 gate and fails the awaiting_review parent task', () => {
    const task = createAwaitingReviewTask('reject G4 task');
    const gate = createGate(task.id, 'G4');

    const resolved = resolveG4Gate(gate.id, 'rejected', 'Needs changes');

    assert.equal(resolved.decision, 'rejected');
    const updatedTask = getTask(task.id);
    assert.equal(updatedTask?.status, 'failed');
    assert.equal(updatedTask?.error, 'Needs changes');
  });

  it('throws clear gate-block wording for a missing gate', () => {
    assert.throws(
      () => resolveG4Gate('missing-gate', 'approved'),
      /GATE_BLOCKED|Gate missing-gate does not exist/,
    );
  });

  it('throws when asked to resolve a non-G4 gate', () => {
    const task = createAwaitingReviewTask('non-G4 task');
    const gate = createGate(task.id, 'G1');

    assert.throws(
      () => resolveG4Gate(gate.id, 'approved'),
      /GATE_BLOCKED|not G4/,
    );
    assert.equal(getGate(gate.id)?.decision, 'pending');
    assert.equal(getTask(task.id)?.status, 'awaiting_review');
  });

  it('returns an already-resolved gate for same-decision idempotency without changing task status again', () => {
    const task = createAwaitingReviewTask('idempotent G4 task');
    const gate = createGate(task.id, 'G4');
    const firstResolution = resolveG4Gate(gate.id, 'approved', 'Approved once');

    getDb().prepare("UPDATE tasks SET status = 'awaiting_review' WHERE id = ?").run(task.id);

    const secondResolution = resolveG4Gate(gate.id, 'approved', 'Ignored second reason');

    assert.deepEqual(secondResolution, firstResolution);
    assert.equal(getTask(task.id)?.status, 'awaiting_review');
    assert.equal(getGate(gate.id)?.reason, 'Approved once');
  });

  it('throws on a conflicting second decision and does not flip the gate or task', () => {
    const task = createAwaitingReviewTask('conflicting G4 task');
    const gate = createGate(task.id, 'G4');
    resolveG4Gate(gate.id, 'approved', 'Approved once');

    getDb().prepare("UPDATE tasks SET status = 'awaiting_review' WHERE id = ?").run(task.id);

    assert.throws(
      () => resolveG4Gate(gate.id, 'rejected', 'Trying to flip'),
      /GATE_BLOCKED|already approved/,
    );
    assert.equal(getGate(gate.id)?.decision, 'approved');
    assert.equal(getGate(gate.id)?.reason, 'Approved once');
    assert.equal(getTask(task.id)?.status, 'awaiting_review');
  });
});
