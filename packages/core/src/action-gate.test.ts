import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureTestState } from './test-state.js';
import type { ProjectPolicy } from '../../shared/src/types.js';

configureTestState(import.meta.url);

const { evaluateRuntimeAction, workflowToRuntimeAction } = await import('./action-gate.js');
const { getDb } = await import('./task-queue.js');

function resetState() {
  getDb().exec(`DELETE FROM audit_log;`);
}

function buildPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    projectId: 'organism',
    repoPath: null,
    defaultBranch: 'master',
    qualityStandards: [],
    riskOverrides: { keywords: [], defaultLane: null, note: null },
    commands: {},
    deployTargets: [],
    allowedActions: ['edit_code', 'run_tests', 'build', 'commit', 'push', 'open_pr', 'deploy'],
    blockedActions: ['purchase', 'contact', 'create_account'],
    approvalThresholds: {
      majorActions: ['destructive_migration', 'cross_project', 'purchase', 'contact', 'create_account'],
    },
    envRequirements: [],
    workspaceMode: 'isolated_worktree',
    branchLifecycle: {
      dirtyWorktreeStrategy: 'stash_and_remove',
      archiveBeforeCleanup: true,
      deleteLocalBranchAfterPush: true,
      maxPreservedWorktreeAgeHours: 24,
      maxPreservedWorktrees: 3,
    },
    launchGuards: {
      minimumHealthyRunsForDeploy: 3,
      initialWorkflowLimit: 0,
      initialAllowedWorkflows: [],
      autoDeployAfterHealthyStreak: false,
    },
    autonomySurfaces: {
      readOnlyCanary: false,
      safeTaskKeywords: [],
      protectedTaskKeywords: [],
      readOnlyWorkflows: ['review', 'plan', 'validate'],
      safeImplementationWorkflows: ['review', 'plan', 'validate', 'recover', 'implement'],
      note: null,
    },
    selfAudit: {
      enabled: false,
      cadence: 'daily',
      dayOfWeek: null,
      hour: 8,
      idleCooldownMinutes: 24 * 60,
      workflows: ['review', 'validate', 'recover', 'implement'],
      maxFollowups: 0,
      description: 'Disabled in tests',
    },
    innovationRadar: {
      enabled: false,
      cadence: 'weekly',
      dayOfWeek: 3,
      hour: 9,
      agent: 'competitive-intel',
      shadow: true,
      focusAreas: [],
      maxOpportunities: 3,
      description: 'Disabled in tests',
    },
    toolProviders: {
      minimax: {
        enabled: false,
        region: 'global',
        allowedCommands: ['search'],
        authMode: 'auto',
      },
    },
    budgetCaps: { dailyUsd: null, deployUsd: null, contactUsd: null, purchaseUsd: null },
    autonomyMode: 'stabilization',
    ...overrides,
  };
}

describe('runtime action gate', () => {
  beforeEach(() => {
    resetState();
  });

  it('passes ordinary allowed implementation work', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'edit_code',
      actor: 'test',
      description: 'Implement a bounded dashboard status fix',
      workflowKind: 'implement',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, false);
    assert.equal(result.reasonCode, 'allowed');
  });

  it('blocks sidecar policy failures before runtime execution', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'edit_code',
      actor: 'test',
      description: 'Run git reset --hard to clear the workspace',
      command: 'git reset --hard',
      workflowKind: 'implement',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'sidecar_policy_block');
    assert.match(result.reason, /hard reset/i);
  });

  it('blocks sensitive actions implied by descriptions in stabilization mode', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'edit_code',
      actor: 'test',
      description: 'Email every customer about the launch',
      workflowKind: 'implement',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'sensitive_action_block');
    assert.equal(result.blockedAction, 'contact');
  });

  it('allows negated safety instructions mentioning blocked actions', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'run_tests',
      actor: 'test',
      description: 'Run a read-only canary. Do not contact anyone, do not purchase anything, and never create accounts.',
      workflowKind: 'review',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.reasonCode, 'allowed');
    assert.equal(result.blockedAction, null);
  });

  it('still blocks positive reminders to perform sensitive actions', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'edit_code',
      actor: 'test',
      description: 'Do not forget to email every customer about the launch.',
      workflowKind: 'implement',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, 'sensitive_action_block');
    assert.equal(result.blockedAction, 'contact');
  });

  it('keeps deploy approval-gated by default', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'deploy',
      actor: 'test',
      description: 'Deploy the dashboard',
      command: 'npx vercel --prod --yes',
      workflowKind: 'ship',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.reasonCode, 'approval_required');
  });

  it('allows deploy auto-execution only with explicit full-autonomy opt-in', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'deploy',
      actor: 'test',
      description: 'Deploy the dashboard',
      command: 'npx vercel --prod --yes',
      workflowKind: 'ship',
      policy: buildPolicy({
        autonomyMode: 'full_autonomy',
        launchGuards: {
          minimumHealthyRunsForDeploy: 3,
          initialWorkflowLimit: 0,
          initialAllowedWorkflows: [],
          autoDeployAfterHealthyStreak: true,
        },
      }),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, false);
    assert.equal(result.reasonCode, 'allowed');
  });

  it('requires approval for commands with shell redirection', async () => {
    const result = await evaluateRuntimeAction({
      projectId: 'organism',
      action: 'run_tests',
      actor: 'test',
      description: 'Run tests and capture output',
      command: 'pnpm test > test-output.log',
      workflowKind: 'validate',
      policy: buildPolicy(),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.reasonCode, 'contains_redirection');
  });

  it('maps workflows to their runtime action surfaces', () => {
    assert.equal(workflowToRuntimeAction('ship'), 'deploy');
    assert.equal(workflowToRuntimeAction('validate'), 'run_tests');
    assert.equal(workflowToRuntimeAction('implement'), 'edit_code');
  });
});
