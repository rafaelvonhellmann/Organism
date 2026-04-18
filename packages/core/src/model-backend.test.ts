import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveModelBackend,
  resolveAdaptiveModelTimeout,
  shouldFallbackFromAnthropicToOpenAi,
  shouldFallbackFromClaudeCliToApi,
  shouldFallbackFromCodexCli,
} from '../../../agents/_base/mcp-client.js';

const ORIGINAL_MODEL_BACKEND = process.env.ORGANISM_MODEL_BACKEND;
const ORIGINAL_USE_API_DIRECT = process.env.USE_API_DIRECT;
const BACKEND_HEALTH_PATH = join(homedir(), '.organism', 'state', 'model-backend-health.json');

afterEach(() => {
  if (ORIGINAL_MODEL_BACKEND === undefined) {
    delete process.env.ORGANISM_MODEL_BACKEND;
  } else {
    process.env.ORGANISM_MODEL_BACKEND = ORIGINAL_MODEL_BACKEND;
  }

  if (ORIGINAL_USE_API_DIRECT === undefined) {
    delete process.env.USE_API_DIRECT;
  } else {
    process.env.USE_API_DIRECT = ORIGINAL_USE_API_DIRECT;
  }

  if (existsSync(BACKEND_HEALTH_PATH)) {
    rmSync(BACKEND_HEALTH_PATH, { force: true });
  }
});

describe('model backend resolution', () => {
  it('prefers explicit backend selection when available', () => {
    const result = resolveModelBackend('anthropic-api', {
      claudeCli: true,
      anthropicApi: true,
      codexCli: true,
      openaiApi: true,
    });
    assert.equal(result.selected, 'anthropic-api');
  });

  it('prefers codex-cli first in auto mode when all backends are available', () => {
    const result = resolveModelBackend('auto', {
      claudeCli: true,
      anthropicApi: true,
      codexCli: true,
      openaiApi: true,
    });
    assert.equal(result.selected, 'codex-cli');
    assert.equal(result.capabilities.webSearch, false);
  });

  it('uses claude-cli automatically when codex cli is unavailable', () => {
    const result = resolveModelBackend('auto', {
      claudeCli: true,
      anthropicApi: true,
      codexCli: false,
      openaiApi: true,
    });
    assert.equal(result.selected, 'claude-cli');
    assert.equal(result.capabilities.webSearch, true);
  });

  it('uses openai-api automatically when both CLIs are unavailable', () => {
    const result = resolveModelBackend('auto', {
      claudeCli: false,
      anthropicApi: true,
      codexCli: false,
      openaiApi: true,
    });
    assert.equal(result.selected, 'openai-api');
  });

  it('uses anthropic-api automatically when OpenAI backends are unavailable', () => {
    const result = resolveModelBackend('auto', {
      claudeCli: false,
      anthropicApi: true,
      codexCli: false,
      openaiApi: false,
    });
    assert.equal(result.selected, 'anthropic-api');
  });

  it('honors ORGANISM_MODEL_BACKEND from the environment', () => {
    process.env.ORGANISM_MODEL_BACKEND = 'anthropic-api';
    const result = resolveModelBackend(undefined, {
      claudeCli: true,
      anthropicApi: true,
      codexCli: true,
      openaiApi: true,
    });
    assert.equal(result.selected, 'anthropic-api');
  });

  it('supports codex-first as an explicit environment preference', () => {
    process.env.ORGANISM_MODEL_BACKEND = 'codex-first';
    const result = resolveModelBackend(undefined, {
      claudeCli: true,
      anthropicApi: true,
      codexCli: true,
      openaiApi: true,
    });
    assert.equal(result.preferred, 'codex-first');
    assert.equal(result.selected, 'codex-cli');
  });

  it('maps legacy USE_API_DIRECT to anthropic-api', () => {
    delete process.env.ORGANISM_MODEL_BACKEND;
    process.env.USE_API_DIRECT = 'true';
    const result = resolveModelBackend(undefined, {
      claudeCli: true,
      anthropicApi: true,
      codexCli: true,
      openaiApi: true,
    });
    assert.equal(result.selected, 'anthropic-api');
  });

  it('auto-falls back to the Anthropic API for exhausted claude-cli credit', () => {
    assert.equal(
      shouldFallbackFromClaudeCliToApi(new Error('claude CLI returned error: Credit balance is too low')),
      true,
    );
  });

  it('does not treat unrelated claude-cli errors as automatic API fallback triggers', () => {
    assert.equal(
      shouldFallbackFromClaudeCliToApi(new Error('claude CLI returned malformed JSON response')),
      false,
    );
  });

  it('falls back from anthropic to openai for exhausted credits', () => {
    assert.equal(
      shouldFallbackFromAnthropicToOpenAi(new Error('Your credit balance is too low to access the Anthropic API')),
      true,
    );
  });

  it('falls back from anthropic to the next backend for transport failures', () => {
    assert.equal(
      shouldFallbackFromAnthropicToOpenAi(new Error('Connection error while reaching Anthropic API')),
      true,
    );
  });

  it('falls back from codex cli for auth and quota failures', () => {
    assert.equal(
      shouldFallbackFromCodexCli(new Error('codex CLI exited 1: 401 unauthorized')),
      true,
    );
  });

  it('falls back from codex cli for transport failures', () => {
    assert.equal(
      shouldFallbackFromCodexCli(new Error('codex CLI exited 1: fetch failed')),
      true,
    );
  });

  it('extends adaptive model timeout for large autonomy-cycle prompts', () => {
    const timeoutMs = resolveAdaptiveModelTimeout(
      'Autonomy cycle review for tokens-for-good.\n'.repeat(800),
      'System prompt for project review',
      8192,
    );

    assert.equal(timeoutMs, 35 * 60 * 1000);
  });
});
