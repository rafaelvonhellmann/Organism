import * as fs from 'fs';
import * as path from 'path';
import { AutonomyMode, MiniMaxCommand, ProjectAction, ProjectConfig, ProjectPolicy, RiskLane, WorkflowKind, WorkspaceMode } from '../../shared/src/types.js';

function getProjectsDir(): string {
  return path.resolve(process.cwd(), 'knowledge', 'projects');
}

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

const DEFAULT_MINIMAX_COMMANDS: MiniMaxCommand[] = ['search'];
const DEFAULT_SELF_AUDIT_WORKFLOWS: WorkflowKind[] = ['review', 'validate', 'recover', 'implement'];
const DEFAULT_READ_ONLY_WORKFLOWS: WorkflowKind[] = ['review', 'plan', 'validate'];
const DEFAULT_SAFE_IMPLEMENTATION_WORKFLOWS: WorkflowKind[] = ['review', 'plan', 'validate', 'recover', 'implement'];

function normalizeWorkspaceMode(raw: unknown, autonomyMode: AutonomyMode): WorkspaceMode {
  if (raw === 'direct' || raw === 'clean_required' || raw === 'isolated_worktree') return raw;
  return autonomyMode === 'stabilization' ? 'isolated_worktree' : 'direct';
}

function normalizeLaunchGuards(raw: unknown, autonomyMode: AutonomyMode): ProjectPolicy['launchGuards'] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const minimumHealthyRunsForDeploy = typeof record.minimumHealthyRunsForDeploy === 'number'
    ? Math.max(0, record.minimumHealthyRunsForDeploy)
    : autonomyMode === 'stabilization'
      ? 5
      : 0;
  const initialWorkflowLimit = typeof record.initialWorkflowLimit === 'number'
    ? Math.max(0, record.initialWorkflowLimit)
    : 0;
  const initialAllowedWorkflows = Array.isArray(record.initialAllowedWorkflows)
    ? record.initialAllowedWorkflows.filter((item): item is ProjectPolicy['launchGuards']['initialAllowedWorkflows'][number] => (
      item === 'review'
      || item === 'plan'
      || item === 'implement'
      || item === 'validate'
      || item === 'ship'
      || item === 'monitor'
      || item === 'recover'
      || item === 'shaping'
    ))
    : [];
  return {
    minimumHealthyRunsForDeploy,
    initialWorkflowLimit,
    initialAllowedWorkflows,
  };
}

function normalizeMiniMax(raw: unknown): ProjectPolicy['toolProviders']['minimax'] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const allowedCommands = Array.isArray(record.allowedCommands)
    ? record.allowedCommands.filter((item): item is MiniMaxCommand => item === 'search' || item === 'speech' || item === 'vision')
    : DEFAULT_MINIMAX_COMMANDS;
  return {
    enabled: record.enabled === true,
    region: record.region === 'cn' ? 'cn' : 'global',
    allowedCommands: allowedCommands.length > 0 ? allowedCommands : DEFAULT_MINIMAX_COMMANDS,
    authMode: record.authMode === 'api-key' || record.authMode === 'session' ? record.authMode : 'auto',
  };
}

function normalizeWorkflowList(
  raw: unknown,
  fallback: WorkflowKind[],
): WorkflowKind[] {
  if (!Array.isArray(raw)) return fallback;
  const workflows = raw.filter((item): item is WorkflowKind => (
    item === 'review'
      || item === 'plan'
      || item === 'implement'
      || item === 'validate'
      || item === 'ship'
      || item === 'monitor'
      || item === 'recover'
      || item === 'shaping'
  ));
  return workflows.length > 0 ? workflows : fallback;
}

function normalizeKeywordList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function normalizeRiskOverrides(raw: unknown): ProjectPolicy['riskOverrides'] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const defaultLane = record.defaultLane === 'LOW' || record.defaultLane === 'MEDIUM' || record.defaultLane === 'HIGH'
    ? record.defaultLane as RiskLane
    : null;
  return {
    keywords: normalizeKeywordList(record.keywords),
    defaultLane,
    note: typeof record.note === 'string' && record.note.trim().length > 0 ? record.note.trim() : null,
  };
}

