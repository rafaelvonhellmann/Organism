import * as fs from 'fs';
import * as path from 'path';
import { AutonomyMode, ProjectAction, ProjectConfig, ProjectPolicy } from '../../shared/src/types.js';

const PROJECTS_DIR = path.resolve(process.cwd(), 'knowledge', 'projects');

const DEFAULT_ALLOWED_ACTIONS: ProjectAction[] = [
  'edit_code',
  'run_tests',
  'build',
  'commit',
  'push',
  'open_pr',
  'deploy',
];

const DEFAULT_MAJOR_ACTIONS: ProjectAction[] = [
  'destructive_migration',
  'cross_project',
  'purchase',
  'contact',
  'create_account',
];

const MODE_BLOCKS: Record<AutonomyMode, ProjectAction[]> = {
  stabilization: ['purchase', 'contact', 'create_account'],
  operational: [],
  full_autonomy: [],
};

function configPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, 'config.json');
}

function normalizeDeployTargets(raw: unknown): ProjectPolicy['deployTargets'] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const provider = row.provider === 'render' || row.provider === 'other' ? row.provider : 'vercel';
    const name = typeof row.name === 'string' ? row.name : '';
    const project = typeof row.project === 'string' ? row.project : '';
    if (!name || !project) return [];
    return [{
      name,
      provider,
      project,
      url: typeof row.url === 'string' ? row.url : undefined,
    }];
  });
}

function coerceConfig(projectId: string, raw: Record<string, unknown>): ProjectPolicy {
  const autonomyMode = (raw.autonomyMode === 'operational' || raw.autonomyMode === 'full_autonomy')
    ? raw.autonomyMode
    : 'stabilization';

  const rawAllowed = Array.isArray(raw.allowedActions)
    ? raw.allowedActions.filter((item): item is ProjectAction => typeof item === 'string')
    : DEFAULT_ALLOWED_ACTIONS;
  const rawBlocked = Array.isArray(raw.blockedActions)
    ? raw.blockedActions.filter((item): item is ProjectAction => typeof item === 'string')
    : [];
  const modeBlocked = MODE_BLOCKS[autonomyMode];
  const blockedActions = [...new Set([...rawBlocked, ...modeBlocked])];
  const allowedActions = rawAllowed.filter((action) => !blockedActions.includes(action));

  const thresholds = raw.approvalThresholds && typeof raw.approvalThresholds === 'object'
    ? raw.approvalThresholds as Record<string, unknown>
    : {};

  const budgetCaps = raw.budgetCaps && typeof raw.budgetCaps === 'object'
    ? raw.budgetCaps as Record<string, unknown>
    : {};

  const commands = raw.commands && typeof raw.commands === 'object'
    ? raw.commands as ProjectPolicy['commands']
    : {};

  const repoPath = typeof raw.repoPath === 'string'
    ? raw.repoPath
    : typeof raw.projectPath === 'string'
      ? raw.projectPath
      : null;

  const deployTargets = normalizeDeployTargets(raw.deployTargets);

  return {
    projectId,
    repoPath,
    defaultBranch: typeof raw.defaultBranch === 'string' ? raw.defaultBranch : 'main',
    commands,
    deployTargets,
    allowedActions,
    blockedActions,
    approvalThresholds: {
      majorActions: Array.isArray(thresholds.majorActions)
        ? thresholds.majorActions.filter((item): item is ProjectAction => typeof item === 'string')
        : DEFAULT_MAJOR_ACTIONS,
    },
    envRequirements: Array.isArray(raw.envRequirements)
      ? raw.envRequirements.filter((item): item is string => typeof item === 'string')
      : [],
    budgetCaps: {
      dailyUsd: typeof budgetCaps.dailyUsd === 'number' ? budgetCaps.dailyUsd : null,
      deployUsd: typeof budgetCaps.deployUsd === 'number' ? budgetCaps.deployUsd : null,
      contactUsd: typeof budgetCaps.contactUsd === 'number' ? budgetCaps.contactUsd : null,
      purchaseUsd: typeof budgetCaps.purchaseUsd === 'number' ? budgetCaps.purchaseUsd : null,
    },
    autonomyMode,
  };
}

export function loadProjectPolicy(projectId: string): ProjectPolicy {
  const file = configPath(projectId);
  if (!fs.existsSync(file)) {
    return coerceConfig(projectId, {});
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  return coerceConfig(projectId, raw);
}

export function listProjectPolicies(): ProjectPolicy[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadProjectPolicy(entry.name));
}

export function isActionBlocked(policy: ProjectPolicy, action: ProjectAction): boolean {
  return policy.blockedActions.includes(action);
}

export function isActionAllowed(policy: ProjectPolicy, action: ProjectAction): boolean {
  return !policy.blockedActions.includes(action) && policy.allowedActions.includes(action);
}

export function requiresApproval(policy: ProjectPolicy, action: ProjectAction): boolean {
  return policy.approvalThresholds.majorActions.includes(action) || isActionBlocked(policy, action);
}

export function toV2ProjectName(project: string): string {
  return project.endsWith('-v2') ? project : `${project}-v2`;
}

export function getV2DeployTargets(policy: ProjectPolicy): ProjectPolicy['deployTargets'] {
  return policy.deployTargets.map((target) => ({
    ...target,
    name: toV2ProjectName(target.name),
    project: toV2ProjectName(target.project),
    url: target.url ? target.url.replace('.vercel.app', '-v2.vercel.app') : target.url,
  }));
}

export function mergeProjectConfig(config: ProjectConfig, policy: ProjectPolicy): ProjectConfig {
  return {
    ...config,
    repoPath: config.repoPath ?? policy.repoPath ?? undefined,
    defaultBranch: config.defaultBranch ?? policy.defaultBranch,
    commands: { ...policy.commands, ...config.commands },
    deployTargets: config.deployTargets ?? policy.deployTargets,
    allowedActions: config.allowedActions ?? policy.allowedActions,
    blockedActions: config.blockedActions ?? policy.blockedActions,
    approvalThresholds: config.approvalThresholds ?? policy.approvalThresholds,
    envRequirements: config.envRequirements ?? policy.envRequirements,
    budgetCaps: config.budgetCaps ?? {
      dailyUsd: policy.budgetCaps.dailyUsd ?? undefined,
      deployUsd: policy.budgetCaps.deployUsd ?? undefined,
      contactUsd: policy.budgetCaps.contactUsd ?? undefined,
      purchaseUsd: policy.budgetCaps.purchaseUsd ?? undefined,
    },
    autonomyMode: config.autonomyMode ?? policy.autonomyMode,
  };
}
