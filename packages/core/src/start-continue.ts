import { getDb } from './task-queue.js';
import { getProjectLaunchReadiness } from './project-readiness.js';
import { getProjectAutonomyHealth } from './autonomy-governor.js';

export type StartDecisionMode = 'continue' | 'review' | 'implement' | 'validate';

export interface StartDecision {
  projectId: string;
  mode: StartDecisionMode;
  workflowKind: 'review' | 'implement' | 'validate';
  label: string;
  summary: string;
  reason: string;
  command: string | null;
  state: {
    activeTasks: number;
    activeRuns: number;
    blockedTasks: number;
    awaitingReview: number;
    latestCompletedWorkflow: string | null;
    initialWorkflowGuardActive: boolean;
  };
}

function countTasks(projectId: string, statuses: string[], workflows?: string[]): number {
  const db = getDb();
  const statusPlaceholders = statuses.map(() => '?').join(', ');
  const workflowClause = workflows && workflows.length > 0
    ? `AND workflow_kind IN (${workflows.map(() => '?').join(', ')})`
    : '';

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks
    WHERE project_id = ?
      AND status IN (${statusPlaceholders})
      ${workflowClause}
  `).get(projectId, ...statuses, ...(workflows ?? [])) as { count?: number | null } | undefined;

  return Number(row?.count ?? 0);
}

function countRuns(projectId: string, statuses: string[]): number {
  const db = getDb();
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM run_sessions
    WHERE project_id = ?
      AND status IN (${placeholders})
  `).get(projectId, ...statuses) as { count?: number | null } | undefined;
  return Number(row?.count ?? 0);
}

function getLatestCompletedWorkflow(projectId: string): string | null {
  const row = getDb().prepare(`
    SELECT workflow_kind
    FROM goals
    WHERE project_id = ?
      AND status = 'completed'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(projectId) as { workflow_kind?: string | null } | undefined;

  return row?.workflow_kind ?? null;
}

export function decideProjectStart(projectId: string): StartDecision {
  const readiness = getProjectLaunchReadiness(projectId);
  const autonomy = getProjectAutonomyHealth(projectId);

  const activeTasks = countTasks(projectId, ['pending', 'in_progress']);
  const activeRuns = countRuns(projectId, ['pending', 'running']);
  const retryReviewTasks = countTasks(projectId, ['retry_scheduled'], ['review', 'validate']);
  const pausedReviewTasks = countTasks(projectId, ['paused'], ['review', 'validate']);
  const awaitingReview = countTasks(projectId, ['awaiting_review']);
  const blockedTasks = retryReviewTasks + pausedReviewTasks;
  const latestCompletedWorkflow = getLatestCompletedWorkflow(projectId);

  if (activeTasks > 0 || activeRuns > 0) {
    return {
      projectId,
      mode: 'continue',
      workflowKind: 'review',
      label: 'Continue current work',
      summary: 'Organism already has live work for this project, so the safest next move is to continue that thread.',
      reason: `There ${activeTasks + activeRuns === 1 ? 'is' : 'are'} ${activeTasks} active task${activeTasks === 1 ? '' : 's'} and ${activeRuns} active run${activeRuns === 1 ? '' : 's'} for ${projectId}.`,
      command: null,
      state: {
        activeTasks,
        activeRuns,
        blockedTasks,
        awaitingReview,
        latestCompletedWorkflow,
        initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
      },
    };
  }

  if (awaitingReview > 0) {
    return {
      projectId,
      mode: 'validate',
      workflowKind: 'validate',
      label: 'Validate current state',
      summary: 'Completed work is waiting for review, so the next step is to validate and close the loop cleanly.',
      reason: `${awaitingReview} task${awaitingReview === 1 ? '' : 's'} ${awaitingReview === 1 ? 'is' : 'are'} waiting in the review lane.`,
      command: `validate ${projectId} current state`,
      state: {
        activeTasks,
        activeRuns,
        blockedTasks,
        awaitingReview,
        latestCompletedWorkflow,
        initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
      },
    };
  }

  if (blockedTasks > 0) {
    return {
      projectId,
      mode: 'review',
      workflowKind: 'review',
      label: 'Refresh project review',
      summary: 'The review lane has retry or pause debt, so the next safest move is a fresh project review that can reroute the work cleanly.',
      reason: `${blockedTasks} review task${blockedTasks === 1 ? '' : 's'} ${blockedTasks === 1 ? 'is' : 'are'} paused or waiting to retry.`,
      command: 'review project',
      state: {
        activeTasks,
        activeRuns,
        blockedTasks,
        awaitingReview,
        latestCompletedWorkflow,
        initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
      },
    };
  }

  if (readiness.initialWorkflowGuardActive || autonomy.recentCompletedRuns === 0) {
    return {
      projectId,
      mode: 'review',
      workflowKind: 'review',
      label: 'Start safe review',
      summary: 'This project is still early in its autonomy lane, so the next step should stay inside review-first safety rails.',
      reason: readiness.initialWorkflowGuardActive
        ? `The early launch guard still allows only ${readiness.initialAllowedWorkflows.join(', ')}.`
        : 'No completed goals exist yet for this project.',
      command: 'review project',
      state: {
        activeTasks,
        activeRuns,
        blockedTasks,
        awaitingReview,
        latestCompletedWorkflow,
        initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
      },
    };
  }

  if (latestCompletedWorkflow === 'implement' || latestCompletedWorkflow === 'recover') {
    return {
      projectId,
      mode: 'validate',
      workflowKind: 'validate',
      label: 'Validate latest implementation',
      summary: 'The last completed goal changed the project, so the next step should verify it before widening scope again.',
      reason: `The latest completed goal ended in ${latestCompletedWorkflow}.`,
      command: `validate ${projectId} current state`,
      state: {
        activeTasks,
        activeRuns,
        blockedTasks,
        awaitingReview,
        latestCompletedWorkflow,
        initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
      },
    };
  }

  if (latestCompletedWorkflow === 'review' || latestCompletedWorkflow === 'plan' || latestCompletedWorkflow === 'validate') {
    return {
      projectId,
      mode: 'implement',
      workflowKind: 'implement',
      label: 'Implement next bounded task',
      summary: 'The project already has fresh review or validation context, so the next step is one bounded useful implementation.',
      reason: `The latest completed goal ended in ${latestCompletedWorkflow}.`,
      command: `implement the next safest useful task for ${projectId}`,
      state: {
        activeTasks,
        activeRuns,
        blockedTasks,
        awaitingReview,
        latestCompletedWorkflow,
        initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
      },
    };
  }

  return {
    projectId,
    mode: 'review',
    workflowKind: 'review',
    label: 'Review project',
    summary: 'A fresh project review is the safest default when no stronger continuation signal exists.',
    reason: 'No stronger continuation signal was found in the latest project state.',
    command: 'review project',
    state: {
      activeTasks,
      activeRuns,
      blockedTasks,
      awaitingReview,
      latestCompletedWorkflow,
      initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
    },
  };
}
