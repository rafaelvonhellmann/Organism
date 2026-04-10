import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelBackend } from '../../../agents/_base/mcp-client.js';

const ORIGINAL_MODEL_BACKEND = process.env.ORGANISM_MODEL_BACKEND;
const ORIGINAL_USE_API_DIRECT = process.env.USE_API_DIRECT;

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
});

describe('model backend resolution', () => {
  it('prefers explicit backend selection when available', () => {
    const result = resolveModelBackend('anthropic-api', { claudeCli: true, anthropicApi: true });
    assert.equal(result.selected, 'anthropic-api');
  });

  it('falls back to claude-cli first in auto mode for backward compatibility', () => {
    const result = resolveModelBackend('auto', { claudeCli: true, anthropicApi: true });
    assert.equal(result.selected, 'claude-cli');
    assert.equal(result.capabilities.webSearch, true);
  });

  it('uses anthropic-api automatically when claude cli is unavailable', () => {
    const result = resolveModelBackend('auto', { claudeCli: false, anthropicApi: true });
    assert.equal(result.selected, 'anthropic-api');
    assert.equal(result.capabilities.webSearch, false);
  });

  it('honors ORGANISM_MODEL_BACKEND from the environment', () => {
    process.env.ORGANISM_MODEL_BACKEND = 'anthropic-api';
    const result = resolveModelBackend(undefined, { claudeCli: true, anthropicApi: true });
    assert.equal(result.selected, 'anthropic-api');
  });

  it('maps legacy USE_API_DIRECT to anthropic-api', () => {
    delete process.env.ORGANISM_MODEL_BACKEND;
    process.env.USE_API_DIRECT = 'true';
    const result = resolveModelBackend(undefined, { claudeCli: true, anthropicApi: true });
    assert.equal(result.selected, 'anthropic-api');
  });
});
