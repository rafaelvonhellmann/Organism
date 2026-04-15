import { canAgentExecute } from './registry.js';
import { loadProjectPolicy, resolveTaskSafetyEnvelope } from './project-policy.js';
import { getProjectAutonomyHealth } from './autonomy-governor.js';
import type { RiskLane, WorkflowKind } from '../../shared/src/types.js';

const REVIEW_AGENT_PRIORITY = ['quality-agent', 'quality-guardian', 'codex-review', 'grill-me', 'legal', 'security-audit'] as const;
const EXECUTION_AGENT_PRIORITY = ['engineering'] as const;
const PLAN_AGENT_PRIORITY = ['product-manager', 'ceo'] as const;
const LANE_PRIORITY: Record<RiskLane, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

export interface FollowupRouteResolution {
  agent: string;
  workflowKind: WorkflowKind;
  lane: RiskLane;
  rerouted: boolean;
}

export interface ResolveFollowupRouteParams {
  projectId: string;
  preferredAgent: string;
  workflowKind: WorkflowKind;
  lane: RiskLane;
  description: string;
  allowReadOnlyDegrade?: boolean;
}

function uniqueAgents(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function maxLane(left: RiskLane, right: RiskLane | null): RiskLane {
  if (!right) return left;
  return LANE_PRIORITY[right] > LANE_PRIORITY[left] ? right : left;
}

function workflowCandidates(workflowKind: WorkflowKind, allowReadOnlyDegrade: boolean): WorkflowKind[] {
  const ordered: WorkflowKind[] = [workflowKind];
  if (allowReadOnlyDegrade && workflowKind === 'recover') {
    ordered.push('implement', 'validate', 'review');
  } else if (allowReadOnlyDegrade && workflowKind === 'ship') {
    ordered.push('implement', 'validate', 'review');
  } else if (allowReadOnlyDegrade && workflowKind === 'implement') {
    ordered.push('validate', 'review');
  } else if (allowReadOnlyDegrade && workflowKind === 'validate') {
    ordered.push('review');
  }
  return [...new Set(ordered)];
}

function agentCandidates(workflowKind: WorkflowKind, preferredAgent: string): string[] {
  if (workflowKind === 'review' || workflowKind === 'validate') {
    const preferredReviewAgents = REVIEW_AGENT_PRIORITY.includes(preferredAgent as (typeof REVIEW_AGENT_PRIORITY)[number])
      ? [preferredAgent]
      : [];
    return uniqueAgents([...preferredReviewAgents, ...REVIEW_AGENT_PRIORITY]);
  }
  if (workflowKind === 'implement' || workflowKind === 'recover' || workflowKind === 'ship') {
    return uniqueAgents([preferredAgent, ...EXECUTION_AGENT_PRIORITY]);
  }
  if (workflowKind === 'plan') {
    return uniqueAgents([preferredAgent, ...PLAN_AGENT_PRIORITY]);
  }
  return uniqueAgents([preferredAgent]);
}

export function resolveFollowupRoute(params: ResolveFollowupRouteParams): FollowupRouteResolution | null {
  const policy = loadProjectPolicy(params.projectId);
  const autonomy = getProjectAutonomyHealth(params.projectId);
  const allowedInitialWorkflows = new Set<WorkflowKind>(
    policy.launchGuards.initialWorkflowLimit > 0
      && autonomy.recentCompletedRuns < policy.launchGuards.initialWorkflowLimit
      ? policy.launchGuards.initialAllowedWorkflows as WorkflowKind[]
      : [],
  );
  const initialWorkflowGuardActive = allowedInitialWorkflows.size > 0;

  for (const candidateWorkflow of workflowCandidates(params.workflowKind, params.allowReadOnlyDegrade === true)) {
    if (initialWorkflowGuardActive && !allowedInitialWorkflows.has(candidateWorkflow)) {
      continue;
    }

    const envelope = resolveTaskSafetyEnvelope(policy, params.description, candidateWorkflow);
    if (envelope.blockedReason) {
      continue;
    }

    const candidateAgent = agentCandidates(candidateWorkflow, params.preferredAgent)
      .find((agent) => canAgentExecute(agent, params.projectId));

    if (!candidateAgent) {
      continue;
    }

    return {
      agent: candidateAgent,
      workflowKind: candidateWorkflow,
      lane: maxLane(params.lane, envelope.forcedLane),
      rerouted: candidateAgent !== params.preferredAgent || candidateWorkflow !== params.workflowKind,
    };
  }

  return null;
}
