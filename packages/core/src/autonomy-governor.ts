import { getDb } from './task-queue.js';
import { getProjectCoreAgents } from './registry.js';
import { listProjectPolicies } from './project-policy.js';
import { AutonomyMode } from '../../shared/src/types.js';

export interface ProjectAutonomyHealth {
  projectId: string;
  autonomyMode: AutonomyMode;
  requiredConsecutiveRuns: number;
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
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(projectId) as Array<{ status: string; provider_failure_kind: string }>;

  let streak = 0;
  for (const row of rows) {
    if (row.status !== 'completed' || (row.provider_failure_kind && row.provider_failure_kind !== 'none')) {
      break;
    }
    streak++;
  }
  return streak;
}

export function getProjectAutonomyHealth(projectId: string): ProjectAutonomyHealth {
  const policy = listProjectPolicies().find((entry) => entry.projectId === projectId);
  const autonomyMode = policy?.autonomyMode ?? 'stabilization';
  const requiredConsecutiveRuns = 20;

  const counts = getDb().prepare(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
      SUM(CASE WHEN status IN ('pending', 'running', 'paused', 'retry_scheduled') THEN 1 ELSE 0 END) AS active_runs,
      SUM(CASE WHEN provider_failure_kind IS NOT NULL AND provider_failure_kind != 'none' THEN 1 ELSE 0 END) AS provider_failures
    FROM (
      SELECT *
      FROM run_sessions
      WHERE project_id = ?
      ORDER BY updated_at DESC
      LIMIT 50
    )
  `).get(projectId) as {
    completed_runs: number | null;
    active_runs: number | null;
    provider_failures: number | null;
  } | undefined;

  const pendingInterrupts = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM interrupts i
    JOIN run_sessions r ON r.id = i.run_id
    WHERE r.project_id = ? AND i.status = 'pending'
  `).get(projectId) as { count: number } | undefined;

  const pendingApprovals = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM approvals a
    JOIN run_sessions r ON r.id = a.run_id
    WHERE r.project_id = ? AND a.status = 'pending'
  `).get(projectId) as { count: number } | undefined;

  const healthyRuns = consecutiveHealthyRuns(projectId);
  const blockers: string[] = [];
  if (healthyRuns < requiredConsecutiveRuns) {
    blockers.push(`Needs ${requiredConsecutiveRuns - healthyRuns} more consecutive healthy runs`);
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

  return {
    projectId,
    autonomyMode,
    requiredConsecutiveRuns,
    consecutiveHealthyRuns: healthyRuns,
    recentCompletedRuns: counts?.completed_runs ?? 0,
    recentProviderFailures: counts?.provider_failures ?? 0,
    activeRuns: counts?.active_runs ?? 0,
    pendingInterrupts: pendingInterrupts?.count ?? 0,
    pendingApprovals: pendingApprovals?.count ?? 0,
    rolloutReady: blockers.length === 0,
    blockers,
    coreAgents: getProjectCoreAgents(projectId),
  };
}

export function listProjectAutonomyHealth(): ProjectAutonomyHealth[] {
  return listProjectPolicies().map((policy) => getProjectAutonomyHealth(policy.projectId));
}
