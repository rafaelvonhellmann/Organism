import { createTask, getDb } from './task-queue.js';
import { writeAudit } from './audit.js';

interface GoalHealthRow {
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  goal_status: string;
  latest_run_id: string | null;
  run_agent: string | null;
  run_status: string | null;
  retry_class: string | null;
  retry_at: number | null;
  updated_at: number;
}

function loadRecoverableGoals(projectId?: string): GoalHealthRow[] {
  const where = projectId ? 'WHERE g.project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  return getDb().prepare(`
    SELECT
      g.id as goal_id,
      g.project_id,
      g.title,
      g.description,
      g.status as goal_status,
      g.latest_run_id,
      r.agent as run_agent,
      r.status as run_status,
      r.retry_class,
      r.retry_at,
      g.updated_at
    FROM goals g
    LEFT JOIN run_sessions r ON r.id = g.latest_run_id
    ${where}
    ORDER BY g.updated_at DESC
  `).all(...args) as unknown as GoalHealthRow[];
}

function hasPendingGoalTask(goalId: string): boolean {
  const row = getDb().prepare(`
    SELECT id FROM tasks
    WHERE goal_id = ? AND status IN ('pending', 'in_progress', 'retry_scheduled', 'awaiting_review')
    LIMIT 1
  `).get(goalId) as { id: string } | undefined;
  return !!row;
}

/**
 * Check active goals and create typed recovery tasks only when a real goal is stalled.
 * The monitor no longer generates generic weekly review work.
 */
export function checkProgressAndCreateTasks(): number {
  const now = Date.now();
  const staleThreshold = now - 30 * 60 * 1000;
  const recoverable = loadRecoverableGoals().filter((goal) => {
    if (goal.goal_status !== 'paused' && goal.goal_status !== 'retry_scheduled') return false;
    if (hasPendingGoalTask(goal.goal_id)) return false;
    if (goal.retry_at && goal.retry_at > now) return false;
    return goal.updated_at < staleThreshold;
  });

  let created = 0;

  for (const goal of recoverable) {
    const agent = goal.run_agent ?? 'ceo';
    try {
      const task = createTask({
        agent,
        lane: 'MEDIUM',
        description: `Recover goal: ${goal.title}`,
        input: {
          goalId: goal.goal_id,
          projectId: goal.project_id,
          triggeredBy: 'progress-monitor',
          recovery: true,
          previousRunId: goal.latest_run_id,
          previousStatus: goal.run_status,
          retryClass: goal.retry_class,
          originalDescription: goal.description,
        },
        projectId: goal.project_id,
        goalId: goal.goal_id,
        workflowKind: 'recover',
        sourceKind: 'monitor',
      });

      writeAudit({
        agent: 'progress-monitor',
        taskId: task.id,
        action: 'task_created',
        payload: {
          goalId: goal.goal_id,
          projectId: goal.project_id,
          previousRunId: goal.latest_run_id,
          retryClass: goal.retry_class,
        },
        outcome: 'success',
      });
      created++;
    } catch {
      // Duplicate recovery task or transient DB issue; skip and continue.
    }
  }

  if (created > 0) {
    console.log(`[progress-monitor] Created ${created} recovery task(s) for stalled goals`);
  }

  return created;
}

/**
 * Generate a goal-based progress report.
 */
export function getProgressReport(projectId: string = 'organism'): {
  onTrack: string[];
  stalled: string[];
  inProgress: string[];
} {
  const goals = loadRecoverableGoals(projectId);
  const onTrack: string[] = [];
  const stalled: string[] = [];
  const inProgress: string[] = [];

  for (const goal of goals) {
    const label = `${goal.run_agent ?? 'system'}: ${goal.title}`;
    if (goal.goal_status === 'completed') {
      onTrack.push(label);
    } else if (goal.goal_status === 'running' || goal.goal_status === 'pending') {
      inProgress.push(label);
    } else {
      stalled.push(`${label} (${goal.goal_status})`);
    }
  }

  return { onTrack, stalled, inProgress };
}
