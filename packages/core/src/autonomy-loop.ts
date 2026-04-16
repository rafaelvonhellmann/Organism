import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './task-queue.js';
import { listProjectPolicies } from './project-policy.js';
import { writeAudit } from './audit.js';
import { ProjectPolicy } from '../../shared/src/types.js';

const PROJECTS_DIR = path.resolve(process.cwd(), 'knowledge', 'projects');
const REVIEW_AGENTS = ['quality-agent', 'quality-guardian', 'codex-review', 'grill-me', 'legal', 'security-audit'];
const AUTONOMY_CYCLE_COOLDOWN_MS = 60 * 1000;
const AUTONOMY_PERIOD_BUCKET_MINUTES = 1;
const STALE_ORPHAN_REVIEW_MS = 15 * 60 * 1000;

interface ProjectAutonomyMeta {
  projectId: string;
  qualityStandards: string[];
  tasklist: string | null;
}

interface ProjectAutonomyState {
  activeTasks: number;
  blockedTasks: number;
  activeGoals: number;
  pendingApprovals: number;
  pendingInterrupts: number;
  latestAutonomyCycleAt: number | null;
}

function loadProjectAutonomyMeta(projectId: string): ProjectAutonomyMeta {
  const configPath = path.join(PROJECTS_DIR, projectId, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { projectId, qualityStandards: [], tasklist: null };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      qualityStandards?: unknown;
      tasklist?: unknown;
    };
    return {
      projectId,
      qualityStandards: Array.isArray(raw.qualityStandards)
        ? raw.qualityStandards.filter((item): item is string => typeof item === 'string')
        : [],
      tasklist: typeof raw.tasklist === 'string' && raw.tasklist.trim().length > 0
        ? raw.tasklist
        : null,
    };
  } catch {
    return { projectId, qualityStandards: [], tasklist: null };
  }
}

function autonomyPeriodKey(now = Date.now()): string {
  const date = new Date(now);
  const hour = date.getUTCHours();
  const minuteBucket = Math.floor(date.getUTCMinutes() / AUTONOMY_PERIOD_BUCKET_MINUTES) * AUTONOMY_PERIOD_BUCKET_MINUTES;
  return `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:${String(minuteBucket).padStart(2, '0')}`;
}

function isSafeIdleAutonomyProject(policy: ProjectPolicy, meta: ProjectAutonomyMeta): boolean {
  if (!policy.repoPath) return false;
  if (policy.projectId === 'organism') return policy.selfAudit.enabled;
  if (meta.qualityStandards.includes('MEDICAL')) return policy.autonomySurfaces.readOnlyCanary;
  if (policy.launchGuards.initialAllowedWorkflows.length === 0) return false;
  return true;
}

export function cleanupStaleOrphanedReviewTasks(projectId: string, now = Date.now()): number {
  const result = getDb().prepare(`
    UPDATE tasks
    SET status = 'failed',
        completed_at = ?,
        error = CASE
          WHEN error IS NULL OR error = '' THEN 'Archived stale orphaned review blocker during idle autonomy recovery.'
          WHEN error LIKE '%Archived stale orphaned review blocker during idle autonomy recovery.%' THEN error
          ELSE error || ' | Archived stale orphaned review blocker during idle autonomy recovery.'
        END
    WHERE project_id = ?
      AND status = 'paused'
      AND goal_id IS NULL
      AND created_at < ?
      AND (
        agent IN (${REVIEW_AGENTS.map(() => '?').join(', ')})
        OR description LIKE 'Batch quality review:%'
      )
      AND (
        error LIKE 'Recovered orphaned task after daemon restart%'
        OR description LIKE 'Batch quality review:%'
      )
  `).run(
    now,
    projectId,
    now - STALE_ORPHAN_REVIEW_MS,
    ...REVIEW_AGENTS,
  );

  return Number(result.changes ?? 0);
}

