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

function consecutiveHealthyRuns(projectId: string): number {
  const rows = getDb().prepare(`
    SELECT status, provider_failure_kind
    FROM run_sessions
    WHERE project_id = ?
      AND NOT (goal_id LIKE 'goal-%' AND status IN ('pending', 'running', 'paused', 'retry_scheduled'))
      AND NOT (status IN ('pending', 'running', 'paused', 'retry_scheduled') AND updated_at < ?)
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(projectId, Date.now() - ACTIVE_RUN_STALE_MS) as Array<{ status: string; provider_failure_kind: string }>;

  let streak = 0;
  for (const row of rows) {
    if (row.status !== 'completed' || (row.provider_failure_kind && row.provider_failure_kind !== 'none')) {
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

  const counts = getDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
      SUM(CASE WHEN status IN ('pending', 'running', 'paused', 'retry_scheduled') AND updated_at >= ? AND goal_id NOT LIKE 'goal-%' THEN 1 ELSE 0 END) AS active_runs,
      SUM(CASE WHEN provider_failure_kind IS NOT NULL AND provider_failure_kind != 'none' AND goal_id NOT LIKE 'goal-%' THEN 1 ELSE 0 END) AS provider_failures
    FROM (
      SELECT *
      FROM run_sessions
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT 50
    )
  `).get(Date.now() - ACTIVE_RUN_STALE_MS, projectId) as {
    completed_runs: number | null;
    active_runs: number | null;
    provider_failures: number | null;
  } | undefined;

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
  const rolloutStage = resolveRolloutStage(healthyRuns);
  const nextStage = nextRolloutMilestone(healthyRuns);
  const blockers: string[] = [];
  if (nextStage) {
    blockers.push(`Needs ${nextStage.threshold - healthyRuns} more consecutive healthy runs for ${nextStage.label}`);
  }
  if ((counts?.provider_failures ?? 0) > 0) {
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
    recentCompletedRuns: counts?.completed_runs ?? 0,
    recentProviderFailures: counts?.provider_failures ?? 0,
    activeRuns: counts?.active_runs ?? 0,
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
