import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { writeAudit, readRecentForAgent, readRecentForTask } = await import('./audit.js');
const { getDb } = await import('./task-queue.js');
const { AUDIT_LOG_PATH } = await import('../../shared/src/audit-log.js');

describe('audit ledger', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM audit_log');
    if (fs.existsSync(AUDIT_LOG_PATH)) {
      fs.unlinkSync(AUDIT_LOG_PATH);
    }
  });

  it('writes both sqlite and JSONL records into the canonical state root', () => {
    writeAudit({
      agent: 'engineering',
      taskId: 'task-audit-1',
      action: 'task_completed',
      payload: { summary: 'completed' },
      outcome: 'success',
    });

    const dbRow = getDb().prepare(`
      SELECT agent, task_id, action, outcome
      FROM audit_log
      WHERE task_id = ?
    `).get('task-audit-1') as {
      agent: string;
      task_id: string;
      action: string;
      outcome: string;
    };

    assert.equal(dbRow.agent, 'engineering');
    assert.equal(dbRow.task_id, 'task-audit-1');
    assert.equal(dbRow.action, 'task_completed');
    assert.equal(dbRow.outcome, 'success');

    assert.equal(fs.existsSync(AUDIT_LOG_PATH), true);
    const entries = fs.readFileSync(AUDIT_LOG_PATH, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        agent: string;
        taskId: string;
        action: string;
        outcome: string;
      });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.agent, 'engineering');
    assert.equal(entries[0]?.taskId, 'task-audit-1');
  });

  it('reads recent audit breadcrumbs through the unified writer', () => {
    writeAudit({
      agent: 'engineering',
      taskId: 'task-audit-2',
      action: 'task_checkout',
      payload: { step: 1 },
      outcome: 'success',
    });
    writeAudit({
      agent: 'engineering',
      taskId: 'task-audit-2',
      action: 'task_completed',
      payload: { step: 2 },
      outcome: 'success',
    });

    const byAgent = readRecentForAgent('engineering', 2);
    const byTask = readRecentForTask('task-audit-2');

    assert.equal(byAgent.length, 2);
    assert.equal(byAgent[0]?.action, 'task_checkout');
    assert.equal(byAgent[1]?.action, 'task_completed');
    assert.equal(byTask.length, 2);
  });
});
