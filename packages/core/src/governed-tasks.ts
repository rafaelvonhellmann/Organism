import { GoalSourceKind, Task, RiskLane, WorkflowKind } from '../../shared/src/types.js';
import { writeAudit } from './audit.js';
import { evaluateRuntimeAction, workflowToRuntimeAction } from './action-gate.js';
import { hasEquivalentFollowup } from './followup-dedupe.js';
import { resolveFollowupRoute } from './followup-routing.js';
import { createTask } from './task-queue.js';

export interface GovernedFollowupSource {
  id: string;
  agent: string;
  projectId: string;
  goalId?: string | null;
}

export interface GovernedFollowupRoute {
  agent: string;
  workflowKind: WorkflowKind;
  lane: RiskLane;
  rerouted: boolean;
}

export interface CreateGovernedFollowupTaskInput {
  source: GovernedFollowupSource;
  preferredAgent: string;
  workflowKind: WorkflowKind;
  lane: RiskLane;
  description: string;
  input: Record<string, unknown> | ((route: GovernedFollowupRoute) => Record<string, unknown>);
  parentTaskId?: string | null;
  projectId?: string;
  goalId?: string | null;
  allowReadOnlyDegrade?: boolean;
  sourceKind?: GoalSourceKind;
  auditPayload?: Record<string, unknown>;
}

export async function createGovernedFollowupTask(params: CreateGovernedFollowupTaskInput): Promise<Task | null> {
  const projectId = params.projectId ?? params.source.projectId;
  const route = resolveFollowupRoute({
    projectId,
    preferredAgent: params.preferredAgent,
    workflowKind: params.workflowKind,
    lane: params.lane,
    description: params.description,
    allowReadOnlyDegrade: params.allowReadOnlyDegrade ?? true,
  });
  if (!route) return null;
  const taskInput = typeof params.input === 'function' ? params.input(route) : params.input;

  if (hasEquivalentFollowup({
    goalId: params.goalId ?? params.source.goalId ?? null,
    projectId,
    agent: route.agent,
    workflowKind: route.workflowKind,
    description: params.description,
    sourceTaskId: params.source.id,
  })) {
    return null;
  }

  const gate = await evaluateRuntimeAction({
    projectId,
    action: workflowToRuntimeAction(route.workflowKind),
    actor: 'governed-tasks',
    taskId: params.source.id,
    description: params.description,
    workflowKind: route.workflowKind,
    context: {
      sourceAgent: params.source.agent,
      preferredAgent: params.preferredAgent,
      routedAgent: route.agent,
      routedFollowup: route.rerouted,
      followup: true,
    },
  });
  if (!gate.allowed) return null;

  const task = createTask({
    agent: route.agent,
    lane: route.lane,
    description: params.description,
    input: {
      ...taskInput,
      requestedTargetAgent: params.preferredAgent,
      requestedWorkflowKind: params.workflowKind,
      routedFollowup: route.rerouted,
    },
    parentTaskId: params.parentTaskId ?? params.source.id,
    projectId,
    goalId: params.goalId ?? params.source.goalId ?? undefined,
    workflowKind: route.workflowKind,
    sourceKind: params.sourceKind ?? 'agent_followup',
  });

  writeAudit({
    agent: 'governed-tasks',
    taskId: task.id,
    action: 'task_created',
    payload: {
      sourceTaskId: params.source.id,
      sourceAgent: params.source.agent,
      targetAgent: route.agent,
      workflowKind: route.workflowKind,
      requestedTargetAgent: params.preferredAgent,
      requestedWorkflowKind: params.workflowKind,
      rerouted: route.rerouted,
      gate,
      ...(params.auditPayload ?? {}),
    },
    outcome: 'success',
  });

  return task;
}
