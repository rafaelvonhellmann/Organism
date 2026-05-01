import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const {
  SIDECAR_TOOL_NAMES,
  checkPolicyViaSidecar,
  detectDoomLoopViaSidecar,
  persistMemoryViaSidecar,
  probeSidecarStatus,
  ragRetrieveViaSidecar,
} = await import('../../../agents/_base/mcp-client.js');

describe('sidecar boundary', () => {
  it('exposes exactly the 5 sanctioned PraisonAI tools', () => {
    assert.deepEqual(SIDECAR_TOOL_NAMES, [
      'route_model',
      'rag_retrieve',
      'check_policy',
      'detect_doom_loop',
      'persist_memory',
    ]);
  });

  it('defaults to a healthy embedded sidecar boundary', async () => {
    const status = await probeSidecarStatus('embedded');
    assert.equal(status.selected, 'embedded');
    assert.equal(status.tools.length, 5);
    assert.equal(status.fallbackReason, null);
  });

  it('blocks prohibited actions through sidecar policy checks', async () => {
    const result = await checkPolicyViaSidecar('git reset --hard', { agent: 'engineering' });
    assert.equal(result.result, 'FAIL');
    assert.match(result.reason, /hard reset/i);
  });

  it('detects simple doom loops through the sidecar contract', async () => {
    const result = await detectDoomLoopViaSidecar(['retry', 'retry', 'retry'], 'engineering');
    assert.equal(result.signal, true);
    assert.match(result.evidence, /repeated 3 times/i);
  });

  it('persists and retrieves sidecar memory through the same boundary', async () => {
    const persisted = await persistMemoryViaSidecar('G4 is the final board gate.', { projectId: 'organism' });
    const retrieved = await ragRetrieveViaSidecar('board gate', 5);

    assert.equal(persisted.status, 'persisted');
    assert.ok(retrieved.total_in_store >= 1);
    assert.ok(retrieved.results.some((entry) => entry.id === persisted.id));
  });
});
