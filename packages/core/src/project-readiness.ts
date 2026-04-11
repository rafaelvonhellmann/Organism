import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getProjectAutonomyHealth } from './autonomy-governor.js';
import { getMiniMaxStatus } from './minimax.js';
import { loadProjectPolicy } from './project-policy.js';

export interface ProjectLaunchReadiness {
  projectId: string;
  repoPath: string | null;
  cleanWorktree: boolean;
  worktreeEntries: string[];
  workspaceMode: string;
  minimumHealthyRunsForDeploy: number;
  consecutiveHealthyRuns: number;
  deployUnlocked: boolean;
  gitRemoteUrl: string | null;
  gitRemoteProtocol: 'https' | 'ssh' | 'unknown' | 'none';
  githubHostTrusted: boolean;
  gitRemoteReachable: boolean;
  ghCliAvailable: boolean;
  ghAuthReady: boolean;
  vercelTokenPresent: boolean;
  tasklistPresent: boolean;
  configPresent: boolean;
  rootAgentsPresent: boolean;
  minimax: ReturnType<typeof getMiniMaxStatus>;
  blockers: string[];
  warnings: string[];
}

function commandExists(command: string): boolean {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function tryRun(command: string, args: string[], cwd?: string): string {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return result.status === 0 ? (result.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function parseStatus(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectRemoteProtocol(remoteUrl: string | null): ProjectLaunchReadiness['gitRemoteProtocol'] {
  if (!remoteUrl) return 'none';
  if (remoteUrl.startsWith('https://')) return 'https';
  if (remoteUrl.startsWith('git@') || remoteUrl.startsWith('ssh://')) return 'ssh';
  return 'unknown';
}

function githubHostTrusted(): boolean {
  const sshHome = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (!sshHome) return false;
  const knownHosts = path.join(sshHome, '.ssh', 'known_hosts');
  if (!fs.existsSync(knownHosts)) return false;
  try {
    const content = fs.readFileSync(knownHosts, 'utf8');
    return /github\.com/i.test(content);
  } catch {
    return false;
  }
}

function ghAuthReady(): boolean {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
  if (!commandExists('gh')) return false;
  const result = spawnSync('gh', ['auth', 'status'], {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.status === 0;
}

function gitRemoteReachable(repoPath: string | null): boolean {
  if (!repoPath) return false;
  const output = tryRun('git', ['ls-remote', '--heads', 'origin'], repoPath);
  return output.length > 0;
}

export function getProjectLaunchReadiness(projectId: string): ProjectLaunchReadiness {
  const policy = loadProjectPolicy(projectId);
  const autonomy = getProjectAutonomyHealth(projectId);
  const repoPath = policy.repoPath;
  const configPath = path.resolve(process.cwd(), 'knowledge', 'projects', projectId, 'config.json');
  const rootAgentsPath = path.resolve(process.cwd(), 'AGENTS.md');
  const tasklistPath = (() => {
    if (!fs.existsSync(configPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { tasklist?: string };
      return typeof raw.tasklist === 'string' ? raw.tasklist : null;
    } catch {
      return null;
    }
  })();

  const worktreeEntries = repoPath && fs.existsSync(repoPath)
    ? parseStatus(tryRun('git', ['status', '--porcelain'], repoPath))
    : [];
  const gitRemoteUrl = repoPath && fs.existsSync(repoPath)
    ? tryRun('git', ['remote', 'get-url', 'origin'], repoPath) || null
    : null;
  const gitRemoteProtocol = detectRemoteProtocol(gitRemoteUrl);
  const hostTrusted = gitRemoteProtocol !== 'ssh' || githubHostTrusted();
  const remoteReachable = gitRemoteReachable(repoPath);
  const minimax = getMiniMaxStatus(policy);

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!repoPath || !fs.existsSync(repoPath)) {
    blockers.push('Repository path is missing or does not exist.');
  }
  if (policy.workspaceMode === 'clean_required' && worktreeEntries.length > 0) {
    blockers.push(`Workspace is dirty (${worktreeEntries.length} git status entries).`);
  }
  if (policy.workspaceMode === 'isolated_worktree' && worktreeEntries.length > 0) {
    warnings.push(`Primary worktree is dirty (${worktreeEntries.length} entries), but isolated worktree mode will bypass it.`);
  }
  if (policy.launchGuards.minimumHealthyRunsForDeploy > autonomy.consecutiveHealthyRuns) {
    warnings.push(
      `Deploy stays approval-gated until ${policy.launchGuards.minimumHealthyRunsForDeploy} healthy runs; current streak is ${autonomy.consecutiveHealthyRuns}.`,
    );
  }
  if (policy.allowedActions.includes('push') && !remoteReachable) {
    blockers.push('Git remote is not reachable non-interactively for push actions.');
  }
  if (policy.allowedActions.includes('open_pr') && !ghAuthReady()) {
    warnings.push('gh auth is not ready; PR creation may pause even if git push works.');
  }
  if (policy.allowedActions.includes('deploy') && !process.env.VERCEL_TOKEN) {
    warnings.push('VERCEL_TOKEN is not present; deploy actions may pause.');
  }
  if (gitRemoteProtocol === 'ssh' && !hostTrusted) {
    blockers.push('GitHub SSH host trust is not established for this machine.');
  }
  if (!fs.existsSync(configPath)) {
    blockers.push('Project config.json is missing.');
  }
  if (!fs.existsSync(rootAgentsPath)) {
    blockers.push('Root AGENTS.md is missing.');
  }
  if (tasklistPath && !fs.existsSync(tasklistPath)) {
    warnings.push('Configured tasklist file does not exist.');
  }
  if (policy.toolProviders.minimax.enabled && !minimax.ready) {
    warnings.push(minimax.reason ?? 'MiniMax is enabled but not ready.');
  }

  return {
    projectId,
    repoPath,
    cleanWorktree: policy.workspaceMode === 'isolated_worktree' ? true : worktreeEntries.length === 0,
    worktreeEntries,
    workspaceMode: policy.workspaceMode,
    minimumHealthyRunsForDeploy: policy.launchGuards.minimumHealthyRunsForDeploy,
    consecutiveHealthyRuns: autonomy.consecutiveHealthyRuns,
    deployUnlocked: autonomy.consecutiveHealthyRuns >= policy.launchGuards.minimumHealthyRunsForDeploy,
    gitRemoteUrl,
    gitRemoteProtocol,
    githubHostTrusted: hostTrusted,
    gitRemoteReachable: remoteReachable,
    ghCliAvailable: commandExists('gh'),
    ghAuthReady: ghAuthReady(),
    vercelTokenPresent: Boolean(process.env.VERCEL_TOKEN),
    tasklistPresent: tasklistPath ? fs.existsSync(tasklistPath) : false,
    configPresent: fs.existsSync(configPath),
    rootAgentsPresent: fs.existsSync(rootAgentsPath),
    minimax,
    blockers,
    warnings,
  };
}
