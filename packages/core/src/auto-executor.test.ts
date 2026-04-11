import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';

configureTestState(import.meta.url);

const { processApprovedFindings } = await import('./auto-executor.js');
const { completeTask, createTask, getDb } = await import('./task-queue.js');

function resetState() {
  const db = getDb();
  db.exec(`
    DELETE FROM audit_log;
    DELETE FROM tasks;
  `);
}

describe('auto-executor', () => {
  beforeEach(() => {
    resetState();
  });

  it('creates typed follow-up tasks from actionable findings and handoffs', async () => {
    const completed = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Canary review of tokens-for-good repository',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: 'goal-1',
      workflowKind: 'review',
      sourceKind: 'dashboard',
    });

    completeTask(
      completed.id,
      {
        findings: [
          {
            id: 'finding-1',
            severity: 'MEDIUM',
            summary: 'Fix repo brief parsing',
            remediation: 'Fix repo-review-brief changed-file parsing and validate the surfaced paths.',
            actionable: true,
            targetCapability: 'engineering.code',
            followupKind: 'implement',
          },
        ],
        handoffRequests: [
          {
            id: 'handoff-1',
            targetAgent: 'engineering',
            workflowKind: 'validate',
            reason: 'Turn the canary verdict into concrete validation evidence.',
            summary: 'Run bounded canary validation for tokens-for-good and capture blockers.',
            execution: true,
          },
        ],
      },
      0,
      0,
    );

    const created = await processApprovedFindings();
    assert.equal(created, 2);

    const followups = getDb().prepare(`
      SELECT agent, lane, description, workflow_kind, source_kind, parent_task_id, project_id
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at ASC
    `).all() as Array<{
      agent: string;
      lane: string;
      description: string;
      workflow_kind: string;
      source_kind: string;
      parent_task_id: string | null;
      project_id: string;
    }>;

    assert.equal(followups.length, 2);
    assert.deepEqual(
      followups.map((task) => [task.agent, task.workflow_kind, task.project_id]),
      [
        ['engineering', 'implement', 'tokens-for-good'],
        ['engineering', 'validate', 'tokens-for-good'],
      ],
    );
  });

  it('deduplicates equivalent follow-up tasks across separate completed reviews', async () => {
    const finding = {
      id: 'finding-dup',
      severity: 'MEDIUM',
      summary: 'Fix repo brief parsing',
      remediation: 'Fix repo-review-brief changed-file parsing and validate the surfaced paths.',
      actionable: true,
      targetCapability: 'engineering.code',
      followupKind: 'implement',
    } as const;

    const first = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Initial canary review',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: 'goal-a',
      workflowKind: 'review',
      sourceKind: 'dashboard',
    });
    completeTask(first.id, { findings: [finding] }, 0, 0);

    const second = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Follow-up canary review',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: 'goal-b',
      workflowKind: 'review',
      sourceKind: 'dashboard',
    });
    completeTask(second.id, { findings: [finding] }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followups = getDb().prepare(`
      SELECT description
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at ASC
    `).all() as Array<{ description: string }>;

    assert.equal(followups.length, 1);
    assert.match(followups[0].description, /repo-review-brief/i);
  });
});
