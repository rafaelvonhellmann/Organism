import * as crypto from 'crypto';
import { getDb } from './task-queue.js';
import { writeAudit } from './audit.js';

interface CascadeRule {
  sourceAgent: string;
  targetAgent: string;
  condition: 'always' | 'on_finding' | 'on_code_change';
  lane: 'LOW' | 'MEDIUM' | 'HIGH';
}

// Cascade rules: when source completes, trigger target
const CASCADE_RULES: CascadeRule[] = [
  // Engineering fix → Security reviews it
  { sourceAgent: 'engineering', targetAgent: 'security-audit', condition: 'on_code_change', lane: 'LOW' },
  // Engineering fix → Quality validates it
  { sourceAgent: 'engineering', targetAgent: 'quality-guardian', condition: 'always', lane: 'LOW' },
  // Security finding → Engineering implements fix
  { sourceAgent: 'security-audit', targetAgent: 'engineering', condition: 'on_finding', lane: 'MEDIUM' },
  // Product spec → Engineering implements
  { sourceAgent: 'product-manager', targetAgent: 'engineering', condition: 'on_finding', lane: 'LOW' },
  // CTO architecture decision → Engineering implements
  { sourceAgent: 'cto', targetAgent: 'engineering', condition: 'on_finding', lane: 'LOW' },
  // CFO cost concern → Data analyst investigates
  { sourceAgent: 'cfo', targetAgent: 'data-analyst', condition: 'on_finding', lane: 'LOW' },
  // Marketing strategy → SEO implements
  { sourceAgent: 'marketing-strategist', targetAgent: 'seo', condition: 'always', lane: 'LOW' },
];

/**
 * Check recently completed tasks and create cascade follow-ups.
 * Only processes tasks completed in the last 2 minutes (one tick window).
 */
export function processCascades(): number {
  const db = getDb();
  const twoMinAgo = Date.now() - 120000;

  // Find recently completed tasks
  const completed = db.prepare(`
    SELECT id, agent, description, output, project_id, lane
    FROM tasks
    WHERE status = 'completed'
    AND completed_at > ?
    AND output IS NOT NULL
  `).all(twoMinAgo) as Array<{
    id: string; agent: string; description: string; output: string; project_id: string; lane: string;
  }>;

  let created = 0;

  for (const task of completed) {
    const rules = CASCADE_RULES.filter(r => r.sourceAgent === task.agent);
    if (rules.length === 0) continue;

    let hasFinding = false;
    let hasCodeChange = false;

    try {
      const output = JSON.parse(task.output);
      const text = typeof output === 'string' ? output :
                   typeof output.text === 'string' ? output.text :
                   typeof output.report === 'string' ? output.report : '';

      hasFinding = text.length > 100; // Non-trivial output = has findings
      hasCodeChange = text.toLowerCase().includes('fix') ||
                      text.toLowerCase().includes('implement') ||
                      text.toLowerCase().includes('change') ||
                      text.toLowerCase().includes('update');
    } catch { /* unparseable output — skip condition checks, only 'always' rules fire */ }

    for (const rule of rules) {
      // Check condition
      if (rule.condition === 'on_finding' && !hasFinding) continue;
      if (rule.condition === 'on_code_change' && !hasCodeChange) continue;

      // Check if cascade task already exists
      const exists = db.prepare(
        "SELECT id FROM tasks WHERE agent = ? AND project_id = ? AND input LIKE ? AND created_at > ?",
      ).get(rule.targetAgent, task.project_id, `%"cascadeFrom":"${task.id}"%`, twoMinAgo);

      if (exists) continue;

      const id = crypto.randomUUID();
      const desc = `[CASCADE] Follow-up from ${task.agent}: ${task.description.slice(0, 100)}`;

      db.prepare(`
        INSERT INTO tasks (id, agent, status, lane, description, input, input_hash, project_id, created_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        id, rule.targetAgent, rule.lane, desc,
        JSON.stringify({
          cascadeFrom: task.id,
          sourceAgent: task.agent,
          sourceOutput: task.output?.slice(0, 2000),
          projectId: task.project_id,
        }),
        `cascade:${task.id}:${rule.targetAgent}`,
        task.project_id, Date.now()
      );

      writeAudit({
        agent: 'cascade',
        taskId: id,
        action: 'task_created',
        payload: { rule: `${rule.sourceAgent} → ${rule.targetAgent}`, condition: rule.condition, sourceTask: task.id },
        outcome: 'success',
      });

      created++;
    }
  }

  if (created > 0) {
    console.log(`[cascade] Created ${created} follow-up tasks`);
  }

  return created;
}
