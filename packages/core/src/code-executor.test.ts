import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodeExecutor } from './code-executor.js';

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
});
