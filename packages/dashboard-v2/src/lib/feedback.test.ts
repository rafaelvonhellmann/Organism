/**
 * Tests for the external feedback persistence layer.
 *
 * Run with: npx tsx packages/dashboard-v2/src/lib/feedback.test.ts
 *
 * Uses a temporary in-memory Turso/libsql database to test:
 * 1. Feedback import
 * 2. Duplicate sync protection
 * 3. State transitions
 * 4. Conversion to action items
 */

import { strict as assert } from 'node:assert';
import { createClient, type Client } from '@libsql/client';

let passed = 0;
let failed = 0;
let client: Client;

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

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }

async function setupDb() {
  client = createClient({ url: ':memory:' });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS external_feedback (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'agentation',
      session_id TEXT,
      external_id TEXT NOT NULL,
      page_url TEXT,
      annotation_kind TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      severity TEXT,
      raw_payload TEXT,
      linked_task_id TEXT,
      linked_action_item_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_feedback_ext
    ON external_feedback(source, external_id)
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'todo',
      source_task_id TEXT,
      source_agent TEXT,
      due_date TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      rafael_notes TEXT
    )
  `);
}

// Direct DB helpers (mirror what queries.ts does, but using our test client)

async function importAnnotation(params: {
  source: string;
  sessionId: string | null;
  externalId: string;
  pageUrl: string | null;
  annotationKind: string | null;
  body: string;
  severity: string | null;
  rawPayload: unknown;
}): Promise<string | null> {
  const existing = await client.execute({
    sql: `SELECT id FROM external_feedback WHERE source = ? AND external_id = ?`,
    args: [params.source, params.externalId],
  });
  if (existing.rows.length > 0) return null;

  const id = crypto.randomUUID();
  const now = Date.now();

  await client.execute({
    sql: `INSERT INTO external_feedback
          (id, source, session_id, external_id, page_url, annotation_kind, body, status, severity, raw_payload, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    args: [
      id, params.source, params.sessionId ?? null, params.externalId,
      params.pageUrl ?? null, params.annotationKind ?? null, params.body,
      params.severity ?? null, params.rawPayload ? JSON.stringify(params.rawPayload) : null,
      now, now,
    ],
  });

  return id;
}

async function getStatus(id: string): Promise<string | null> {
  const r = await client.execute({ sql: `SELECT status FROM external_feedback WHERE id = ?`, args: [id] });
  return r.rows.length > 0 ? s(r.rows[0].status) : null;
}

async function updateStatus(id: string, newStatus: string): Promise<boolean> {
  const existing = await client.execute({ sql: `SELECT status FROM external_feedback WHERE id = ?`, args: [id] });
  if (existing.rows.length === 0) return false;

  const current = s(existing.rows[0].status);
  const validTransitions: Record<string, string[]> = {
    pending: ['acknowledged', 'dismissed'],
    acknowledged: ['resolved', 'dismissed', 'converted'],
    converted: ['resolved'],
  };

  if (!validTransitions[current]?.includes(newStatus)) return false;

  await client.execute({
    sql: `UPDATE external_feedback SET status = ?, updated_at = ? WHERE id = ?`,
    args: [newStatus, Date.now(), id],
  });
  return true;
}

async function convertToActionItem(feedbackId: string, projectId: string): Promise<string | null> {
  const fbResult = await client.execute({ sql: `SELECT * FROM external_feedback WHERE id = ?`, args: [feedbackId] });
  if (fbResult.rows.length === 0) return null;
  const fb = fbResult.rows[0];
  const fbStatus = s(fb.status);

  if (['converted', 'resolved', 'dismissed'].includes(fbStatus)) {
    return fb.linked_action_item_id ? s(fb.linked_action_item_id) : null;
  }

  const actionId = crypto.randomUUID();
  const now = Date.now();

  await client.batch([
    {
      sql: `INSERT INTO action_items (id, project_id, title, description, priority, status, source_agent, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'MEDIUM', 'todo', 'agentation', ?, ?)`,
      args: [actionId, projectId, `[Feedback] ${s(fb.body).slice(0, 80)}`, s(fb.body), now, now],
    },
    {
      sql: `UPDATE external_feedback SET status = 'converted', linked_action_item_id = ?, updated_at = ? WHERE id = ?`,
      args: [actionId, now, feedbackId],
    },
  ], 'write');

  return actionId;
}

