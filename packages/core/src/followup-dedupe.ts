import { getDb } from './task-queue.js';

const RECENT_FOLLOWUP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function normalizeFollowupDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function equivalentDescription(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 48 || right.length < 48) return false;
  return left.includes(right) || right.includes(left);
}

export function hasEquivalentFollowup(params: {
  goalId: string | null;
  projectId: string;
  agent: string;
  workflowKind: string;
  description: string;
  sourceTaskId: string;
}): boolean {
  const db = getDb();

  const sameSource = db.prepare(`
    SELECT id
    FROM tasks
    WHERE goal_id IS ? AND agent = ? AND workflow_kind = ? AND input LIKE ?
      AND status NOT IN ('failed', 'dead_letter', 'rolled_back')
    LIMIT 1
  `).get(
    params.goalId,
    params.agent,
    params.workflowKind,
    `%"sourceTaskId":"${params.sourceTaskId}"%`,
  ) as { id: string } | undefined;

  if (sameSource) return true;

  const normalizedDescription = normalizeFollowupDescription(params.description);
  const recentCandidates = db.prepare(`
    SELECT description
    FROM tasks
    WHERE id != ?
      AND project_id = ? AND agent = ? AND workflow_kind = ?
      AND created_at > ?
      AND status NOT IN ('failed', 'dead_letter', 'rolled_back', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 20
  `).all(
    params.sourceTaskId,
    params.projectId,
    params.agent,
    params.workflowKind,
    Date.now() - RECENT_FOLLOWUP_WINDOW_MS,
  ) as Array<{ description: string }>;

  return recentCandidates.some((candidate) =>
    equivalentDescription(normalizedDescription, normalizeFollowupDescription(candidate.description)),
  );
}
