/**
 * Tests for the Agentation integration module.
 *
 * Run with: npx tsx --experimental-sqlite packages/core/src/integrations/agentation.test.ts
 *
 * These tests verify:
 * 1. Config detection / graceful disabled behavior
 * 2. Graceful handling when server is unreachable
 * 3. API method signatures and error shapes
 */

import { strict as assert } from 'node:assert';
import {
  getConfig,
  resetConfig,
  isAvailable,
  listSessions,
  fetchPendingAnnotations,
  acknowledgeAnnotation,
  resolveAnnotation,
  dismissAnnotation,
  replyToAnnotation,
  type AgentationConfig,
} from './agentation.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err: unknown) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL  ${name}: ${msg}`);
    }
  })();
}

async function run() {
  console.log('\n=== Agentation Integration Tests ===\n');

  // ── Config Tests ──────────────────────────────────────────────

  await test('config: disabled by default', () => {
    // Clear env
    delete process.env.AGENTATION_ENABLED;
    delete process.env.AGENTATION_SERVER_URL;
    delete process.env.AGENTATION_AUTH_TOKEN;
    delete process.env.AGENTATION_TIMEOUT_MS;
    resetConfig();

    const cfg = getConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.serverUrl, 'http://localhost:4100');
    assert.equal(cfg.authToken, undefined);
    assert.equal(cfg.timeoutMs, 5000);
  });

  await test('config: enabled with custom URL', () => {
    process.env.AGENTATION_ENABLED = 'true';
    process.env.AGENTATION_SERVER_URL = 'http://myhost:9999/';
    process.env.AGENTATION_AUTH_TOKEN = 'secret123';
    process.env.AGENTATION_TIMEOUT_MS = '3000';
    resetConfig();

    const cfg = getConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.serverUrl, 'http://myhost:9999'); // trailing slash stripped
    assert.equal(cfg.authToken, 'secret123');
    assert.equal(cfg.timeoutMs, 3000);
  });

  await test('config: enabled with "1"', () => {
    process.env.AGENTATION_ENABLED = '1';
    resetConfig();

    const cfg = getConfig();
    assert.equal(cfg.enabled, true);
  });

  await test('config: disabled with "false"', () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const cfg = getConfig();
    assert.equal(cfg.enabled, false);
  });

  // ── Graceful Disabled Behavior ────────────────────────────────

  await test('isAvailable: returns false when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const available = await isAvailable();
    assert.equal(available, false);
  });

  await test('listSessions: returns empty array when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const sessions = await listSessions();
    assert.deepEqual(sessions, []);
  });

  await test('fetchPendingAnnotations: returns empty array when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const annotations = await fetchPendingAnnotations();
    assert.deepEqual(annotations, []);
  });

  await test('acknowledgeAnnotation: returns false when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const result = await acknowledgeAnnotation('test-id');
    assert.equal(result, false);
  });

  await test('resolveAnnotation: returns false when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const result = await resolveAnnotation('test-id', 'fixed');
    assert.equal(result, false);
  });

  await test('dismissAnnotation: returns false when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const result = await dismissAnnotation('test-id', 'not reproducible');
    assert.equal(result, false);
  });

  await test('replyToAnnotation: returns false when disabled', async () => {
    process.env.AGENTATION_ENABLED = 'false';
    resetConfig();

    const result = await replyToAnnotation('test-id', 'thanks', 'organism');
    assert.equal(result, false);
  });

  // ── Graceful Unreachable Behavior ─────────────────────────────

  await test('isAvailable: returns false when server unreachable', async () => {
    process.env.AGENTATION_ENABLED = 'true';
    process.env.AGENTATION_SERVER_URL = 'http://localhost:19999'; // nothing listening
    process.env.AGENTATION_TIMEOUT_MS = '1000';
    resetConfig();

    const available = await isAvailable();
    assert.equal(available, false);
  });

  await test('listSessions: returns empty when server unreachable', async () => {
    process.env.AGENTATION_ENABLED = 'true';
    process.env.AGENTATION_SERVER_URL = 'http://localhost:19999';
    process.env.AGENTATION_TIMEOUT_MS = '1000';
    resetConfig();

    const sessions = await listSessions();
    assert.deepEqual(sessions, []);
  });

  await test('fetchPendingAnnotations: returns empty when server unreachable', async () => {
    process.env.AGENTATION_ENABLED = 'true';
    process.env.AGENTATION_SERVER_URL = 'http://localhost:19999';
    process.env.AGENTATION_TIMEOUT_MS = '1000';
    resetConfig();

    const annotations = await fetchPendingAnnotations();
    assert.deepEqual(annotations, []);
  });

  await test('acknowledgeAnnotation: returns false when server unreachable', async () => {
    process.env.AGENTATION_ENABLED = 'true';
    process.env.AGENTATION_SERVER_URL = 'http://localhost:19999';
    process.env.AGENTATION_TIMEOUT_MS = '1000';
    resetConfig();

    const result = await acknowledgeAnnotation('test-id');
    assert.equal(result, false);
  });

  // ── Summary ───────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  // Clean up env
  delete process.env.AGENTATION_ENABLED;
  delete process.env.AGENTATION_SERVER_URL;
  delete process.env.AGENTATION_AUTH_TOKEN;
  delete process.env.AGENTATION_TIMEOUT_MS;

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
