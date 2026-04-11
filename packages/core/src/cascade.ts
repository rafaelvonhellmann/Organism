import { createTask, getDb } from './task-queue.js';
import { writeAudit } from './audit.js';
import { extractFindings, extractHandoffs } from './agent-envelope.js';
import { hasEquivalentFollowup } from './followup-dedupe.js';
import { HandoffRequest, RiskLane, TypedFinding } from '../../shared/src/types.js';

const CASCADE_ELIGIBLE_AGENTS = new Set(['security-audit', 'product-manager', 'cto', 'devops']);
const MAX_DAILY_CASCADES_PER_AGENT = 3;

function laneFromSeverity(severity: TypedFinding['severity']): RiskLane {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 'HIGH';
    case 'MEDIUM':
      return 'MEDIUM';
    default:
      return 'LOW';
  }
}

function recentCascadeCount(agent: string, projectId: string): number {
  const oneDayAgo = Date.now() - 86400000;
  const row = getDb().prepare(`
    SELECT COUNT(*) as c
    FROM tasks
    WHERE agent = ? AND project_id = ? AND source_kind = 'agent_followup' AND created_at > ?
  `).get(agent, projectId, oneDayAgo) as { c: number } | undefined;
  return row?.c ?? 0;
}

function createCascadeTask(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  project_id: string;
  goal_id: string | null;
}, targetAgent: string, workflowKind: string, description: string, lane: RiskLane, detail: Record<string, unknown>): boolean {
  if (hasEquivalentFollowup({
    goalId: task.goal_id,
    projectId: task.project_id,
    agent: targetAgent,
    workflowKind,
    description,
    sourceTaskId: task.id,
  })) return false;
  if (recentCascadeCount(targetAgent, task.project_id) >= MAX_DAILY_CASCADES_PER_AGENT) return false;

  try {
    const created = createTask({
      agent: targetAgent,
      lane,
      description,
      input: {
        ...detail,
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        sourceOutput: task.output.slice(0, 3000),
        projectId: task.project_id,
        execution: workflowKind === 'implement',
      },
      parentTaskId: task.id,
      projectId: task.project_id,
      goalId: task.goal_id ?? undefined,
      workflowKind,
      sourceKind: 'agent_followup',
    });

    writeAudit({
      agent: 'cascade',
      taskId: created.id,
      action: 'task_created',
      payload: {
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        targetAgent,
        workflowKind,
      },
      outcome: 'success',
    });
    return true;
  } catch {
    return false;
  }
}

function fallbackFindingCascade(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  project_id: string;
  goal_id: string | null;
}, findings: TypedFinding[]): number {
  let created = 0;
  for (const finding of findings) {
    if (!finding.actionable || !finding.remediation) continue;
    if (createCascadeTask(
      task,
      'engineering',
      finding.followupKind ?? 'implement',
      finding.remediation,
      laneFromSeverity(finding.severity),
      {
        cascadeReason: finding.summary,
        findingId: finding.id,
      },
    )) {
      created++;
    }
  }
  return created;
}

function handoffCascade(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  project_id: string;
  goal_id: string | null;
}, handoffs: HandoffRequest[]): number {
  let created = 0;
  for (const handoff of handoffs) {
    if (createCascadeTask(
      task,
      handoff.targetAgent,
      handoff.workflowKind,
      handoff.summary,
      handoff.workflowKind === 'validate' ? 'LOW' : 'MEDIUM',
      {
        handoffId: handoff.id,
        handoffReason: handoff.reason,
      },
    )) {
      created++;
    }
  }
  return created;
}

/**
 * Check recently completed tasks and create typed cascade follow-ups.
 * Cascades are now limited to structured handoffs and critical actionable findings.
 */
export function processCascades(): number {
  const completed = getDb().prepare(`
    SELECT id, agent, description, output, project_id, goal_id
    FROM tasks
    WHERE status = 'completed'
      AND completed_at > ?
      AND output IS NOT NULL
      AND source_kind != 'agent_followup'
  `).all(Date.now() - 300000) as Array<{
    id: string;
    agent: string;
    description: string;
    output: string;
    project_id: string;
    goal_id: string | null;
  }>;

  let created = 0;

  for (const task of completed) {
    if (!CASCADE_ELIGIBLE_AGENTS.has(task.agent)) continue;

    try {
      const output = JSON.parse(task.output);
      const handoffs = extractHandoffs(output).slice(0, 2);
      const findings = extractFindings(output)
        .filter((finding) => finding.actionable && (finding.severity === 'CRITICAL' || finding.severity === 'HIGH'))
        .slice(0, 2);

      created += handoffCascade(task, handoffs);

      if (handoffs.length === 0) {
        created += fallbackFindingCascade(task, findings);
      }
    } catch {
      // Ignore legacy outputs without structured follow-ups.
    }
  }

  if (created > 0) {
    console.log(`[cascade] Created ${created} typed cascade follow-up task(s)`);
  }

  return created;
}
