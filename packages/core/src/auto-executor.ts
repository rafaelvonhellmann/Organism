import { getDb, createTask } from './task-queue.js';
import { writeAudit } from './audit.js';
import { extractFindings, extractHandoffs } from './agent-envelope.js';
import { loadRegistry } from './registry.js';
import { RiskLane, TypedFinding, HandoffRequest } from '../../shared/src/types.js';

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

function resolveTargetAgent(targetCapability: string | undefined, fallback: string): string {
  if (!targetCapability) return fallback;
  const registry = loadRegistry();
  const byCapability = registry.find((cap) => cap.id === targetCapability);
  if (byCapability) return byCapability.owner;
  const byOwner = registry.find((cap) => cap.owner === targetCapability);
  return byOwner?.owner ?? fallback;
}

function followupExists(goalId: string | null, agent: string, workflowKind: string, sourceTaskId: string): boolean {
  const row = getDb().prepare(`
    SELECT id FROM tasks
    WHERE goal_id IS ? AND agent = ? AND workflow_kind = ? AND input LIKE ?
      AND status NOT IN ('failed', 'dead_letter')
    LIMIT 1
  `).get(goalId, agent, workflowKind, `%"sourceTaskId":"${sourceTaskId}"%`) as { id: string } | undefined;
  return !!row;
}

function createFindingTask(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  project_id: string;
  goal_id: string | null;
}, finding: TypedFinding): boolean {
  const targetAgent = resolveTargetAgent(finding.targetCapability, 'engineering');
  const workflowKind = finding.followupKind ?? 'implement';
  if (followupExists(task.goal_id, targetAgent, workflowKind, task.id)) return false;

  try {
    const created = createTask({
      agent: targetAgent,
      lane: laneFromSeverity(finding.severity),
      description: finding.remediation ?? finding.summary,
      input: {
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        sourceFindingId: finding.id,
        sourceSummary: finding.summary,
        evidence: finding.evidence ?? null,
        remediation: finding.remediation ?? null,
        autoExecuted: true,
        execution: workflowKind === 'implement',
        projectId: task.project_id,
      },
      parentTaskId: task.id,
      projectId: task.project_id,
      goalId: task.goal_id ?? undefined,
      workflowKind,
      sourceKind: 'agent_followup',
    });

    writeAudit({
      agent: 'auto-executor',
      taskId: created.id,
      action: 'task_created',
      payload: {
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        followupType: 'finding',
        targetAgent,
        findingId: finding.id,
        workflowKind,
      },
      outcome: 'success',
    });
    return true;
  } catch {
    return false;
  }
}

function createHandoffTask(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  project_id: string;
  goal_id: string | null;
}, handoff: HandoffRequest): boolean {
  if (followupExists(task.goal_id, handoff.targetAgent, handoff.workflowKind, task.id)) return false;

  try {
    const created = createTask({
      agent: handoff.targetAgent,
      lane: handoff.workflowKind === 'validate' ? 'LOW' : 'MEDIUM',
      description: handoff.summary,
      input: {
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        handoffId: handoff.id,
        handoffReason: handoff.reason,
        sourceOutput: task.output.slice(0, 3000),
        autoExecuted: true,
        execution: handoff.execution === true,
        projectId: task.project_id,
      },
      parentTaskId: task.id,
      projectId: task.project_id,
      goalId: task.goal_id ?? undefined,
      workflowKind: handoff.workflowKind,
      sourceKind: 'agent_followup',
    });

    writeAudit({
      agent: 'auto-executor',
      taskId: created.id,
      action: 'task_created',
      payload: {
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        followupType: 'handoff',
        handoffId: handoff.id,
        targetAgent: handoff.targetAgent,
        workflowKind: handoff.workflowKind,
      },
      outcome: 'success',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan recently completed tasks for structured follow-up work.
 * Only typed findings and handoffs can create new tasks.
 */
export async function processApprovedFindings(): Promise<number> {
  const db = getDb();
  const tasks = db.prepare(`
    SELECT id, agent, description, output, project_id, goal_id
    FROM tasks
    WHERE status = 'completed'
      AND output IS NOT NULL
      AND completed_at > ?
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

  for (const task of tasks) {
    try {
      const output = JSON.parse(task.output);
      const findings = extractFindings(output)
        .filter((finding) => finding.actionable)
        .slice(0, 3);
      const handoffs = extractHandoffs(output).slice(0, 2);

      for (const finding of findings) {
        if (createFindingTask(task, finding)) created++;
      }
      for (const handoff of handoffs) {
        if (createHandoffTask(task, handoff)) created++;
      }
    } catch {
      // Typed follow-ups only; ignore legacy prose-only outputs.
    }
  }

  if (created > 0) {
    console.log(`[auto-executor] Created ${created} typed follow-up task(s)`);
  }

  return created;
}
