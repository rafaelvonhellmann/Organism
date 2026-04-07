import * as crypto from 'crypto';
import { getDb } from './task-queue.js';
import { writeAudit } from './audit.js';

interface ActionableItem {
  agent: string;
  description: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Scan recently completed tasks for actionable findings.
 * If a task output contains concrete actions, create follow-up tasks.
 */
export async function processApprovedFindings(): Promise<number> {
  // Find tasks completed in the last tick cycle that haven't been processed for follow-ups
  const db = getDb();

  // Get completed tasks not yet processed for auto-execution
  const tasks = db.prepare(`
    SELECT id, agent, description, output, project_id, lane
    FROM tasks
    WHERE status = 'completed'
    AND output IS NOT NULL
    AND id NOT IN (SELECT DISTINCT parent_task_id FROM tasks WHERE parent_task_id IS NOT NULL)
    AND completed_at > ?
  `).all(Date.now() - 120000) as Array<{  // Last 2 minutes
    id: string; agent: string; description: string; output: string; project_id: string; lane: string;
  }>;

  let created = 0;

  for (const task of tasks) {
    try {
      const output = JSON.parse(task.output);
      const actions = extractActions(output, task.agent);

      if (actions.length === 0) continue;

      // Only auto-execute LOW priority actions
      const autoActions = actions.filter(a => a.priority === 'LOW');

      for (const action of autoActions) {
        // Check if a similar task already exists
        const existing = db.prepare(
          "SELECT id FROM tasks WHERE description LIKE ? AND project_id = ? AND created_at > ?",
        ).get(`%${action.description.slice(0, 50)}%`, task.project_id, Date.now() - 24 * 60 * 60 * 1000);

        if (existing) continue; // Don't duplicate

        const id = crypto.randomUUID();
        db.prepare(`
          INSERT INTO tasks (id, agent, status, lane, description, input, input_hash, project_id, created_at)
          VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `).run(
          id, action.agent, action.priority, action.description,
          JSON.stringify({ parentTaskId: task.id, autoExecuted: true, projectId: task.project_id }),
          `auto:${task.id}:${action.description.slice(0, 30)}`,
          task.project_id, Date.now()
        );

        writeAudit({
          agent: 'auto-executor',
          taskId: id,
          action: 'task_created',
          payload: { source: task.id, sourceAgent: task.agent, action: action.description },
          outcome: 'success',
        });

        created++;
      }
    } catch { /* skip tasks with unparseable output */ }
  }

  if (created > 0) {
    console.log(`[auto-executor] Created ${created} follow-up tasks from approved findings`);
  }

  return created;
}

/**
 * Extract actionable items from a task output.
 */
function extractActions(output: unknown, sourceAgent: string): ActionableItem[] {
  if (!output || typeof output !== 'object') return [];
  const actions: ActionableItem[] = [];
  const o = output as Record<string, unknown>;

  // Look for explicit action items in the output
  const text = typeof o.text === 'string' ? o.text :
               typeof o.report === 'string' ? o.report :
               typeof o.scrutiny === 'string' ? o.scrutiny :
               typeof o.analysis === 'string' ? o.analysis : '';

  if (!text) return [];

  // Extract "SOLUTION:" blocks — these are concrete action items
  const solutionMatches = text.matchAll(/SOLUTION:\s*([^\n]+(?:\n(?!PROBLEM:|SOLUTION:)[^\n]+)*)/gi);
  for (const match of solutionMatches) {
    const solution = match[1].trim();
    if (solution.length > 20 && solution.length < 500) {
      actions.push({
        agent: inferAgent(solution, sourceAgent),
        description: solution.slice(0, 200),
        priority: 'LOW',
      });
    }
  }

  // Extract items after "What to do:" or "Next steps:" or "Action:"
  const actionMatches = text.matchAll(/(?:what to do|next steps?|action|recommendation):\s*([^\n]+(?:\n[-*]\s+[^\n]+)*)/gi);
  for (const match of actionMatches) {
    const action = match[1].trim();
    if (action.length > 20 && action.length < 500) {
      actions.push({
        agent: inferAgent(action, sourceAgent),
        description: action.split('\n')[0].replace(/^[-*]\s+/, '').slice(0, 200),
        priority: 'LOW',
      });
    }
  }

  return actions.slice(0, 3); // Max 3 follow-ups per task
}

/**
 * Infer which agent should handle a follow-up action.
 */
function inferAgent(actionText: string, fallback: string): string {
  const lower = actionText.toLowerCase();
  if (lower.includes('code') || lower.includes('fix') || lower.includes('implement') || lower.includes('build')) return 'engineering';
  if (lower.includes('security') || lower.includes('auth') || lower.includes('rls')) return 'security-audit';
  if (lower.includes('legal') || lower.includes('compliance') || lower.includes('privacy')) return 'legal';
  if (lower.includes('marketing') || lower.includes('seo') || lower.includes('content')) return 'marketing-strategist';
  if (lower.includes('cost') || lower.includes('budget') || lower.includes('revenue')) return 'cfo';
  if (lower.includes('metric') || lower.includes('analytics') || lower.includes('data')) return 'data-analyst';
  return fallback;
}
