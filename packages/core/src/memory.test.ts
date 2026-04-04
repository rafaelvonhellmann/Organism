import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStixDBAvailable,
  storeMemory,
  askMemory,
  retrieveMemories,
  getWorkingMemory,
  searchAcrossAgents,
  storeTaskMemory,
} from './memory.js';

describe('memory client (no server)', () => {
  it('isStixDBAvailable returns false when server is down', async () => {
    const available = await isStixDBAvailable();
    assert.equal(available, false);
  });

  it('storeMemory returns empty string when server is down', async () => {
    const id = await storeMemory('test-agent', 'hello world');
    assert.equal(id, '');
  });

  it('askMemory returns empty result when server is down', async () => {
    const result = await askMemory('test-agent', 'What happened?');
    assert.equal(result.answer, '');
    assert.equal(result.confidence, 0);
    assert.equal(result.isConfident, false);
    assert.deepEqual(result.sources, []);
  });

  it('retrieveMemories returns empty array when server is down', async () => {
    const results = await retrieveMemories('test-agent', 'query');
    assert.deepEqual(results, []);
  });

  it('getWorkingMemory returns empty array when server is down', async () => {
    const results = await getWorkingMemory('test-agent');
    assert.deepEqual(results, []);
  });

  it('searchAcrossAgents returns empty array when server is down', async () => {
    const results = await searchAcrossAgents('query', ['a', 'b']);
    assert.deepEqual(results, []);
  });

  it('storeTaskMemory does not throw when server is down', async () => {
    await storeTaskMemory('test-agent', {
      id: 'task-1',
      description: 'test task',
      output: 'done',
      costUsd: 0.01,
    });
    // No throw = pass
  });
});
