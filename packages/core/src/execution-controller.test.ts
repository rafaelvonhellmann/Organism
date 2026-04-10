import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPolicyCommand, type EngineeringWorkspace } from './execution-controller.js';
import { type Task, type ProjectPolicy } from '../../shared/src/types.js';

function buildPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    projectId: 'organism',
    repoPath: null,
    defaultBranch: 'main',
    commands: {},
    deployTargets: [],
    allowedActions: ['edit_code', 'run_tests', 'build', 'commit', 'push', 'open_pr', 'deploy'],
    blockedActions: [],
    approvalThresholds: { majorActions: ['purchase', 'contact', 'create_account', 'cross_project', 'destructive_migration'] },
    envRequirements: [],
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

describe('execution-controller', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'organism-controller-test-'));
  });

  it('blocks privileged actions that are disallowed by policy', () => {
    const workspace: EngineeringWorkspace = {
      projectId: 'organism',
      projectPath: workspaceDir,
      policy: buildPolicy({
        allowedActions: ['edit_code', 'run_tests', 'build'],
        blockedActions: ['push'],
      }),
      branchName: 'agent/engineering/test/block',
      defaultBranch: 'main',
      baselineDirty: false,
      baselineStatus: [],
    };

    const result = runPolicyCommand(buildTask(), workspace, 'push', 'git push -u origin test');
    rmSync(workspaceDir, { recursive: true, force: true });

    assert.equal(result.ok, false);
    assert.match(result.output, /not allowed by policy/i);
  });

  it('executes allowed verification commands through the controller', () => {
    const workspace: EngineeringWorkspace = {
      projectId: 'organism',
      projectPath: workspaceDir,
      policy: buildPolicy({
        allowedActions: ['edit_code', 'run_tests', 'build'],
      }),
      branchName: 'agent/engineering/test/build',
      defaultBranch: 'main',
      baselineDirty: false,
      baselineStatus: [],
    };

    const result = runPolicyCommand(buildTask(), workspace, 'build', 'echo controller-ok');
    rmSync(workspaceDir, { recursive: true, force: true });

    assert.equal(result.ok, true);
    assert.match(result.output, /controller-ok/i);
  });
});