export function cleanupStaleBlockedReviewGoals(projectId: string, now = Date.now()): { goals: number; runs: number } {
  const staleGoalIds = getDb().prepare(`
    SELECT g.id
    FROM goals g
    WHERE g.project_id = ?
      AND g.source_kind = 'monitor'
      AND g.workflow_kind IN ('review', 'validate')
      AND g.status IN ('paused', 'retry_scheduled')
      AND g.updated_at < ?
      AND NOT EXISTS (
        SELECT 1
        FROM tasks t
        WHERE t.goal_id = g.id
          AND t.status IN ('pending', 'in_progress', 'retry_scheduled', 'awaiting_review')
      )
  `).all(projectId, now - STALE_ORPHAN_REVIEW_MS) as Array<{ id: string }>;

  if (staleGoalIds.length === 0) {
    return { goals: 0, runs: 0 };
  }

  const goalIds = staleGoalIds.map((goal) => goal.id);
  const placeholders = goalIds.map(() => '?').join(', ');
  const db = getDb();
  const goalResult = db.prepare(`
    UPDATE goals
    SET status = 'failed', updated_at = ?
    WHERE id IN (${placeholders})
  `).run(now, ...goalIds);

  const runResult = db.prepare(`
    UPDATE run_sessions
    SET status = 'failed', updated_at = ?, completed_at = COALESCE(completed_at, ?)
    WHERE goal_id IN (${placeholders})
      AND status IN ('paused', 'retry_scheduled')
  `).run(now, now, ...goalIds);

  return {
    goals: Number(goalResult.changes ?? 0),
    runs: Number(runResult.changes ?? 0),
  };
}

