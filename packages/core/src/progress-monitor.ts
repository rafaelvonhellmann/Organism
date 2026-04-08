import * as crypto from 'crypto';
import { getDb } from './task-queue.js';
import { writeAudit } from './audit.js';

// The weekly plan per perspective — what should be happening right now
// This is the single source of truth for "what the Organism should be doing"
const WEEKLY_OBJECTIVES: Array<{
  agent: string;
  projectId: string;
  objective: string;
  checkQuery: string; // SQL to check if there's a recent task addressing this
}> = [
  {
    agent: 'engineering',
    projectId: 'synapse',
    objective: 'Review SAQ citation enrichment progress and identify any blockers',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'engineering' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%enrichment%' AND created_at > ?",
  },
  {
    agent: 'engineering',
    projectId: 'synapse',
    objective: 'Review auth flow implementation and identify issues',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'engineering' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%auth%' AND created_at > ?",
  },
  {
    agent: 'product-manager',
    projectId: 'synapse',
    objective: 'RICE-score the remaining backlog items and define the activation metric for Synapse',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'product-manager' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%backlog%' AND created_at > ?",
  },
  {
    agent: 'ceo',
    projectId: 'synapse',
    objective: 'Validate ANZCA beachhead product-market fit and approve enrichment spend allocation',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'ceo' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%beachhead%' AND created_at > ?",
  },
  {
    agent: 'cfo',
    projectId: 'synapse',
    objective: 'Track enrichment spend against the $465 budget cap and report cost status',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'cfo' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%enrichment%spend%' AND created_at > ?",
  },
  {
    agent: 'marketing-strategist',
    projectId: 'synapse',
    objective: 'Draft the founder post for ANZCA trainee Facebook groups — authentic registrar voice',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'marketing-strategist' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%founder%post%' AND created_at > ?",
  },
  {
    agent: 'security-audit',
    projectId: 'synapse',
    objective: 'Verify BYPASS_AUTH is OFF and review RLS policies on all Supabase tables',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'security-audit' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%auth%bypass%' AND created_at > ?",
  },
  {
    agent: 'data-analyst',
    projectId: 'synapse',
    objective: 'Define pre-launch KPIs and design the signup funnel instrumentation plan',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'data-analyst' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%KPI%' AND created_at > ?",
  },
  {
    agent: 'medical-content-reviewer',
    projectId: 'synapse',
    objective: 'Audit SAQ citation enrichment quality — check 10 random enriched questions for accuracy',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'medical-content-reviewer' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%citation%quality%' AND created_at > ?",
  },
  {
    agent: 'legal',
    projectId: 'synapse',
    objective: 'Review the Terms of Service draft and copyright audit status for Synapse',
    checkQuery: "SELECT id FROM tasks WHERE agent = 'legal' AND project_id = 'synapse' AND status = 'completed' AND description LIKE '%terms%service%' AND created_at > ?",
  },
];

/**
 * Check progress on weekly objectives and create tasks for stalled items.
 * Runs every scheduler tick. Only creates tasks if the objective hasn't been
 * addressed in the last 3 days.
 */
export function checkProgressAndCreateTasks(): number {
  const db = getDb();
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let created = 0;

  for (const obj of WEEKLY_OBJECTIVES) {
    // Check if this objective has been addressed recently
    const existing = db.prepare(obj.checkQuery).get(threeDaysAgo);
    if (existing) continue;

    // Check if we already have a pending/in_progress task for this
    const pending = db.prepare(
      "SELECT id FROM tasks WHERE agent = ? AND project_id = ? AND status IN ('pending', 'in_progress') AND description = ?"
    ).get(obj.agent, obj.projectId, obj.objective);
    if (pending) continue;

    // Create the task
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO tasks (id, agent, status, lane, description, input, input_hash, project_id, created_at)
      VALUES (?, ?, 'pending', 'LOW', ?, ?, ?, ?, ?)
    `).run(
      id, obj.agent, obj.objective,
      JSON.stringify({ projectId: obj.projectId, triggeredBy: 'progress-monitor', objective: true }),
      `objective:${obj.agent}:${obj.objective.slice(0, 30)}`,
      obj.projectId, Date.now()
    );

    writeAudit({
      agent: 'progress-monitor',
      taskId: id,
      action: 'task_created',
      payload: { agent: obj.agent, objective: obj.objective, reason: 'Not addressed in 3 days' },
      outcome: 'success',
    });

    console.log(`[progress-monitor] Created task for ${obj.agent}: ${obj.objective.slice(0, 60)}`);
    created++;
  }

  return created;
}

/**
 * Generate a progress report — what's on track, what's stalled.
 */
export function getProgressReport(projectId: string = 'synapse'): {
  onTrack: string[];
  stalled: string[];
  inProgress: string[];
} {
  const db = getDb();
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

  const onTrack: string[] = [];
  const stalled: string[] = [];
  const inProgress: string[] = [];

  for (const obj of WEEKLY_OBJECTIVES.filter(o => o.projectId === projectId)) {
    const completed = db.prepare(obj.checkQuery).get(threeDaysAgo);
    if (completed) {
      onTrack.push(`${obj.agent}: ${obj.objective}`);
      continue;
    }

    const pending = db.prepare(
      "SELECT id FROM tasks WHERE agent = ? AND project_id = ? AND status IN ('pending', 'in_progress') AND description = ?"
    ).get(obj.agent, obj.projectId, obj.objective);

    if (pending) {
      inProgress.push(`${obj.agent}: ${obj.objective}`);
    } else {
      stalled.push(`${obj.agent}: ${obj.objective}`);
    }
  }

  return { onTrack, stalled, inProgress };
}
