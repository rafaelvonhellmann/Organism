import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { appendCommandLog, updateRunProgress } from './run-memory.js';
import { loadProjectPolicy, getV2DeployTargets, isActionAllowed, isActionBlocked, requiresApproval } from './project-policy.js';
import { createApprovalRecord, createArtifact, createInterrupt, getLatestRunForGoal } from './run-state.js';
import { recordRuntimeEvent } from './runtime-events.js';
import { Task, CommandProposal, ApprovalRequest, ProjectAction, ProjectPolicy } from '../../shared/src/types.js';

interface GitStatusEntry {
  code: string;
  path: string;
}

export interface EngineeringWorkspace {
  projectId: string;
  projectPath: string;
  policy: ProjectPolicy;
  branchName: string;
  defaultBranch: string;
  baselineDirty: boolean;
  baselineStatus: GitStatusEntry[];
}

export interface ControllerCommandResult {
  action: ProjectAction;
  command: string;
  ok: boolean;
  output: string;
}

export interface EngineeringExecutionSummary {
  branch: string;
  changedFiles: string[];
  baselineDirty: boolean;
  diffSummary: string;
  verification: ControllerCommandResult[];
  controllerActions: ControllerCommandResult[];
  commandProposals: CommandProposal[];
  approvalRequests: ApprovalRequest[];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/^\[cascade\]\s*follow-up from \S+:\s*/i, '')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'task';
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRunGit(args: string[], cwd: string): string {
  try {
    return runGit(args, cwd);
  } catch {
    return '';
  }
}

function ensureRepo(projectPath: string): void {
  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }
  const gitDir = path.join(projectPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Project path is not a git repository: ${projectPath}`);
  }
}

function parseStatus(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }));
}

function listStatus(projectPath: string): GitStatusEntry[] {
  return parseStatus(tryRunGit(['status', '--porcelain'], projectPath));
}

function resolveDefaultBranch(projectPath: string, policy: ProjectPolicy): string {
  const remoteHead = tryRunGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], projectPath);
  if (remoteHead.startsWith('refs/remotes/origin/')) {
    return remoteHead.replace('refs/remotes/origin/', '');
  }
  return policy.defaultBranch || 'main';
}

function buildBranchName(task: Task): string {
  return `agent/engineering/${task.id.slice(0, 8)}/${slugify(task.description)}`;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function currentRun(task: Task) {
  return task.goalId ? getLatestRunForGoal(task.goalId) : null;
}

function recordToolEvent(task: Task, eventType: 'tool.started' | 'tool.finished', payload: unknown): void {
  const run = currentRun(task);
  if (!run) return;
  recordRuntimeEvent({
    runId: run.id,
    goalId: run.goalId,
    eventType,
    payload,
    agent: 'controller',
  });
}

function recordControllerArtifact(task: Task, kind: 'command_log' | 'patch' | 'verification' | 'deployment', title: string, content: string): void {
  const run = currentRun(task);
  if (!run) return;
  createArtifact({
    runId: run.id,
    goalId: run.goalId,
    kind,
    title,
    content: content.slice(0, 12000),
  });
}

function maybeCreateApproval(task: Task, action: ProjectAction, reason: string, summary: string): ApprovalRequest | null {
  const run = currentRun(task);
  if (!run) {
    return {
      id: crypto.randomUUID(),
      action,
      reason,
      summary,
    };
  }

  const record = createApprovalRecord({
    runId: run.id,
    action,
    requestedBy: 'controller',
    reason,
  });
  createInterrupt({
    runId: run.id,
    type: 'approval',
    summary,
    detail: reason,
  });
  return {
    id: record.id,
    action,
    reason,
    summary,
  };
}

function commandForAction(policy: ProjectPolicy, action: ProjectAction, branchName: string): string | null {
  switch (action) {
    case 'push':
      return `git push -u origin ${branchName}`;
    case 'open_pr':
      return `gh pr create --title "[agent] ${branchName}" --body "Autonomous change from Organism v2 controller"`;
    case 'deploy':
      return policy.commands.deploy ?? null;
    default:
      return null;
  }
}

export function prepareEngineeringWorkspace(task: Task): EngineeringWorkspace {
  const projectId = task.projectId ?? 'organism';
  const policy = loadProjectPolicy(projectId);
  if (!policy.repoPath) {
    throw new Error(`Project policy for ${projectId} does not define repoPath`);
  }
  ensureRepo(policy.repoPath);

  const defaultBranch = resolveDefaultBranch(policy.repoPath, policy);
  const branchName = buildBranchName(task);
  const baselineStatus = listStatus(policy.repoPath);

  if (!tryRunGit(['branch', '--list', branchName], policy.repoPath)) {
    try {
      runGit(['checkout', '-b', branchName, `origin/${defaultBranch}`], policy.repoPath);
    } catch {
      runGit(['checkout', '-b', branchName, defaultBranch], policy.repoPath);
    }
  } else {
    runGit(['checkout', branchName], policy.repoPath);
  }

  if (task.goalId) {
    updateRunProgress(task.goalId, [
      `- Controller prepared workspace \`${policy.repoPath}\``,
      `- Branch: \`${branchName}\``,
    ]);
  }

  recordToolEvent(task, 'tool.started', {
    action: 'edit_code',
    branchName,
    projectPath: policy.repoPath,
  });
  recordToolEvent(task, 'tool.finished', {
    action: 'edit_code',
    branchName,
    baselineDirty: baselineStatus.length > 0,
  });

  return {
    projectId,
    projectPath: policy.repoPath,
    policy,
    branchName,
    defaultBranch,
    baselineDirty: baselineStatus.length > 0,
    baselineStatus,
  };
}

