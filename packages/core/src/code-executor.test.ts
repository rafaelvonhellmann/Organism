import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCodeExecutor,
  shouldFallbackFromClaudeExecutor,
  shouldFallbackFromCodexExecutor,
} from './code-executor.js';

describe('code-executor', () => {
  it('prefers explicit executor selection when available', () => {
    const result = resolveCodeExecutor('codex', { claude: true, codex: true });
    assert.equal(result.selected, 'codex');
  });

  it('falls back to claude first in auto mode for backward compatibility', () => {
    const result = resolveCodeExecutor('auto', { claude: true, codex: true });
    assert.equal(result.selected, 'claude');
  });

  it('uses codex automatically when claude is unavailable', () => {
    const result = resolveCodeExecutor('auto', { claude: false, codex: true });
    assert.equal(result.selected, 'codex');
  });

  it('falls back from claude executor for credit exhaustion', () => {
    assert.equal(
      shouldFallbackFromClaudeExecutor(new Error('claude executor exited 1: Credit balance is too low')),
      true,
    );
  });

  it('falls back from codex executor for auth failures', () => {
    assert.equal(
      shouldFallbackFromCodexExecutor(new Error('codex executor exited 1: 401 unauthorized')),
      true,
    );
  });
});