async function run() {
  console.log('\n=== External Feedback Persistence Tests ===\n');

  await setupDb();

  // ── Import Tests ──────────────────────────────────────────────

  await test('import: creates feedback record', async () => {
    const id = await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-1',
      externalId: 'ann-001',
      pageUrl: 'http://localhost:3000/dashboard',
      annotationKind: 'bug',
      body: 'Button is misaligned on mobile',
      severity: 'medium',
      rawPayload: { selector: '.btn-submit', viewport: '375x812' },
    });

    assert.ok(id, 'Should return an id');
    const status = await getStatus(id!);
    assert.equal(status, 'pending');
  });

  await test('import: duplicate detection by source+externalId', async () => {
    const id = await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-1',
      externalId: 'ann-001', // same as above
      pageUrl: 'http://localhost:3000/dashboard',
      annotationKind: 'bug',
      body: 'Duplicate body',
      severity: 'medium',
      rawPayload: null,
    });

    assert.equal(id, null, 'Should return null for duplicates');
  });

  await test('import: different external_id is not a duplicate', async () => {
    const id = await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-1',
      externalId: 'ann-002',
      pageUrl: 'http://localhost:3000/settings',
      annotationKind: 'ux',
      body: 'Settings page too cluttered',
      severity: 'low',
      rawPayload: null,
    });

    assert.ok(id, 'Different external_id should succeed');
  });

  await test('import: different source with same external_id is not a duplicate', async () => {
    const id = await importAnnotation({
      source: 'manual',
      sessionId: null,
      externalId: 'ann-001', // same external_id, different source
      pageUrl: null,
      annotationKind: 'other',
      body: 'Manual annotation with same external_id',
      severity: null,
      rawPayload: null,
    });

    assert.ok(id, 'Different source should not be a duplicate');
  });

  // ── State Transition Tests ────────────────────────────────────

  let testId: string;

  await test('state: pending -> acknowledged', async () => {
    testId = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-2',
      externalId: 'state-test-1',
      pageUrl: null,
      annotationKind: 'bug',
      body: 'State test item',
      severity: 'high',
      rawPayload: null,
    }))!;

    const ok = await updateStatus(testId, 'acknowledged');
    assert.equal(ok, true);
    assert.equal(await getStatus(testId), 'acknowledged');
  });

  await test('state: acknowledged -> resolved', async () => {
    const ok = await updateStatus(testId, 'resolved');
    assert.equal(ok, true);
    assert.equal(await getStatus(testId), 'resolved');
  });

  await test('state: resolved -> acknowledged is INVALID', async () => {
    const ok = await updateStatus(testId, 'acknowledged');
    assert.equal(ok, false, 'Resolved should not transition back');
  });

  await test('state: pending -> resolved is INVALID', async () => {
    const id2 = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-2',
      externalId: 'state-test-2',
      pageUrl: null,
      annotationKind: 'ux',
      body: 'State test 2',
      severity: 'low',
      rawPayload: null,
    }))!;

    const ok = await updateStatus(id2, 'resolved');
    assert.equal(ok, false, 'Cannot jump from pending to resolved');
  });

  await test('state: pending -> dismissed', async () => {
    const id3 = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-2',
      externalId: 'state-test-3',
      pageUrl: null,
      annotationKind: 'other',
      body: 'Dismiss me',
      severity: 'info',
      rawPayload: null,
    }))!;

    const ok = await updateStatus(id3, 'dismissed');
    assert.equal(ok, true);
    assert.equal(await getStatus(id3), 'dismissed');
  });

  await test('state: acknowledged -> converted', async () => {
    const id4 = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-3',
      externalId: 'state-test-4',
      pageUrl: null,
      annotationKind: 'suggestion',
      body: 'Convert me to task',
      severity: 'medium',
      rawPayload: null,
    }))!;

    await updateStatus(id4, 'acknowledged');
    const ok = await updateStatus(id4, 'converted');
    assert.equal(ok, true);
    assert.equal(await getStatus(id4), 'converted');
  });

  await test('state: converted -> resolved', async () => {
    // Re-use the last one that became 'converted'
    const id4Result = await client.execute({
      sql: `SELECT id FROM external_feedback WHERE external_id = 'state-test-4' AND source = 'agentation'`,
      args: [],
    });
    const id4 = s(id4Result.rows[0].id);

    const ok = await updateStatus(id4, 'resolved');
    assert.equal(ok, true);
    assert.equal(await getStatus(id4), 'resolved');
  });

  // ── Conversion Tests ──────────────────────────────────────────

  await test('convert: creates action item and links back', async () => {
    const fbId = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-4',
      externalId: 'convert-test-1',
      pageUrl: 'http://localhost:3000/tasks',
      annotationKind: 'bug',
      body: 'Task list does not refresh after creation',
      severity: 'high',
      rawPayload: { detail: 'manual refresh needed' },
    }))!;

    // Must acknowledge first
    await updateStatus(fbId, 'acknowledged');

    const actionId = await convertToActionItem(fbId, 'organism');
    assert.ok(actionId, 'Should return action item id');

    // Check feedback is now converted
    assert.equal(await getStatus(fbId), 'converted');

    // Check action item exists
    const aiResult = await client.execute({
      sql: `SELECT * FROM action_items WHERE id = ?`,
      args: [actionId!],
    });
    assert.equal(aiResult.rows.length, 1);
    assert.equal(s(aiResult.rows[0].source_agent), 'agentation');
    assert.equal(s(aiResult.rows[0].project_id), 'organism');
  });

  await test('convert: rejected for already-resolved feedback', async () => {
    const fbId = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-4',
      externalId: 'convert-test-2',
      pageUrl: null,
      annotationKind: 'ux',
      body: 'Already resolved thing',
      severity: 'low',
      rawPayload: null,
    }))!;

    await updateStatus(fbId, 'acknowledged');
    await updateStatus(fbId, 'resolved');

    const actionId = await convertToActionItem(fbId, 'organism');
    assert.equal(actionId, null, 'Should not convert resolved feedback');
  });

  await test('convert: rejected for dismissed feedback', async () => {
    const fbId = (await importAnnotation({
      source: 'agentation',
      sessionId: 'sess-4',
      externalId: 'convert-test-3',
      pageUrl: null,
      annotationKind: 'other',
      body: 'Dismissed thing',
      severity: 'info',
      rawPayload: null,
    }))!;

    await updateStatus(fbId, 'dismissed');

    const actionId = await convertToActionItem(fbId, 'organism');
    assert.equal(actionId, null, 'Should not convert dismissed feedback');
  });

  // ── Summary ───────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
