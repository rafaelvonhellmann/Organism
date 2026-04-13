import { WorkflowKind } from '../../shared/src/types.js';

const DEFAULT_ALLOWED_WORKFLOWS: WorkflowKind[] = ['review', 'validate', 'recover', 'implement'];
type BoundedLane = 'self_audit' | 'medical_read_only';

export interface FollowupPolicy {
  boundedLane: BoundedLane;
  allowedWorkflows: WorkflowKind[];
  maxFollowups: number;
  recursionDisabled: boolean;
}

function normalizeWorkflows(raw: unknown): WorkflowKind[] {
  if (!Array.isArray(raw)) return DEFAULT_ALLOWED_WORKFLOWS;
  const workflows = raw.filter((item): item is WorkflowKind => (
    item === 'review'
    || item === 'plan'
    || item === 'implement'
    || item === 'validate'
    || item === 'monitor'
    || item === 'recover'
  ));
  return workflows.length > 0 ? workflows : DEFAULT_ALLOWED_WORKFLOWS;
}

export function parseFollowupPolicy(input: unknown): FollowupPolicy | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const rawPolicy = record.followupPolicy;
  if (!rawPolicy || typeof rawPolicy !== 'object') return null;

  const policy = rawPolicy as Record<string, unknown>;
  if (policy.boundedLane !== 'self_audit' && policy.boundedLane !== 'medical_read_only') return null;

  const rawMaxFollowups = typeof policy.maxFollowups === 'number' ? Math.trunc(policy.maxFollowups) : 0;
  return {
    boundedLane: policy.boundedLane,
    allowedWorkflows: normalizeWorkflows(policy.allowedWorkflows),
    maxFollowups: Math.max(0, rawMaxFollowups),
    recursionDisabled: policy.recursionDisabled !== false,
  };
}

export function inheritFollowupPolicy(input: unknown): Record<string, unknown> {
  const policy = parseFollowupPolicy(input);
  return policy ? { followupPolicy: policy } : {};
}

export function canCreatePolicyFollowup(
  policy: FollowupPolicy | null,
  workflowKind: WorkflowKind,
  createdCount: number,
  isAgentFollowup: boolean,
): boolean {
  if (!policy) return true;
  if (isAgentFollowup && policy.recursionDisabled) return false;
  if (!policy.allowedWorkflows.includes(workflowKind)) return false;
  if (createdCount >= policy.maxFollowups) return false;
  return true;
}