function normalizeAutonomySurfaces(raw: unknown): ProjectPolicy['autonomySurfaces'] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    readOnlyCanary: record.readOnlyCanary === true,
    safeTaskKeywords: normalizeKeywordList(record.safeTaskKeywords),
    protectedTaskKeywords: normalizeKeywordList(record.protectedTaskKeywords),
    readOnlyWorkflows: normalizeWorkflowList(record.readOnlyWorkflows, DEFAULT_READ_ONLY_WORKFLOWS),
    safeImplementationWorkflows: normalizeWorkflowList(record.safeImplementationWorkflows, DEFAULT_SAFE_IMPLEMENTATION_WORKFLOWS),
    note: typeof record.note === 'string' && record.note.trim().length > 0 ? record.note.trim() : null,
  };
}

function normalizeSelfAudit(raw: unknown, projectId: string): ProjectPolicy['selfAudit'] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const workflows = Array.isArray(record.workflows)
    ? record.workflows.filter((item): item is WorkflowKind => (
      item === 'review'
      || item === 'plan'
      || item === 'implement'
      || item === 'validate'
      || item === 'monitor'
      || item === 'recover'
    ))
    : DEFAULT_SELF_AUDIT_WORKFLOWS;
  const cadence = record.cadence === 'weekly' ? 'weekly' : 'daily';
  const rawDayOfWeek = typeof record.dayOfWeek === 'number' ? Math.trunc(record.dayOfWeek) : null;
  const dayOfWeek = cadence === 'weekly' && rawDayOfWeek !== null
    ? Math.min(6, Math.max(0, rawDayOfWeek))
    : null;
  const rawHour = typeof record.hour === 'number' ? Math.trunc(record.hour) : 8;
  const hour = Math.min(23, Math.max(0, rawHour));
  const rawMaxFollowups = typeof record.maxFollowups === 'number' ? Math.trunc(record.maxFollowups) : 4;
  const maxFollowups = Math.max(0, rawMaxFollowups);
  const description = typeof record.description === 'string' && record.description.trim().length > 0
    ? record.description.trim()
    : `Run a bounded self-audit for ${projectId} and identify the next safe improvements.`;

  return {
    enabled: record.enabled === true,
    cadence,
    dayOfWeek,
    hour,
    workflows: workflows.length > 0 ? workflows : DEFAULT_SELF_AUDIT_WORKFLOWS,
    maxFollowups,
    description,
  };
}

function normalizeInnovationRadar(raw: unknown, projectId: string): ProjectPolicy['innovationRadar'] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const cadence = record.cadence === 'daily' ? 'daily' : 'weekly';
  const rawDayOfWeek = typeof record.dayOfWeek === 'number' ? Math.trunc(record.dayOfWeek) : 3;
  const dayOfWeek = cadence === 'weekly'
    ? Math.min(6, Math.max(0, rawDayOfWeek))
    : null;
  const rawHour = typeof record.hour === 'number' ? Math.trunc(record.hour) : 9;
  const hour = Math.min(23, Math.max(0, rawHour));
  const focusAreas = Array.isArray(record.focusAreas)
    ? record.focusAreas.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const rawMaxOpportunities = typeof record.maxOpportunities === 'number'
    ? Math.trunc(record.maxOpportunities)
    : 3;
  const maxOpportunities = Math.min(3, Math.max(1, rawMaxOpportunities));

  return {
    enabled: record.enabled === true,
    cadence,
    dayOfWeek,
    hour,
    agent: typeof record.agent === 'string' && record.agent.trim().length > 0
      ? record.agent.trim()
      : 'competitive-intel',
    shadow: record.shadow !== false,
    focusAreas,
    maxOpportunities,
    description: typeof record.description === 'string' && record.description.trim().length > 0
      ? record.description.trim()
      : `Run an innovation radar pass for ${projectId} and surface only the freshest project-relevant opportunities.`,
  };
}

function configPath(projectId: string): string {
  return path.join(getProjectsDir(), projectId, 'config.json');
}

export function normalizePolicyCommand(command: string | null | undefined): string | null {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/(?<!corepack\s)\bpnpm\b/gi, 'corepack pnpm');
}

