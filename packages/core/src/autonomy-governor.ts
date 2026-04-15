import { getDb } from './task-queue.js';
import { getProjectCoreAgents, getShadowRunCount, loadRegistry } from './registry.js';
import { listProjectPolicies } from './project-policy.js';
import { AutonomyMode } from '../../shared/src/types.js';

const ACTIVE_RUN_STALE_MS = 20 * 60 * 1000;
const FINAL_GRADUATION_RUNS = 20;
const ROLLOUT_STAGES = [
  { stage: 'bounded', label: 'bounded autonomy', threshold: 3 },
  { stage: 'deploy_ready', label: 'low-risk deploys', threshold: 5 },
  { stage: 'graduated', label: 'full graduation', threshold: FINAL_GRADUATION_RUNS },
] as const;

type RolloutStage = 'stabilizing' | (typeof ROLLOUT_STAGES)[number]['stage'];

export interface ProjectAutonomyHealth {
  projectId: string;
  autonomyMode: AutonomyMode;
  requiredConsecutiveRuns: number;
  rolloutStage: RolloutStage;
  nextRolloutStage: RolloutStage | null;
  nextRolloutThreshold: number | null;
  nextRolloutLabel: string | null;
  consecutiveHealthyRuns: number;
  recentCompletedRuns: number;
  recentProviderFailures: number;
  activeRuns: number;
  pendingInterrupts: number;
  pendingApprovals: number;
  rolloutReady: boolean;
  blockers: string[];
  coreAgents: string[];
}

interface RecentRunRow {
  id: string;
  goal_id: string | null;
  project_id: string;
  agent: string;
  status: string;
  provider_failure_kind: string | null;
  updated_at: number;
}

interface RelatedTaskRow {
  status: string;
  retry_class: string | null;
  provider_failure_kind: string | null;
  error: string | null;
}

