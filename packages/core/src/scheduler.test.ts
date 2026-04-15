import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { loadProjectPolicy } = await import('./project-policy.js');
const { buildScheduledProjectRuns, getSchedulePeriodKey, isScheduledProjectRunDue } = await import('./scheduler.js');

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
});
