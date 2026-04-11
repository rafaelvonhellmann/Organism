import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimDashboardAction, processDashboardActions } from './action-processor.js';
import { getDb } from './task-queue.js';

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
});
