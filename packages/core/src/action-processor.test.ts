import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { claimDashboardAction, processDashboardActions, reconcileDashboardActionStates } = await import('./action-processor.js');
const { getDb } = await import('./task-queue.js');

function resetDashboardActions() {
  getDb().exec(`DELETE FROM dashboard_actions;`);
}

describe('action-processor', () => {
  beforeEach(() => {
    resetDashboardActions();
  });

  it('claims each dashboard action only once before processing', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO dashboard_actions (action, payload, status, created_at)
      VALUES ('status', NULL, 'pending', ?)
    `).run(Date.now());

    const actionId = Number(db.prepare(`
      SELECT id FROM dashboard_actions ORDER BY id DESC LIMIT 1
    `).get()?.id);

    assert.equal(claimDashboardAction(actionId), true);
    assert.equal(claimDashboardAction(actionId), false);

    const claimed = db.prepare(`
      SELECT status FROM dashboard_actions WHERE id = ?
    `).get(actionId) as { status: string } | undefined;

    assert.equal(claimed?.status, 'in_progress');
  });

  it('completes a claimed status action without leaving it pending', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO dashboard_actions (action, payload, status, created_at)
      VALUES ('status', NULL, 'pending', ?)
    `).run(Date.now());

    await processDashboardActions();

    const action = db.prepare(`
      SELECT status, result, completed_at FROM dashboard_actions ORDER BY id DESC LIMIT 1
    `).get() as { status: string; result: string | null; completed_at: number | null } | undefined;

    assert.equal(action?.status, 'completed');
    assert.match(action?.result ?? '', /Status check completed/);
    assert.ok((action?.completed_at ?? 0) > 0);
  });

  it('auto-completes stale in-progress launches once a newer launch has already finished', () => {
    const db = getDb();
    const now = Date.now();

    db.prepare(`
      INSERT INTO dashboard_actions (action, payload, status, created_at)
      VALUES ('start', ?, 'in_progress', ?)
    `).run(JSON.stringify({ project: 'synapse' }), now - 10 * 60 * 1000);

    db.prepare(`
      INSERT INTO dashboard_actions (action, payload, status, result, created_at, completed_at)
      VALUES ('start', ?, 'completed', 'Command submitted: implement the next bounded ci task for synapse', ?, ?)
    `).run(JSON.stringify({ project: 'synapse' }), now - 60 * 1000, now - 30 * 1000);

    const reconciled = reconcileDashboardActionStates(now);
    assert.equal(reconciled, 1);

    const stale = db.prepare(`
      SELECT status, result, completed_at
      FROM dashboard_actions
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as { status: string; result: string | null; completed_at: number | null } | undefined;

    assert.equal(stale?.status, 'completed');
    assert.match(stale?.result ?? '', /Superseded by later start for synapse/);
    assert.ok((stale?.completed_at ?? 0) > 0);
  });
});