export function runPolicyCommand(task: Task, workspace: EngineeringWorkspace, action: ProjectAction, command: string): ControllerCommandResult {
  if (!isActionAllowed(workspace.policy, action)) {
    return {
      action,
      command,
      ok: false,
      output: `Action "${action}" is not allowed by policy for ${workspace.projectId}`,
    };
  }

  recordToolEvent(task, 'tool.started', { action, command, cwd: workspace.projectPath });
  try {
    const output = execSync(command, {
      cwd: workspace.projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
    }).trim();
    recordToolEvent(task, 'tool.finished', { action, command, ok: true });
    if (task.goalId) {
      appendCommandLog(task.goalId, { action, command, ok: true, output });
    }
    recordControllerArtifact(task, 'verification', `Verification: ${action}`, output || `${action} completed`);
    return { action, command, ok: true, output };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    recordToolEvent(task, 'tool.finished', { action, command, ok: false, error: output });
    if (task.goalId) {
      appendCommandLog(task.goalId, { action, command, ok: false, output });
    }
    recordControllerArtifact(task, 'verification', `Verification failed: ${action}`, output);
    return { action, command, ok: false, output };
  }
}

function collectChangedFiles(workspace: EngineeringWorkspace): string[] {
  const current = listStatus(workspace.projectPath).map((entry) => entry.path);
  return [...new Set(current)];
}

function diffSummary(projectPath: string): string {
  const summary = tryRunGit(['diff', '--stat'], projectPath);
  return summary || 'No diff summary available';
}

function commitIfSafe(task: Task, workspace: EngineeringWorkspace, changedFiles: string[]): { proposals: CommandProposal[]; committed: boolean } {
  const proposals: CommandProposal[] = [];
  if (!changedFiles.length) return { proposals, committed: false };

  const commitMessage = `[agent] ${task.description.replace(/\s+/g, ' ').slice(0, 68)}`;
  if (!isActionAllowed(workspace.policy, 'commit')) {
    proposals.push({
      id: crypto.randomUUID(),
      action: 'commit',
      command: `git commit -m ${quoteForCmd(commitMessage)}`,
      cwd: workspace.projectPath,
      reason: 'Commit is disabled by project policy.',
      requiresApproval: true,
    });
    return { proposals, committed: false };
  }

  if (workspace.baselineDirty) {
    proposals.push({
      id: crypto.randomUUID(),
      action: 'commit',
      command: `git commit -m ${quoteForCmd(commitMessage)}`,
      cwd: workspace.projectPath,
      reason: 'Workspace was already dirty before the run, so commit was deferred to avoid mixing Rafael changes with agent changes.',
      requiresApproval: true,
    });
    return { proposals, committed: false };
  }

  try {
    runGit(['add', '--', ...changedFiles], workspace.projectPath);
    const output = runGit(['commit', '-m', commitMessage], workspace.projectPath);
    if (task.goalId) {
      appendCommandLog(task.goalId, { action: 'commit', command: `git commit -m ${commitMessage}`, ok: true, output });
      updateRunProgress(task.goalId, [
        `- Controller committed ${changedFiles.length} file(s) on \`${workspace.branchName}\``,
      ]);
    }
    recordControllerArtifact(task, 'command_log', 'Commit output', output || 'Commit created');
    return { proposals, committed: true };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    proposals.push({
      id: crypto.randomUUID(),
      action: 'commit',
      command: `git commit -m ${quoteForCmd(commitMessage)}`,
      cwd: workspace.projectPath,
      reason: output,
      requiresApproval: true,
    });
    return { proposals, committed: false };
  }
}

function proposedAction(task: Task, workspace: EngineeringWorkspace, action: ProjectAction, reason: string): { proposal: CommandProposal | null; approval: ApprovalRequest | null } {
  const command = commandForAction(workspace.policy, action, workspace.branchName);
  if (!command) return { proposal: null, approval: null };

  const blocked = isActionBlocked(workspace.policy, action);
  const needsApproval = requiresApproval(workspace.policy, action) || blocked;
  const proposal: CommandProposal = {
    id: crypto.randomUUID(),
    action,
    command,
    cwd: workspace.projectPath,
    reason,
    requiresApproval: needsApproval,
  };

  const approval = needsApproval
    ? maybeCreateApproval(task, action, reason, `${action} is queued for approval on ${workspace.projectId}`)
    : null;

  return { proposal, approval };
}

