import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cleanupEngineeringWorkspace, getDeployGate, runPolicyCommand, type EngineeringWorkspace } from './execution-controller.js';
import { createRunSession, ensureGoal } from './run-state.js';
import { getDb } from './task-queue.js';
import { type Task, type ProjectPolicy } from '../../shared/src/types.js';

function buildPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    projectId: 'organism',
    repoPath: null,
    defaultBranch: 'main',
    qualityStandards: [],
    riskOverrides: {
      keywords: [],
      defaultLane: null,
      note: null,
    },
    commands: {},
    deployTargets: [],
    allowedActions: ['edit_code', 'run_tests', 'build', 'commit', 'push', 'open_pr', 'deploy'],
    blockedActions: [],
    approvalThresholds: { majorActions: ['purchase', 'contact', 'create_account', 'cross_project', 'destructive_migration'] },
    envRequirements: [],
    workspaceMode: 'clean_required',
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
      description: 'Disabled in unit tests',
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
      description: 'Disabled in unit tests',
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

function buildTask(): Task {
  return {
    id: 'task-1',
    agent: 'engineering',
    status: 'pending',
    lane: 'MEDIUM',
    description: 'Controller action test',
    input: {},
    inputHash: 'hash',
    projectId: 'organism',
  };
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function initRepo(root: string): void {
  runGit(['init', '-b', 'main'], root);
  runGit(['config', 'user.email', 'test@example.com'], root);
  runGit(['config', 'user.name', 'Test User'], root);
  writeFileSync(join(root, 'README.md'), '# test\n');
  runGit(['add', 'README.md'], root);
  runGit(['commit', '-m', 'initial'], root);
}

describe('execution-controller', () => {
  let workspaceDir: string;

  beforeEach(() => {
    getDb().exec(`
      DELETE FROM runtime_events;
      DELETE FROM approvals;
      DELETE FROM interrupts;
      DELETE FROM artifacts;
      DELETE FROM run_steps;
      DELETE FROM run_sessions;
      DELETE FROM goals;
    `);
    workspaceDir = mkdtempSync(join(tmpdir(), 'organism-controller-test-'));
  });

  it('blocks privileged actions that are disallowed by policy', async () => {
    const workspace: EngineeringWorkspace = {
      projectId: 'organism',
      repoRootPath: workspaceDir,
      projectPath: workspaceDir,
      policy: buildPolicy({
        allowedActions: ['edit_code', 'run_tests', 'build'],
        blockedActions: ['push'],
      }),
      branchName: 'agent/engineering/test/block',
      defaultBranch: 'main',
      baselineDirty: false,
      baselineStatus: [],
      isolatedWorktree: false,
      recoveredWorktree: false,
    };

    const result = await runPolicyCommand(buildTask(), workspace, 'push', 'git push -u origin test');
    rmSync(workspaceDir, { recursive: true, force: true });

    assert.equal(result.ok, false);
    assert.match(result.output, /not allowed by policy/i);
  });

  it('executes allowed verification commands through the controller', async () => {
    const workspace: EngineeringWorkspace = {
      projectId: 'organism',
      repoRootPath: workspaceDir,
      projectPath: workspaceDir,
      policy: buildPolicy({
        allowedActions: ['edit_code', 'run_tests', 'build'],
      }),
      branchName: 'agent/engineering/test/build',
      defaultBranch: 'main',
      baselineDirty: false,
      baselineStatus: [],
      isolatedWorktree: false,
      recoveredWorktree: false,
    };

    const result = await runPolicyCommand(buildTask(), workspace, 'build', 'echo controller-ok');
    rmSync(workspaceDir, { recursive: true, force: true });

    assert.equal(result.ok, true);
    assert.match(result.output, /controller-ok/i);
  });

  it('keeps deploy in PR-only mode before the healthy-run gate opens', () => {
    const goal = ensureGoal({
      projectId: 'organism',
      title: 'Canary deploy test',
      description: 'Canary deploy test',
      sourceKind: 'user',
      workflowKind: 'implement',
    });
    createRunSession({
      goalId: goal.id,
      projectId: 'organism',
      agent: 'engineering',
      workflowKind: 'implement',
    });

    const gate = getDeployGate('organism', buildPolicy());
    rmSync(workspaceDir, { recursive: true, force: true });

    assert.equal(gate.locked, true);
    assert.match(gate.reason ?? '', /consecutive healthy goals/i);
  });

  it('stashes and removes dirty isolated worktrees when lifecycle policy requires cleanup', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'organism-controller-repo-'));
    const worktreePath = join(mkdtempSync(join(tmpdir(), 'organism-controller-wt-parent-')), 'task-worktree');
    initRepo(repoRoot);
    runGit(['worktree', 'add', '-b', 'agent/engineering/test/cleanup', worktreePath, 'main'], repoRoot);
    writeFileSync(join(worktreePath, 'dirty.txt'), 'dirty\n');

    const workspace: EngineeringWorkspace = {
      projectId: 'organism',
      repoRootPath: repoRoot,
      projectPath: worktreePath,
      policy: buildPolicy({
        repoPath: repoRoot,
        workspaceMode: 'isolated_worktree',
        branchLifecycle: {
          dirtyWorktreeStrategy: 'stash_and_remove',
          archiveBeforeCleanup: true,
          deleteLocalBranchAfterPush: true,
          maxPreservedWorktreeAgeHours: 24,
          maxPreservedWorktrees: 3,
        },
      }),
      branchName: 'agent/engineering/test/cleanup',
      defaultBranch: 'main',
      baselineDirty: false,
      baselineStatus: [],
      isolatedWorktree: true,
      recoveredWorktree: false,
    };

    const result = cleanupEngineeringWorkspace(workspace);
    const branchStillExists = (() => {
      try {
        runGit(['rev-parse', '--verify', 'refs/heads/agent/engineering/test/cleanup'], repoRoot);
        return true;
      } catch {
        return false;
      }
    })();

    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });

    assert.equal(result.removed, true);
    assert.equal(result.localBranchDeleted, true);
    assert.equal(existsSync(worktreePath), false);
    assert.match(result.stashRef ?? '', /^stash@\{0\}/);
    assert.match(result.archivedRef ?? '', /^refs\/archive\/workspace-cleanup\//);
    assert.equal(branchStillExists, false);
  });
});
