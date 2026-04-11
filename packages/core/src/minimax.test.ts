import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectPolicy } from './project-policy.js';
import { getMiniMaxStatus } from './minimax.js';

describe('minimax', () => {
  it('reports disabled state for projects without minimax enabled', () => {
    const policy = loadProjectPolicy('tokens-for-good');
    const status = getMiniMaxStatus(policy);
    assert.equal(status.enabled, false);
    assert.equal(status.ready, false);
  });

  it('keeps Organism minimax scope bounded to search', () => {
    const policy = loadProjectPolicy('organism');
    const status = getMiniMaxStatus(policy);
    assert.equal(status.enabled, true);
    assert.deepEqual(status.allowedCommands, ['search']);
  });
});
