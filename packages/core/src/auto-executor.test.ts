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
        ['quality-agent', 'validate', 'tokens-for-good'],
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

  it('promotes only the single highest-priority actionable finding from a project autonomy review', async () => {
    const completed = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Autonomy cycle review for tokens-for-good',
      input: { projectId: 'tokens-for-good', autonomyCycle: true },
      projectId: 'tokens-for-good',
      goalId: 'goal-cycle',
      workflowKind: 'review',
      sourceKind: 'system',
    });

    completeTask(completed.id, {
      mode: 'autonomy_cycle_review',
      findings: [
        {
          id: 'finding-recover',
          severity: 'LOW',
          summary: 'Stay on isolated worktrees',
          remediation: 'Seed the next autonomous tasks in an isolated worktree off clean main.',
          actionable: true,
          targetCapability: 'quality.review',
          followupKind: 'recover',
        },
        {
          id: 'finding-implement',
          severity: 'MEDIUM',
          summary: 'Deepen hosted validation',
          remediation: 'Extend the hosted validator with an explicit canary mode and bounded seeded data.',
          actionable: true,
          targetCapability: 'engineering.code',
          followupKind: 'implement',
        },
        {
          id: 'finding-plan',
          severity: 'LOW',
          summary: 'Write a small backlog note',
          remediation: 'Document the next launch-ready profile split.',
          actionable: true,
          targetCapability: 'product.prd',
          followupKind: 'plan',
        },
      ],
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followups = getDb().prepare(`
      SELECT agent, workflow_kind, description
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at ASC
    `).all() as Array<{ agent: string; workflow_kind: string; description: string }>;

    assert.equal(followups.length, 1);
    assert.equal(followups[0]?.agent, 'engineering');
    assert.equal(followups[0]?.workflow_kind, 'implement');
    assert.match(followups[0]?.description ?? '', /hosted validator/i);
  });

  it('adds one bounded validation task when a project review surfaces both execution and validation work', async () => {
    const completed = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Project review for tokens-for-good',
      input: { projectId: 'tokens-for-good' },
      projectId: 'tokens-for-good',
      goalId: 'goal-validation-pair',
      workflowKind: 'review',
      sourceKind: 'system',
    });

    completeTask(completed.id, {
      mode: 'project_review',
      findings: [
        {
          id: 'finding-implement',
          severity: 'MEDIUM',
          summary: 'Implement a tighter validator retry path',
          remediation: 'Implement a tighter hosted validator retry path with bounded seeded inputs and one retry policy.',
          actionable: true,
          targetCapability: 'engineering.code',
          followupKind: 'implement',
        },
        {
          id: 'finding-validate',
          severity: 'LOW',
          summary: 'Validate the hosted validator path',
          remediation: 'Validate the hosted validator path against one seeded scenario and capture the verification output.',
          actionable: true,
          targetCapability: 'quality.review',
          followupKind: 'validate',
        },
      ],
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 2);

    const followups = getDb().prepare(`
      SELECT agent, workflow_kind, description
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at ASC
    `).all() as Array<{ agent: string; workflow_kind: string; description: string }>;

    assert.deepEqual(
      followups.map((task) => task.workflow_kind),
      ['implement', 'validate'],
    );
  });

  it('routes Synapse validator follow-ups to an allowed review agent', async () => {
    const completed = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Medical-safe canary review for synapse',
      input: { projectId: 'synapse', readOnlyCanary: true },
      projectId: 'synapse',
      goalId: 'goal-synapse-review',
      workflowKind: 'review',
      sourceKind: 'dashboard',
    });

    completeTask(completed.id, {
      handoffRequests: [
        {
          id: 'handoff-synapse-validate',
          targetAgent: 'codex-review',
          workflowKind: 'validate',
          reason: 'Confirm the auth-risk map without changing implementation.',
          summary: 'Validate the admin dashboard auth flow for Synapse and capture review evidence.',
          execution: false,
        },
      ],
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followup = getDb().prepare(`
      SELECT agent, workflow_kind, description
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as { agent: string; workflow_kind: string; description: string };

    assert.ok(['quality-agent', 'codex-review'].includes(followup.agent));
    assert.equal(followup.workflow_kind, 'validate');
    assert.match(followup.description, /admin dashboard auth flow/i);
  });

  it('degrades blocked Synapse implementation follow-ups into read-only validation during the canary lane', async () => {
    const completed = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Medical-safe canary review for synapse',
      input: { projectId: 'synapse', readOnlyCanary: true },
      projectId: 'synapse',
      goalId: 'goal-synapse-canary',
      workflowKind: 'review',
      sourceKind: 'dashboard',
    });

    completeTask(completed.id, {
      findings: [
        {
          id: 'finding-synapse-safe-surface',
          severity: 'MEDIUM',
          summary: 'Tighten admin dashboard auth validation',
          remediation: 'Tighten the admin dashboard auth validation path and capture the safety evidence.',
          actionable: true,
          targetCapability: 'engineering.code',
          followupKind: 'implement',
        },
      ],
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followup = getDb().prepare(`
      SELECT agent, workflow_kind, description
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at DESC
      LIMIT 1
    `).get() as { agent: string; workflow_kind: string; description: string };

    assert.equal(followup.agent, 'quality-agent');
    assert.equal(followup.workflow_kind, 'validate');
    assert.match(followup.description, /admin dashboard auth validation/i);
  });

  it('prefers a bounded engineering recovery task before validation when a project review is blocked', async () => {
    const completed = createTask({
      agent: 'quality-agent',
      lane: 'MEDIUM',
      description: 'Autonomy cycle review for tokens-for-good',
      input: { projectId: 'tokens-for-good', autonomyCycle: true },
      projectId: 'tokens-for-good',
      goalId: 'goal-blocked-cycle',
      workflowKind: 'review',
      sourceKind: 'system',
    });

    completeTask(completed.id, {
      mode: 'autonomy_cycle_review',
      findings: [
        {
          id: 'finding-recover-engineering',
          severity: 'MEDIUM',
          summary: 'Recover hosted validator transport failure',
          remediation: 'Recover the hosted validator transport path for tokens-for-good in one bounded pass.',
          actionable: true,
          targetCapability: 'engineering.code',
          followupKind: 'recover',
        },
        {
          id: 'finding-validate',
          severity: 'LOW',
          summary: 'Validate the hosted validator path',
          remediation: 'Validate the hosted validator path after recovery and capture the verification output.',
          actionable: true,
          targetCapability: 'quality.review',
          followupKind: 'validate',
        },
      ],
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followups = getDb().prepare(`
      SELECT agent, workflow_kind, description
      FROM tasks
      WHERE source_kind = 'agent_followup'
      ORDER BY created_at ASC
    `).all() as Array<{ agent: string; workflow_kind: string; description: string }>;

    assert.equal(followups.length, 1);
    assert.equal(followups[0]?.agent, 'engineering');
    assert.equal(followups[0]?.workflow_kind, 'implement');
    assert.match(followups[0]?.description ?? '', /hosted validator transport path/i);
  });

  it('creates a bounded revision task from codex-review NEEDS_REVISION output', async () => {
    const original = createTask({
      agent: 'engineering',
      lane: 'MEDIUM',
      description: 'Implement canary gate for tokens-for-good',
      input: { execution: true },
      projectId: 'tokens-for-good',
      goalId: 'goal-revision',
      workflowKind: 'implement',
      sourceKind: 'dashboard',
    });
    completeTask(original.id, { summary: 'Initial implementation' }, 0, 0);

    const review = createTask({
      agent: 'codex-review',
      lane: 'LOW',
      description: 'Codex review: "Implement canary gate for tokens-for-good"',
      input: { originalTaskId: original.id, originalDescription: original.description },
      parentTaskId: original.id,
      projectId: 'tokens-for-good',
      goalId: 'goal-revision',
      workflowKind: 'validate',
      sourceKind: 'agent_followup',
    });
    completeTask(review.id, {
      review: '## Codex Review\n\n**Decision:** NEEDS_REVISION\n\n**Summary:** Missing actual validation evidence.',
      decision: 'NEEDS_REVISION',
      originalTaskId: original.id,
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followup = getDb().prepare(`
      SELECT agent, workflow_kind, description, input, parent_task_id
      FROM tasks
      WHERE source_kind = 'agent_followup' AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(review.id) as {
      agent: string;
      workflow_kind: string;
      description: string;
      input: string;
      parent_task_id: string;
    };

    assert.equal(followup.agent, 'engineering');
    assert.equal(followup.workflow_kind, 'implement');
    assert.match(followup.description, /codex-review findings/i);
    assert.equal(followup.parent_task_id, original.id);
    assert.match(followup.input, /qualityFeedback/i);
  });

  it('creates a validation task after a clean engineering implementation completes', async () => {
    const original = createTask({
      agent: 'engineering',
      lane: 'LOW',
      description: 'Implement bounded canary controls for tokens-for-good',
      input: { execution: true },
      projectId: 'tokens-for-good',
      goalId: 'goal-validate-after-implement',
      workflowKind: 'implement',
      sourceKind: 'agent_followup',
    });

    completeTask(original.id, {
      mode: 'executed',
      changedFiles: ['packages/contracts/src/canary-policy.ts'],
      workspaceCleanup: {
        removed: true,
        path: 'C:/Users/rafae/.organism/state/worktrees/tokens-for-good/clean-validate',
      },
      verification: [
        {
          action: 'build',
          ok: true,
          output: 'build passed',
        },
      ],
      summary: 'Implemented the change cleanly and verification passed.',
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followup = getDb().prepare(`
      SELECT agent, workflow_kind, description, input, parent_task_id
      FROM tasks
      WHERE source_kind = 'agent_followup' AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(original.id) as {
      agent: string;
      workflow_kind: string;
      description: string;
      input: string;
      parent_task_id: string;
    };

    assert.equal(followup.agent, 'quality-agent');
    assert.equal(followup.workflow_kind, 'validate');
    assert.match(followup.description, /validate implementation/i);
    assert.equal(followup.parent_task_id, original.id);
    assert.match(followup.input, /changedFiles/i);
  });

  it('creates an engineering recovery task when a preserved worktree still needs verification', async () => {
    const original = createTask({
      agent: 'engineering',
      lane: 'LOW',
      description: 'Implement bounded canary controls for tokens-for-good',
      input: { execution: true },
      projectId: 'tokens-for-good',
      goalId: 'goal-recover',
      workflowKind: 'implement',
      sourceKind: 'agent_followup',
    });

    completeTask(original.id, {
      mode: 'executed',
      changedFiles: ['packages/contracts/src/canary-policy.ts'],
      workspaceCleanup: {
        removed: false,
        path: 'C:/Users/rafae/.organism/state/worktrees/tokens-for-good/recover-demo',
      },
      verification: [
        {
          action: 'build',
          ok: false,
          output: 'pnpm typecheck failed',
        },
      ],
      summary: 'Implemented changes but verification is still blocked in the preserved worktree.',
    }, 0, 0);

    const created = await processApprovedFindings();
    assert.equal(created, 1);

    const followup = getDb().prepare(`
      SELECT agent, workflow_kind, description, input, parent_task_id
      FROM tasks
      WHERE source_kind = 'agent_followup' AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(original.id) as {
      agent: string;
      workflow_kind: string;
      description: string;
      input: string;
      parent_task_id: string;
    };

    assert.equal(followup.agent, 'engineering');
    assert.equal(followup.workflow_kind, 'implement');
    assert.match(followup.description, /Fix build in preserved worktree/i);
    assert.equal(followup.parent_task_id, original.id);
    assert.match(followup.input, /recoverWorktreePath/i);
  });

  it('collapses recursive recovery descriptions into a bounded next step', async () => {
    const original = createTask({
      agent: 'engineering',
      lane: 'LOW',
      description: 'Fix build in preserved worktree for "Fix build in preserved worktree for \\"Extend hosted validator canary mode\\""',
      input: { execution: true },
      projectId: 'tokens-for-good',
      goalId: 'goal-recover-focus',
      workflowKind: 'recover',
      sourceKind: 'agent_followup',
    });

    completeTask(original.id, {
      mode: 'executed',
      changedFiles: ['scripts/validate-hosted-backend.ts'],
      workspaceCleanup: {
        removed: false,
        path: 'C:/Users/rafae/.organism/state/worktrees/tokens-for-good/recover-focus',
      },
      verification: [
        {
          action: 'build',
          ok: false,
          output: 'corepack pnpm build failed',
        },
      ],
      summary: 'Verification is still blocked in the preserved worktree.',
    }, 0, 0);

    await processApprovedFindings();

    const followup = getDb().prepare(`
      SELECT description
      FROM tasks
      WHERE source_kind = 'agent_followup' AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(original.id) as { description: string };

    assert.ok(followup.description.includes('Extend hosted validator canary mode'));
    assert.equal((followup.description.match(/Fix build in preserved worktree/gi) ?? []).length, 1);
  });
});
