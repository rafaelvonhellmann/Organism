import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { canCreatePolicyFollowup, parseFollowupPolicy } = await import('./followup-policy.js');

describe('followup-policy', () => {
  it('parses bounded self-audit followup rules', () => {
    const policy = parseFollowupPolicy({
      followupPolicy: {
        boundedLane: 'self_audit',
        allowedWorkflows: ['review', 'validate', 'recover', 'implement'],
        maxFollowups: 4,
        recursionDisabled: true,
      },
    });

    assert.ok(policy);
    assert.equal(policy?.boundedLane, 'self_audit');
    assert.deepEqual(policy?.allowedWorkflows, ['review', 'validate', 'recover', 'implement']);
    assert.equal(policy?.maxFollowups, 4);
    assert.equal(policy?.recursionDisabled, true);
  });

  it('caps root self-audit followups and blocks recursive descendants', () => {
    const policy = parseFollowupPolicy({
      followupPolicy: {
        boundedLane: 'self_audit',
        allowedWorkflows: ['implement', 'validate'],
        maxFollowups: 2,
        recursionDisabled: true,
      },
    });

    assert.equal(canCreatePolicyFollowup(policy, 'implement', 0, false), true);
    assert.equal(canCreatePolicyFollowup(policy, 'validate', 1, false), true);
    assert.equal(canCreatePolicyFollowup(policy, 'implement', 2, false), false);
    assert.equal(canCreatePolicyFollowup(policy, 'recover', 0, false), false);
    assert.equal(canCreatePolicyFollowup(policy, 'implement', 0, true), false);
  });

  it('parses a medical read-only followup lane and blocks implementation descendants', () => {
    const policy = parseFollowupPolicy({
      followupPolicy: {
        boundedLane: 'medical_read_only',
        allowedWorkflows: ['review', 'plan', 'validate'],
        maxFollowups: 2,
        recursionDisabled: true,
      },
    });

    assert.equal(policy?.boundedLane, 'medical_read_only');
    assert.equal(canCreatePolicyFollowup(policy, 'review', 0, false), true);
    assert.equal(canCreatePolicyFollowup(policy, 'validate', 1, false), true);
    assert.equal(canCreatePolicyFollowup(policy, 'implement', 0, false), false);
  });
});