function loadProjectAutonomyState(projectId: string): ProjectAutonomyState {
  const row = getDb().prepare(`
    SELECT
      COUNT(CASE WHEN status IN ('pending', 'in_progress', 'retry_scheduled', 'awaiting_review') THEN 1 END) as activeTasks,
      COUNT(CASE WHEN status = 'paused' AND goal_id IS NOT NULL THEN 1 END) as blockedTasks
    FROM tasks
    WHERE project_id = ?
  `).get(projectId) as { activeTasks?: number; blockedTasks?: number } | undefined;

  const goalsRow = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM goals
    WHERE project_id = ?
      AND status IN ('pending', 'running', 'retry_scheduled', 'paused')
  `).get(projectId) as { count?: number } | undefined;

  const approvalsRow = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM approvals a
    JOIN run_sessions r ON r.id = a.run_id
    WHERE r.project_id = ?
      AND a.status = 'pending'
  `).get(projectId) as { count?: number } | undefined;

  const interruptsRow = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM interrupts i
    JOIN run_sessions r ON r.id = i.run_id
    WHERE r.project_id = ?
      AND i.status = 'pending'
  `).get(projectId) as { count?: number } | undefined;

  const latestCycleRow = getDb().prepare(`
    SELECT MAX(updated_at) as updated_at
    FROM goals
    WHERE project_id = ?
      AND source_kind = 'system'
      AND workflow_kind = 'review'
      AND (
        title LIKE 'Autonomy cycle:%'
        OR title LIKE 'Scheduled self-audit%'
      )
  `).get(projectId) as { updated_at?: number | null } | undefined;

  return {
    activeTasks: Number(row?.activeTasks ?? 0),
    blockedTasks: Number(row?.blockedTasks ?? 0),
    activeGoals: Number(goalsRow?.count ?? 0),
    pendingApprovals: Number(approvalsRow?.count ?? 0),
    pendingInterrupts: Number(interruptsRow?.count ?? 0),
    latestAutonomyCycleAt: latestCycleRow?.updated_at ? Number(latestCycleRow.updated_at) : null,
  };
}

function shouldSeedIdleAutonomyCycle(state: ProjectAutonomyState, now = Date.now()): boolean {
  if (state.activeTasks > 0) return false;
  if (state.activeGoals > 0) return false;
  if (state.blockedTasks > 0) return false;
  if (state.pendingApprovals > 0) return false;
  if (state.pendingInterrupts > 0) return false;
  if (state.latestAutonomyCycleAt && now - state.latestAutonomyCycleAt < AUTONOMY_CYCLE_COOLDOWN_MS) {
    return false;
  }
  return true;
}

function buildAutonomySubmission(policy: ProjectPolicy, meta: ProjectAutonomyMeta, now = Date.now()) {
  const periodKey = autonomyPeriodKey(now);
  if (policy.projectId === 'organism') {
    return {
      title: `Self review: ${policy.projectId}`,
      description: policy.selfAudit.description,
      input: {
        projectId: policy.projectId,
        triggeredBy: 'autonomy-loop',
        scheduledReview: true,
        reviewScope: 'project',
        selfAudit: true,
        autonomyCycle: true,
        dedupeKey: `self-audit:${policy.projectId}:${periodKey}`,
        followupPolicy: {
          boundedLane: 'self_audit',
          allowedWorkflows: policy.selfAudit.workflows,
          maxFollowups: policy.selfAudit.maxFollowups,
          recursionDisabled: true,
        },
      },
      agent: 'quality-agent',
    };
  }

  if (meta.qualityStandards.includes('MEDICAL') && policy.autonomySurfaces.readOnlyCanary) {
    return {
      title: `Safe review: ${policy.projectId}`,
      description: `Safe project review for ${policy.projectId}: inspect the repo, tasklist, and safety boundaries, then identify the next safest review or validation work without touching grading, answer-key, rubric, benchmark, or deployment flows.`,
      input: {
        projectId: policy.projectId,
        triggeredBy: 'autonomy-loop',
        reviewScope: 'project',
        autonomyCycle: true,
        medicalReadOnlyReview: true,
        tasklistPath: meta.tasklist,
        dedupeKey: `medical-autonomy:${policy.projectId}:${periodKey}`,
        followupPolicy: {
          boundedLane: 'medical_read_only',
          allowedWorkflows: policy.autonomySurfaces.readOnlyWorkflows,
          maxFollowups: 2,
          recursionDisabled: true,
        },
      },
      agent: 'quality-agent',
    };
  }

  return {
    title: `Project review: ${policy.projectId}`,
    description: `Project review for ${policy.projectId}: inspect the repo, current tasklist, and known launch blockers, then choose the next safest useful low/medium improvements and seed bounded follow-up work.`,
    input: {
      projectId: policy.projectId,
      triggeredBy: 'autonomy-loop',
      reviewScope: 'project',
      autonomyCycle: true,
      tasklistPath: meta.tasklist,
      dedupeKey: `autonomy-cycle:${policy.projectId}:${periodKey}`,
    },
    agent: 'quality-agent',
  };
}

export async function seedIdleAutonomyCycles(now = Date.now()): Promise<number> {
  let created = 0;

  for (const policy of listProjectPolicies()) {
    const meta = loadProjectAutonomyMeta(policy.projectId);
    if (!isSafeIdleAutonomyProject(policy, meta)) continue;

    const archived = cleanupStaleOrphanedReviewTasks(policy.projectId, now);
    const reset = cleanupStaleBlockedReviewGoals(policy.projectId, now);
    if (archived > 0 || reset.goals > 0 || reset.runs > 0) {
      writeAudit({
        agent: 'autonomy-loop',
        taskId: `cleanup:${policy.projectId}`,
        action: 'task_completed',
        payload: { archived, reset, projectId: policy.projectId },
        outcome: 'success',
      });
    }

    const state = loadProjectAutonomyState(policy.projectId);
    if (!shouldSeedIdleAutonomyCycle(state, now)) continue;

    const submission = buildAutonomySubmission(policy, meta, now);
    try {
      const { submitTask } = await import('./orchestrator.js');
      await submitTask({
        title: submission.title,
        description: submission.description,
        input: submission.input,
        projectId: policy.projectId,
        workflowKind: 'review',
        sourceKind: 'system',
      }, {
        agent: submission.agent,
        projectId: policy.projectId,
        workflowKind: 'review',
        sourceKind: 'system',
      });
      created++;
      writeAudit({
        agent: 'autonomy-loop',
        taskId: `autonomy:${policy.projectId}`,
        action: 'task_created',
        payload: {
          projectId: policy.projectId,
          title: submission.title,
          selfAudit: policy.projectId === 'organism',
        },
        outcome: 'success',
      });
      console.log(`[autonomy-loop] Seeded ${submission.title}`);
    } catch (err) {
      console.warn(`[autonomy-loop] Skipped ${policy.projectId}: ${(err as Error).message}`);
    }
  }

  return created;
}

export function getIdleAutonomyProjects(): string[] {
  return listProjectPolicies()
    .filter((policy) => isSafeIdleAutonomyProject(policy, loadProjectAutonomyMeta(policy.projectId)))
    .map((policy) => policy.projectId);
}
