import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getV2DeployTargets, isActionBlocked, loadProjectPolicy, toV2ProjectName } from './project-policy.js';

describe('project-policy', () => {
  it('applies stabilization blocks for contact and purchases', () => {
    const policy = loadProjectPolicy('organism');
    assert.equal(policy.autonomyMode, 'stabilization');
    assert.equal(isActionBlocked(policy, 'contact'), true);
    assert.equal(isActionBlocked(policy, 'purchase'), true);
    assert.equal(isActionBlocked(policy, 'create_account'), true);
  });

  it('derives fork comparison targets for v2 deployments', () => {
    const policy = loadProjectPolicy('organism');
    const targets = getV2DeployTargets(policy);

    assert.ok(targets.length > 0);
    assert.ok(targets.every((target) => target.project.endsWith('-v2')));
    assert.ok(targets.every((target) => target.name.endsWith('-v2')));
    assert.equal(toV2ProjectName('organism-hq'), 'organism-hq-v2');
  });
});