function normalizePolicyCommands(raw: unknown): ProjectPolicy['commands'] {
  if (!raw || typeof raw !== 'object') return {};
  const commands = raw as Record<string, unknown>;
  return {
    install: normalizePolicyCommand(typeof commands.install === 'string' ? commands.install : null) ?? undefined,
    lint: normalizePolicyCommand(typeof commands.lint === 'string' ? commands.lint : null) ?? undefined,
    test: normalizePolicyCommand(typeof commands.test === 'string' ? commands.test : null) ?? undefined,
    build: normalizePolicyCommand(typeof commands.build === 'string' ? commands.build : null) ?? undefined,
    deploy: normalizePolicyCommand(typeof commands.deploy === 'string' ? commands.deploy : null) ?? undefined,
  };
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

  const commands = normalizePolicyCommands(raw.commands);

  const repoPath = typeof raw.repoPath === 'string'
    ? raw.repoPath
    : typeof raw.projectPath === 'string'
      ? raw.projectPath
      : null;

  const deployTargets = normalizeDeployTargets(raw.deployTargets);
  const workspaceMode = normalizeWorkspaceMode(raw.workspaceMode, autonomyMode);
  const launchGuards = normalizeLaunchGuards(raw.launchGuards, autonomyMode);
  const toolProviders = raw.toolProviders && typeof raw.toolProviders === 'object'
    ? raw.toolProviders as Record<string, unknown>
    : {};
  const qualityStandards = Array.isArray(raw.qualityStandards)
    ? raw.qualityStandards.filter((item): item is string => typeof item === 'string')
    : [];
  const riskOverrides = normalizeRiskOverrides(raw.riskOverrides);
  const autonomySurfaces = normalizeAutonomySurfaces(raw.autonomySurfaces);

  return {
    projectId,
    repoPath,
    defaultBranch: typeof raw.defaultBranch === 'string' ? raw.defaultBranch : 'main',
    qualityStandards,
    riskOverrides,
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
    workspaceMode,
    launchGuards,
    autonomySurfaces,
    selfAudit: normalizeSelfAudit(raw.selfAudit, projectId),
    innovationRadar: normalizeInnovationRadar(raw.innovationRadar, projectId),
    toolProviders: {
      minimax: normalizeMiniMax(toolProviders.minimax),
    },
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
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadProjectPolicy(entry.name));
}

export function isActionBlocked(policy: ProjectPolicy, action: ProjectAction): boolean {
  return policy.blockedActions.includes(action);
}

export function isActionAllowed(policy: ProjectPolicy, action: ProjectAction): boolean {
  return !policy.blockedActions.includes(action) && policy.allowedActions.includes(action);
}

function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped.includes('\\ ')) {
    return new RegExp(escaped, 'i').test(text);
  }
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function matchAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => matchesKeyword(text, keyword));
}

export function resolveTaskSafetyEnvelope(
  policy: ProjectPolicy,
  description: string,
  workflowKind: WorkflowKind,
): {
  blockedReason: string | null;
  forcedLane: RiskLane | null;
  safeSurfaceMatch: boolean;
  protectedSurfaceMatch: boolean;
} {
  const text = description.toLowerCase();
  const protectedKeywords = [...new Set([
    ...policy.riskOverrides.keywords,
    ...policy.autonomySurfaces.protectedTaskKeywords,
  ])];
  const protectedSurfaceMatch = matchAnyKeyword(text, protectedKeywords);
  const safeSurfaceMatch = matchAnyKeyword(text, policy.autonomySurfaces.safeTaskKeywords);
  const readOnlyMedicalReview = policy.autonomySurfaces.readOnlyCanary
    && policy.autonomySurfaces.readOnlyWorkflows.includes(workflowKind);
  const forcedLane = protectedSurfaceMatch
    ? (readOnlyMedicalReview ? 'MEDIUM' : 'HIGH')
    : policy.riskOverrides.defaultLane;

  let blockedReason: string | null = null;
  if (policy.qualityStandards.includes('MEDICAL')) {
    if ((workflowKind === 'implement' || workflowKind === 'ship') && protectedSurfaceMatch) {
      blockedReason = 'MEDICAL SAFETY GATE: protected Synapse surfaces stay review/validate only until explicitly promoted.';
    } else if (
      workflowKind === 'implement'
      && policy.autonomySurfaces.safeTaskKeywords.length > 0
      && !safeSurfaceMatch
    ) {
      blockedReason = 'MEDICAL SAFETY GATE: autonomous implementation is limited to explicitly safe Synapse surfaces.';
    } else if (
      workflowKind === 'ship'
      && !policy.autonomySurfaces.safeImplementationWorkflows.includes('ship')
    ) {
      blockedReason = 'MEDICAL SAFETY GATE: deployment remains blocked for Synapse in the current autonomy lane.';
    }
  }

  return {
    blockedReason,
    forcedLane,
    safeSurfaceMatch,
    protectedSurfaceMatch,
  };
}

export function resolveEffectiveRiskLane(
  policy: ProjectPolicy,
  description: string,
  workflowKind: WorkflowKind,
  currentLane: RiskLane,
): RiskLane {
  const envelope = resolveTaskSafetyEnvelope(policy, description, workflowKind);
  return envelope.forcedLane ?? currentLane;
}

