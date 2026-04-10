import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canAgentExecute, getAgentsForProject, resolveOwner } from './registry.js';

describe('registry project governance', () => {
  it('keeps Organism scoped to its declared core roster', () => {
    const organismAgents = getAgentsForProject('organism').map((capability) => capability.owner);

    assert.ok(organismAgents.includes('engineering'));
    assert.ok(!organismAgents.includes('design'));
    assert.ok(!organismAgents.includes('marketing-executor'));
  });

  it('does not route Organism work to non-roster specialists', () => {
    const resolved = resolveOwner('Create UI/UX wireframes and component specifications for the runtime console', 'organism');

    assert.equal(resolved, null);
    assert.equal(canAgentExecute('design', 'organism'), false);
    assert.equal(canAgentExecute('engineering', 'organism'), true);
  });
});
