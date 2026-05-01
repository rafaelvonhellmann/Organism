import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { checkRegistryCoherence } = await import('./registry.js');
const { getRegisteredAgentNames } = await import('./agent-runner.js');

describe('registry coherence', () => {
  it('has no active or shadow drift against AGENT_MAP', () => {
    const report = checkRegistryCoherence(getRegisteredAgentNames());

    assert.deepEqual(report.missingImplementations, []);
    assert.deepEqual(report.orphanedImplementations, []);
  });
});