export function requiresHumanReviewGate(
  policy: ProjectPolicy,
  description: string,
  workflowKind: WorkflowKind,
  currentLane: RiskLane,
): boolean {
  return resolveEffectiveRiskLane(policy, description, workflowKind, currentLane) === 'HIGH';
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
  const mergedLaunchGuards = {
    ...policy.launchGuards,
    ...(config.launchGuards ?? {}),
  };
  const mergedMiniMax = {
    ...policy.toolProviders.minimax,
    ...(config.toolProviders?.minimax ?? {}),
  };
  const mergedSelfAudit = {
    ...policy.selfAudit,
    ...(config.selfAudit ?? {}),
    workflows: config.selfAudit?.workflows ?? policy.selfAudit.workflows,
    dayOfWeek: config.selfAudit?.dayOfWeek ?? policy.selfAudit.dayOfWeek ?? undefined,
  };
  const mergedInnovationRadar = {
    ...policy.innovationRadar,
    ...(config.innovationRadar ?? {}),
    dayOfWeek: config.innovationRadar?.dayOfWeek ?? policy.innovationRadar.dayOfWeek ?? undefined,
    focusAreas: config.innovationRadar?.focusAreas ?? policy.innovationRadar.focusAreas,
  };

  return {
    ...config,
    repoPath: config.repoPath ?? policy.repoPath ?? undefined,
    defaultBranch: config.defaultBranch ?? policy.defaultBranch,
    qualityStandards: config.qualityStandards ?? policy.qualityStandards,
    riskOverrides: {
      ...policy.riskOverrides,
      ...(config.riskOverrides ?? {}),
      keywords: config.riskOverrides?.keywords ?? policy.riskOverrides.keywords,
      defaultLane: config.riskOverrides?.defaultLane ?? policy.riskOverrides.defaultLane ?? undefined,
      note: config.riskOverrides?.note ?? policy.riskOverrides.note ?? undefined,
    },
    commands: {
      ...policy.commands,
      install: normalizePolicyCommand(config.commands?.install ?? policy.commands.install) ?? undefined,
      lint: normalizePolicyCommand(config.commands?.lint ?? policy.commands.lint) ?? undefined,
      test: normalizePolicyCommand(config.commands?.test ?? policy.commands.test) ?? undefined,
      build: normalizePolicyCommand(config.commands?.build ?? policy.commands.build) ?? undefined,
      deploy: normalizePolicyCommand(config.commands?.deploy ?? policy.commands.deploy) ?? undefined,
    },
    deployTargets: config.deployTargets ?? policy.deployTargets,
    allowedActions: config.allowedActions ?? policy.allowedActions,
    blockedActions: config.blockedActions ?? policy.blockedActions,
    approvalThresholds: config.approvalThresholds ?? policy.approvalThresholds,
    envRequirements: config.envRequirements ?? policy.envRequirements,
    workspaceMode: config.workspaceMode ?? policy.workspaceMode,
    launchGuards: mergedLaunchGuards,
    autonomySurfaces: {
      ...policy.autonomySurfaces,
      ...(config.autonomySurfaces ?? {}),
      safeTaskKeywords: config.autonomySurfaces?.safeTaskKeywords ?? policy.autonomySurfaces.safeTaskKeywords,
      protectedTaskKeywords: config.autonomySurfaces?.protectedTaskKeywords ?? policy.autonomySurfaces.protectedTaskKeywords,
      readOnlyWorkflows: config.autonomySurfaces?.readOnlyWorkflows ?? policy.autonomySurfaces.readOnlyWorkflows,
      safeImplementationWorkflows: config.autonomySurfaces?.safeImplementationWorkflows ?? policy.autonomySurfaces.safeImplementationWorkflows,
      note: config.autonomySurfaces?.note ?? policy.autonomySurfaces.note ?? undefined,
    },
    selfAudit: mergedSelfAudit,
    innovationRadar: mergedInnovationRadar,
    toolProviders: {
      ...policy.toolProviders,
      ...(config.toolProviders ?? {}),
      minimax: mergedMiniMax,
    },
    budgetCaps: config.budgetCaps ?? {
      dailyUsd: policy.budgetCaps.dailyUsd ?? undefined,
      deployUsd: policy.budgetCaps.deployUsd ?? undefined,
      contactUsd: policy.budgetCaps.contactUsd ?? undefined,
      purchaseUsd: policy.budgetCaps.purchaseUsd ?? undefined,
    },
    autonomyMode: config.autonomyMode ?? policy.autonomyMode,
  };
}