function canonicalRecentRuns(projectId: string): RecentRunRow[] {
  const rows = getDb().prepare(`
    SELECT id, goal_id, project_id, agent, status, provider_failure_kind, updated_at
    FROM run_sessions
    WHERE project_id = ?
      AND NOT (goal_id LIKE 'goal-%' AND status IN ('pending', 'running', 'paused', 'retry_scheduled'))
      AND NOT (status IN ('pending', 'running', 'paused', 'retry_scheduled') AND updated_at < ?)
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(projectId, Date.now() - ACTIVE_RUN_STALE_MS) as unknown as RecentRunRow[];

  const seen = new Set<string>();
  const canonical: RecentRunRow[] = [];

  for (const row of rows) {
    const key = `${row.goal_id ?? row.id}:${row.agent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push(row);
  }

  return canonical;
}

function latestRelatedTask(row: RecentRunRow): RelatedTaskRow | null {
  if (!row.goal_id) return null;
  const task = getDb().prepare(`
    SELECT status, retry_class, provider_failure_kind, error
    FROM tasks
    WHERE project_id = ?
      AND goal_id = ?
      AND agent = ?
    ORDER BY COALESCE(completed_at, started_at, created_at) DESC
    LIMIT 1
  `).get(row.project_id, row.goal_id, row.agent) as RelatedTaskRow | undefined;

  return task ?? null;
}

function hasOperationalFailure(error: string | null): boolean {
  if (!error) return false;
  return /(fetch failed|transport_error|network error|timed out|timeout|manual pause|retry limit reached|credit balance is too low|rate limit|quota|billing|sql write operations are forbidden|writes are blocked|upgrade your plan|not recognized|corepack|pnpm|worktree|filename too long|path too long|permission denied)/i
    .test(error);
}

function isHealthyRun(row: RecentRunRow): boolean {
  if (row.status !== 'completed') return false;
  if (row.provider_failure_kind && row.provider_failure_kind !== 'none') return false;

  const relatedTask = latestRelatedTask(row);
  if (!relatedTask) return true;
  if (relatedTask.status !== 'completed') return false;
  if (relatedTask.retry_class && relatedTask.retry_class !== 'none') return false;
  if (relatedTask.provider_failure_kind && relatedTask.provider_failure_kind !== 'none') return false;
  if (hasOperationalFailure(relatedTask.error)) return false;
  return true;
}

function consecutiveHealthyRuns(projectId: string): number {
  const rows = canonicalRecentRuns(projectId);

  let streak = 0;
  for (const row of rows) {
    if (!isHealthyRun(row)) {
      break;
    }
    streak++;
  }
  return streak;
}

function resolveRolloutStage(healthyRuns: number): RolloutStage {
  let stage: RolloutStage = 'stabilizing';
  for (const milestone of ROLLOUT_STAGES) {
    if (healthyRuns >= milestone.threshold) {
      stage = milestone.stage;
    }
  }
  return stage;
}

function nextRolloutMilestone(healthyRuns: number) {
  return ROLLOUT_STAGES.find((milestone) => healthyRuns < milestone.threshold) ?? null;
}

export function getProjectAutonomyHealth(projectId: string): ProjectAutonomyHealth {
  const policy = listProjectPolicies().find((entry) => entry.projectId === projectId);
  const autonomyMode = policy?.autonomyMode ?? 'stabilization';
  const requiredConsecutiveRuns = FINAL_GRADUATION_RUNS;
  const recentRuns = canonicalRecentRuns(projectId);

  const activeCounts = getDb().prepare(`
    SELECT COUNT(*) AS active_runs
    FROM run_sessions
    WHERE project_id = ?
      AND status IN ('pending', 'running', 'paused', 'retry_scheduled')
      AND updated_at >= ?
      AND goal_id NOT LIKE 'goal-%'
  `).get(projectId, Date.now() - ACTIVE_RUN_STALE_MS) as { active_runs: number | null } | undefined;

  const coreAgents = getProjectCoreAgents(projectId);
  const registry = loadRegistry();
  const coreShadowGaps = coreAgents.filter((agent) => {
    const capability = registry.find((entry) => entry.owner === agent);
    return capability?.status === 'active' && getShadowRunCount(agent) < 10;
  });

  const pendingInterrupts = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM interrupts i
    JOIN run_sessions r ON r.id = i.run_id
    WHERE r.project_id = ?
      AND i.status = 'pending'
      AND r.status != 'completed'
      AND NOT (i.type = 'approval' AND i.summary LIKE 'Deploy is still gated%')
  `).get(projectId) as { count: number } | undefined;

  const pendingApprovals = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM approvals a
    JOIN run_sessions r ON r.id = a.run_id
    WHERE r.project_id = ?
      AND a.status = 'pending'
      AND r.status != 'completed'
      AND a.action != 'deploy'
  `).get(projectId) as { count: number } | undefined;

  const healthyRuns = consecutiveHealthyRuns(projectId);
  const recentCompletedRuns = recentRuns.filter((row) => row.status === 'completed').length;
  const recentProviderFailures = recentRuns.filter((row) =>
    !!row.provider_failure_kind && row.provider_failure_kind !== 'none',
  ).length;
  const rolloutStage = resolveRolloutStage(healthyRuns);
  const nextStage = nextRolloutMilestone(healthyRuns);
  const blockers: string[] = [];
  if (nextStage) {
    blockers.push(`Needs ${nextStage.threshold - healthyRuns} more consecutive healthy runs for ${nextStage.label}`);
  }
  if (recentProviderFailures > 0) {
    blockers.push('Recent provider failures still present in the last 50 runs');
  }
  if ((pendingInterrupts?.count ?? 0) > 0) {
    blockers.push('Pending interrupts need resolution');
  }
  if ((pendingApprovals?.count ?? 0) > 0) {
    blockers.push('Pending approvals still exist');
  }
  if (coreShadowGaps.length > 0) {
    blockers.push(`Core roster has ${coreShadowGaps.length} active agent(s) without 10 shadow runs recorded`);
  }

  return {
    projectId,
    autonomyMode,
    requiredConsecutiveRuns,
    rolloutStage,
    nextRolloutStage: nextStage?.stage ?? null,
    nextRolloutThreshold: nextStage?.threshold ?? null,
    nextRolloutLabel: nextStage?.label ?? null,
    consecutiveHealthyRuns: healthyRuns,
    recentCompletedRuns,
    recentProviderFailures,
    activeRuns: activeCounts?.active_runs ?? 0,
    pendingInterrupts: pendingInterrupts?.count ?? 0,
    pendingApprovals: pendingApprovals?.count ?? 0,
    rolloutReady: blockers.length === 0,
    blockers,
    coreAgents,
  };
}

export function listProjectAutonomyHealth(): ProjectAutonomyHealth[] {
  return listProjectPolicies().map((policy) => getProjectAutonomyHealth(policy.projectId));
}
