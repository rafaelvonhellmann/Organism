import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCodeExecutor,
  resolveAdaptiveExecutorTimeout,
  shouldFallbackFromClaudeExecutor,
  shouldFallbackFromCodexExecutor,
} from './code-executor.js';

const EXECUTOR_HEALTH_PATH = join(homedir(), '.organism', 'state', 'code-executor-health.json');
const ORIGINAL_MODEL_BACKEND = process.env.ORGANISM_MODEL_BACKEND;
const ORIGINAL_LEGACY_FALLBACK = process.env.ORGANISM_ALLOW_LEGACY_ANTHROPIC_FALLBACK;

afterEach(() => {
  if (ORIGINAL_MODEL_BACKEND === undefined) {
    delete process.env.ORGANISM_MODEL_BACKEND;
  } else {
    process.env.ORGANISM_MODEL_BACKEND = ORIGINAL_MODEL_BACKEND;
  }

  if (ORIGINAL_LEGACY_FALLBACK === undefined) {
    delete process.env.ORGANISM_ALLOW_LEGACY_ANTHROPIC_FALLBACK;
  } else {
    process.env.ORGANISM_ALLOW_LEGACY_ANTHROPIC_FALLBACK = ORIGINAL_LEGACY_FALLBACK;
  }

  if (existsSync(EXECUTOR_HEALTH_PATH)) {
    rmSync(EXECUTOR_HEALTH_PATH, { force: true });
  }
});

describe('code-executor', () => {
  it('prefers explicit executor selection when available', () => {
    const result = resolveCodeExecutor('codex', { claude: true, codex: true });
    assert.equal(result.selected, 'codex');
  });

  it('prefers codex as the auto executor by default', () => {
    const result = resolveCodeExecutor('auto', { claude: true, codex: true });
    assert.equal(result.selected, 'codex');
  });

  it('uses codex automatically when claude is unavailable', () => {
    const result = resolveCodeExecutor('auto', { claude: false, codex: true });
    assert.equal(result.selected, 'codex');
  });

  it('uses the legacy Claude executor in auto mode only when explicitly enabled', () => {
    process.env.ORGANISM_ALLOW_LEGACY_ANTHROPIC_FALLBACK = 'true';
    const result = resolveCodeExecutor('auto', { claude: true, codex: false });
    assert.equal(result.selected, 'claude');
  });

  it('still prefers codex even if a legacy Claude executor is available', () => {
    process.env.ORGANISM_ALLOW_LEGACY_ANTHROPIC_FALLBACK = 'true';
    const result = resolveCodeExecutor('auto', { claude: true, codex: true });
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

  it('falls back from claude executor for timeout-style failures', () => {
    assert.equal(
      shouldFallbackFromClaudeExecutor(new Error('claude code executor timed out after 25 minutes')),
      true,
    );
  });

  it('falls back from codex executor for transport-style failures', () => {
    assert.equal(
      shouldFallbackFromCodexExecutor(new Error('codex executor exited 1: fetch failed')),
      true,
    );
  });

  it('uses a longer adaptive timeout for recover-style engineering work', () => {
    const timeoutMs = resolveAdaptiveExecutorTimeout({
      workflowKind: 'recover',
      description: 'Inspect the workspace and rerun the implementation after a timeout',
      prompt: 'Resume from the preserved worktree and finish the implementation.',
      maxTurns: 15,
    });

    assert.equal(timeoutMs, 45 * 60 * 1000);
  });

  it('keeps review work on a shorter adaptive timeout budget', () => {
    const timeoutMs = resolveAdaptiveExecutorTimeout({
      workflowKind: 'validate',
      description: 'Validate the existing implementation',
      prompt: 'Review the code and report issues.',
      maxTurns: 8,
    });

    assert.equal(timeoutMs, 15 * 60 * 1000);
  });
});
