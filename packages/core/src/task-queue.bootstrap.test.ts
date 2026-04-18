import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { getDb, resetDbForTests } = await import('./task-queue.js');

const originalExec = DatabaseSync.prototype.exec;

describe('task-queue bootstrap', () => {
  beforeEach(() => {
    resetDbForTests();
    getDb();
    resetDbForTests();
  });

  afterEach(() => {
    DatabaseSync.prototype.exec = originalExec;
    resetDbForTests();
  });

  it('reuses an already-migrated schema when bootstrap sees a hot database lock', () => {
    let injectedLock = false;

    DatabaseSync.prototype.exec = function patchedExec(sql: string) {
      if (!injectedLock && sql.includes('CREATE TABLE IF NOT EXISTS tasks')) {
        injectedLock = true;
        throw new Error('database is locked');
      }

      return originalExec.call(this, sql);
    };

    const db = getDb();
    const tasksTable = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'tasks'
    `).get() as { name?: string } | undefined;
    const dashboardActionsTable = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'dashboard_actions'
    `).get() as { name?: string } | undefined;

    assert.equal(injectedLock, true);
    assert.equal(tasksTable?.name, 'tasks');
    assert.equal(dashboardActionsTable?.name, 'dashboard_actions');
  });
});
