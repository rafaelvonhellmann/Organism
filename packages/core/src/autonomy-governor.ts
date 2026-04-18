import { getDb } from './task-queue.js';
import { getProjectCoreAgents } from './registry.js';
import { listProjectPolicies } from './project-policy.js';
import { AutonomyMode } from '../../shared/src/types.js';

const ACTIVE_RUN_STALE_MS = 20 * 60 * 1000;
const FINAL_GRADUATION_RUNS = 3;
// Decay window: provider failures older than this stop counting as "recent".
// Without this, one old `fetch failed` freezes consecutiveHealthyRuns at 0 forever,
// because the streak resets whenever the 50-goal lookback has ANY failure in it.
const PROVIDER_FAILURE_DECAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ROLLOUT_STAGES = [
  { stage: 'bounded', label: 'bounded autonomy', threshold: 1 },
  { stage: 'deploy_ready', label: 'low-risk deploys', threshold: 2 },
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

interface RecentGoalRow {
  id: string;
  project_id: string;
  status: string;
  workflow_kind: string;
  latest_run_id: string | null;
  latest_run_status: string | null;
  latest_run_provider_failure_kind: string | null;
  updated_at: number;
}

interface GoalTaskSummary {
  activeTasks: number;
  activeProviderFailures: number;
}

function canonicalRecentGoals(projectId: string): RecentGoalRow[] {
  return getDb().prepare(`
    SELECT
      g.id,
      g.project_id,
      g.status,
      g.workflow_kind,
      g.latest_run_id,
      r.status AS latest_run_status,
      r.provider_failure_kind AS latest_run_provider_failure_kind,
      g.updated_at
    FROM goals g
    LEFT JOIN run_sessions r ON r.id = g.latest_run_id
    WHERE g.project_id = ?
      AND NOT (g.status IN ('pending', 'running', 'paused', 'retry_scheduled') AND g.updated_at < ?)
    ORDER BY g.updated_at DESC
    LIMIT 50
  `).all(projectId, Date.now() - ACTIVE_RUN_STALE_MS) as unknown as RecentGoalRow[];
}

function summarizeGoalTasks(goalId: string): GoalTaskSummary {
  const summary = getDb().prepare(`
    SELECT
      COUNT(CASE WHEN status IN ('pending', 'in_progress', 'paused', 'retry_scheduled', 'awaiting_review') THEN 1 END) AS active_tasks,
      COUNT(
        CASE
          WHEN status IN ('pending', 'in_progress', 'paused', 'retry_scheduled', 'awaiting_review')
            AND provider_failure_kind IS NOT NULL
            AND provider_failure_kind != 'none'
          THEN 1
        END
      ) AS active_provider_failures
    FROM tasks
    WHERE goal_id = ?
  `).get(goalId) as { active_tasks: number | null; active_provider_failures: number | null } | undefined;

  return {
    activeTasks: summary?.active_tasks ?? 0,
    activeProviderFailures: summary?.active_provider_failures ?? 0,
  };
}

function hasOperationalFailure(error: string | null): boolean {
  if (!error) return false;
  return /(fetch failed|transport_error|network error|timed out|timeout|manual pause|retry limit reached|credit balance is too low|rate limit|quota|billing|sql write operations are forbidden|writes are blocked|upgrade your plan|not recognized|corepack|pnpm|worktree|filename too long|path too long|permission denied)/i
    .test(error);
}

function latestRelatedTask(goalId: string): RelatedTaskRow | null {
  const task = getDb().prepare(`
    SELECT status, retry_class, provider_failure_kind, error
    FROM tasks
    WHERE goal_id = ?
    ORDER BY COALESCE(completed_at, started_at, created_at) DESC
    LIMIT 1
  `).get(goalId) as RelatedTaskRow | undefined;

  return task ?? null;
}

function isHealthyGoal(row: RecentGoalRow): boolean {
  if (row.status !== 'completed') return false;
  if (!row.latest_run_id) return false;
  if (row.latest_run_status !== 'completed') return false;
  if (row.latest_run_provider_failure_kind && row.latest_run_provider_failure_kind !== 'none') return false;

  const taskSummary = summarizeGoalTasks(row.id);
  if (taskSummary.activeTasks > 0) return false;

  const relatedTask = latestRelatedTask(row.id);
  if (!relatedTask) return true;
  if (relatedTask.status === 'awaiting_review') return false;
  if (
    relatedTask.status !== 'completed'
    && ['paused', 'retry_scheduled', 'in_progress', 'pending'].includes(relatedTask.status)
  ) {
    return false;
  }
  if (
    relatedTask.status !== 'completed'
    && (
      (relatedTask.retry_class && relatedTask.retry_class !== 'none')
      || (relatedTask.provider_failure_kind && relatedTask.provider_failure_kind !== 'none')
      || hasOperationalFailure(relatedTask.error)
    )
  ) {
    return false;
  }
  return true;
}

function goalHasProviderFailure(row: RecentGoalRow): boolean {
  if (row.latest_run_provider_failure_kind && row.latest_run_provider_failure_kind !== 'none') return true;
  const taskSummary = summarizeGoalTasks(row.id);
  return taskSummary.activeProviderFailures > 0;
}

// A provider failure only counts if it happened within the decay window AND is not
// already covered by later successful recoveries. Old transient failures (e.g. an
// overnight `fetch failed` that recovered the next morning) should NOT permanently
// freeze the project at consecutiveHealthyRuns: 0.
function goalHasRecentUnrecoveredFailure(row: RecentGoalRow, now: number): boolean {
  if (!goalHasProviderFailure(row)) return false;
  // Too old — presumed resolved.
  if (now - row.updated_at > PROVIDER_FAILURE_DECAY_MS) return false;
  return true;
}

function consecutiveHealthyRuns(projectId: string): number {
  const rows = canonicalRecentGoals(projectId);
  const now = Date.now();

  let streak = 0;
  for (const row of rows) {
    // Goals outside the decay window are ignored — they cannot reset the streak
    // (one-week-old `fetch failed` should not keep the project stabilizing forever).
    if (now - row.updated_at > PROVIDER_FAILURE_DECAY_MS) {
      continue;
    }
    if (!isHealthyGoal(row)) {
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
  const recentGoals = canonicalRecentGoals(projectId);

  const activeCounts = getDb().prepare(`
    SELECT COUNT(*) AS active_runs
    FROM run_sessions
    WHERE project_id = ?
      AND status IN ('pending', 'running', 'paused', 'retry_scheduled')
      AND updated_at >= ?
      AND goal_id NOT LIKE 'goal-%'
  `).get(projectId, Date.now() - ACTIVE_RUN_STALE_MS) as { active_runs: number | null } | undefined;

  const coreAgents = getProjectCoreAgents(projectId);

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
  const now = Date.now();
  const recentCompletedRuns = recentGoals.filter((row) => row.status === 'completed').length;
  const recentProviderFailures = recentGoals.filter((row) => goalHasRecentUnrecoveredFailure(row, now)).length;
  const rolloutStage = resolveRolloutStage(healthyRuns);
  const nextStage = nextRolloutMilestone(healthyRuns);
  const blockers: string[] = [];
  if (nextStage) {
    blockers.push(`Needs ${nextStage.threshold - healthyRuns} more consecutive healthy goals for ${nextStage.label}`);
  }
  if (recentProviderFailures > 0) {
    blockers.push(`${recentProviderFailures} provider failure(s) within the last 7 days`);
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