function executeOrQueueAction(params: {
  task: Task;
  workspace: EngineeringWorkspace;
  action: ProjectAction;
  reason: string;
  autoExecute: boolean;
}): { actionResult: ControllerCommandResult | null; proposal: CommandProposal | null; approval: ApprovalRequest | null } {
  const proposalResult = proposedAction(params.task, params.workspace, params.action, params.reason);
  if (!proposalResult.proposal) {
    return { actionResult: null, proposal: null, approval: null };
  }

  if (!params.autoExecute || proposalResult.proposal.requiresApproval) {
    return { actionResult: null, proposal: proposalResult.proposal, approval: proposalResult.approval };
  }

  const actionResult = runPolicyCommand(params.task, params.workspace, params.action, proposalResult.proposal.command);
  if (actionResult.ok) {
    return { actionResult, proposal: null, approval: null };
  }

  return {
    actionResult,
    proposal: {
      ...proposalResult.proposal,
      requiresApproval: true,
      reason: `Automatic ${params.action} failed: ${actionResult.output}`,
    },
    approval: maybeCreateApproval(
      params.task,
      params.action,
      actionResult.output,
      `${params.action} needs review after automatic execution failed on ${params.workspace.projectId}`,
    ),
  };
}

export function finalizeEngineeringExecution(task: Task, workspace: EngineeringWorkspace): EngineeringExecutionSummary {
  const changedFiles = collectChangedFiles(workspace);
  const verification: ControllerCommandResult[] = [];
  const controllerActions: ControllerCommandResult[] = [];

  if (workspace.policy.commands.lint) {
    verification.push(runPolicyCommand(task, workspace, 'build', workspace.policy.commands.lint));
  }
  if (workspace.policy.commands.test) {
    verification.push(runPolicyCommand(task, workspace, 'run_tests', workspace.policy.commands.test));
  }
  if (workspace.policy.commands.build) {
    verification.push(runPolicyCommand(task, workspace, 'build', workspace.policy.commands.build));
  }

  const commitResult = commitIfSafe(task, workspace, changedFiles);
  const commandProposals = [...commitResult.proposals];
  const approvalRequests: ApprovalRequest[] = [];
  const verificationPassed = verification.every((step) => step.ok);
  const canAutoAdvance = changedFiles.length > 0 && commitResult.committed && verificationPassed;

  if (changedFiles.length > 0) {
    const pushResult = executeOrQueueAction({
      task,
      workspace,
      action: 'push',
      reason: `Push ${changedFiles.length} changed file(s) on ${workspace.branchName}`,
      autoExecute: canAutoAdvance,
    });
    if (pushResult.actionResult) controllerActions.push(pushResult.actionResult);
    if (pushResult.proposal) commandProposals.push(pushResult.proposal);
    if (pushResult.approval) approvalRequests.push(pushResult.approval);

    const prResult = executeOrQueueAction({
      task,
      workspace,
      action: 'open_pr',
      reason: `Open a PR for ${workspace.branchName} so Rafael can compare v1 and v2 safely.`,
      autoExecute: canAutoAdvance,
    });
    if (prResult.actionResult) controllerActions.push(prResult.actionResult);
    if (prResult.proposal) commandProposals.push(prResult.proposal);
    if (prResult.approval) approvalRequests.push(prResult.approval);

    const deployTargets = getV2DeployTargets(workspace.policy);
    if (deployTargets.length > 0) {
      const deployResult = executeOrQueueAction({
        task,
        workspace,
        action: 'deploy',
        reason: `Deploy the forked experience to ${deployTargets.map((target) => target.url ?? target.project).join(', ')}`,
        autoExecute: canAutoAdvance,
      });
      if (deployResult.actionResult) {
        controllerActions.push(deployResult.actionResult);
        if (deployResult.actionResult.ok) {
          recordDeploymentTarget(task, workspace.projectId);
        }
      }
      if (deployResult.proposal) commandProposals.push(deployResult.proposal);
      if (deployResult.approval) approvalRequests.push(deployResult.approval);
    }
  }

  const summary = diffSummary(workspace.projectPath);
  recordControllerArtifact(task, 'patch', 'Workspace diff summary', summary);
  if (task.goalId) {
    updateRunProgress(task.goalId, [
      `- Changed files: ${changedFiles.length}`,
      `- Verification steps: ${verification.length}`,
    ]);
  }

  return {
    branch: workspace.branchName,
    changedFiles,
    baselineDirty: workspace.baselineDirty,
    diffSummary: summary,
    verification,
    controllerActions,
    commandProposals,
    approvalRequests,
  };
}

export function recordDeploymentTarget(task: Task, projectId: string): void {
  const run = currentRun(task);
  if (!run) return;
  const policy = loadProjectPolicy(projectId);
  const targets = getV2DeployTargets(policy);
  for (const target of targets) {
    recordRuntimeEvent({
      runId: run.id,
      goalId: run.goalId,
      eventType: 'deployment.created',
      payload: target,
      agent: 'controller',
    });
    recordControllerArtifact(
      task,
      'deployment',
      `Deployment target: ${target.name}`,
      `${target.provider}: ${target.url ?? target.project}`,
    );
  }
}
