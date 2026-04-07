import { getDb } from './task-queue.js';

interface AgentSchedule {
  agent: string;
  lastReviewAt: number | null;
  nextReviewDays: number | null;
  dueAt: number | null;
  isDue: boolean;
}

/**
 * Check which agents are due for a review based on their self-scheduling.
 * Returns agents that should be included in the next review run.
 */
export function getAgentsDueForReview(projectId: string = 'synapse'): AgentSchedule[] {
  // Get the last completed task for each agent with its output.
  // SQLite picks the output from the row with MAX(completed_at) when using
  // bare columns alongside MAX — this is defined SQLite behaviour (not standard SQL).
  const rows = getDb().prepare(`
    SELECT t.agent, t.completed_at as last_review, t.output
    FROM tasks t
    INNER JOIN (
      SELECT agent, MAX(completed_at) as max_completed
      FROM tasks
      WHERE project_id = ? AND status = 'completed' AND output IS NOT NULL
      GROUP BY agent
    ) latest ON t.agent = latest.agent AND t.completed_at = latest.max_completed
    WHERE t.project_id = ? AND t.status = 'completed' AND t.output IS NOT NULL
  `).all(projectId, projectId) as Array<{ agent: string; last_review: number; output: string }>;

  const now = Date.now();
  const schedules: AgentSchedule[] = [];

  for (const row of rows) {
    let nextDays: number | null = null;

    try {
      const output = JSON.parse(row.output);
      // Look for nextReviewDays in the output (agents include this)
      if (typeof output.nextReviewDays === 'number') {
        nextDays = output.nextReviewDays;
      } else if (typeof output === 'object') {
        // Search for it in nested output
        for (const val of Object.values(output)) {
          if (val && typeof val === 'object' && typeof (val as any).nextReviewDays === 'number') {
            nextDays = (val as any).nextReviewDays;
            break;
          }
        }
      }
    } catch { /* parse error — treat as due */ }

    const dueAt = nextDays != null ? row.last_review + (nextDays * 24 * 60 * 60 * 1000) : null;

    schedules.push({
      agent: row.agent,
      lastReviewAt: row.last_review,
      nextReviewDays: nextDays,
      dueAt,
      isDue: dueAt == null || now >= dueAt,
    });
  }

  return schedules;
}

/**
 * Filter an agent list to only those that are due.
 * Agents with no prior review are always included.
 */
export function filterDueAgents(agents: string[], projectId: string = 'synapse'): string[] {
  const schedules = getAgentsDueForReview(projectId);
  const scheduleMap = new Map(schedules.map(s => [s.agent, s]));

  return agents.filter(agent => {
    const schedule = scheduleMap.get(agent);
    // No prior review = always include
    if (!schedule) return true;
    return schedule.isDue;
  });
}
