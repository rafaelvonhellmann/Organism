import { checkPolicyViaSidecar } from '../../../agents/_base/mcp-client.js';
import { OrganismError } from '../../shared/src/error-taxonomy.js';
import { ProjectAction, ProjectPolicy, RuntimeActionGateReasonCode, WorkflowKind } from '../../shared/src/types.js';
import { writeAudit } from './audit.js';
import {
  isActionAllowed,
  isActionBlocked,
  loadProjectPolicy,
  requiresApproval,
  resolveTaskSafetyEnvelope,
} from './project-policy.js';

export interface RuntimeActionGateInput {
  projectId: string;
  action: ProjectAction;
  actor: string;
  taskId?: string;
  description?: string;
  command?: string;
  workflowKind?: WorkflowKind;
  policy?: ProjectPolicy;
  context?: Record<string, unknown>;
}

export interface RuntimeActionGateResult {
  allowed: boolean;
  requiresApproval: boolean;
  reasonCode: RuntimeActionGateReasonCode;
  reason: string;
  projectId: string;
  action: ProjectAction;
  sidecarReason?: string | null;
  blockedAction?: ProjectAction | null;
}

const SENSITIVE_ACTION_PATTERNS: Array<[ProjectAction, RegExp]> = [
  ['purchase', /\b(purchase|buy|subscribe|pay|charge|invoice|billing)\b/i],
  ['contact', /\b(send|email|notify|contact|message|reach out)\b/i],
  ['create_account', /\b(sign up|register|create account)\b/i],
  ['destructive_migration', /\b(drop table|truncate|delete user data|destructive migration|reset --hard)\b/i],
  ['cross_project', /\bcross[-\s]?project\b/i],
];

function actionText(input: RuntimeActionGateInput): string {
  return [
    input.action,
    input.command ? `command: ${input.command}` : null,
    input.description ? `description: ${input.description}` : null,
    input.workflowKind ? `workflow: ${input.workflowKind}` : null,
  ].filter(Boolean).join('\n');
}

function removeNegatedSensitiveInstructions(text: string): string {
  const positiveReminderText = text.replace(
    /\b(?:do not|don't|never)\s+(?:forget|fail|neglect)\s+to\s+(purchase|buy|subscribe|pay|charge|invoice|billing|send|email|notify|contact|message|reach out|sign up|register|create account)\b/gi,
    '$1',
  );

  return positiveReminderText
    .replace(
      /\b(?:do not|don't|never|must not|should not|without|no)\s+(?:\w+\s+){0,6}(?:purchase|buy|subscribe|pay|charge|invoice|billing|send|email|notify|contact|message|reach out|sign up|register|create account)\b[^.\n;,]*/gi,
      '',
    )
    .replace(
      /\b(?:purchase|buy|subscribe|pay|charge|invoice|billing|send|email|notify|contact|message|reach out|sign up|register|create account)\b\s+(?:is|are|must be|should be)\s+(?:not|never)\s+\w*/gi,
      '',
    );
}

function containsShellRedirection(command: string | null | undefined): boolean {
  if (!command) return false;
  // Conservative auto-execution guard: redirection can turn otherwise read-like
  // commands into writes or hide output from the run log.
  return /(^|[^\\])(?:>>?|<|2>|2>>|&>)/.test(command);
}

function inferBlockedRequestedAction(text: string, policy: ProjectPolicy): ProjectAction | null {
  const actionableText = removeNegatedSensitiveInstructions(text);
  for (const [action, pattern] of SENSITIVE_ACTION_PATTERNS) {
    if (pattern.test(actionableText) && isActionBlocked(policy, action)) {
      return action;
    }
  }
  return null;
}

function buildResult(
  input: RuntimeActionGateInput,
  allowed: boolean,
  requiresHumanApproval: boolean,
  reasonCode: RuntimeActionGateReasonCode,
  reason: string,
  extras: Pick<RuntimeActionGateResult, 'sidecarReason' | 'blockedAction'> = {},
): RuntimeActionGateResult {
  return {
    allowed,
    requiresApproval: requiresHumanApproval,
    reasonCode,
    reason,
    projectId: input.projectId,
    action: input.action,
    sidecarReason: extras.sidecarReason ?? null,
    blockedAction: extras.blockedAction ?? null,
  };
}

function auditGate(input: RuntimeActionGateInput, result: RuntimeActionGateResult): void {
  writeAudit({
    agent: input.actor,
    taskId: input.taskId ?? 'runtime-action',
    action: 'gate_eval',
    payload: {
      type: 'runtime_action_gate',
      projectId: input.projectId,
      action: input.action,
      command: input.command ?? null,
      description: input.description ?? null,
      workflowKind: input.workflowKind ?? null,
      requiresApproval: result.requiresApproval,
      reasonCode: result.reasonCode,
      reason: result.reason,
      sidecarReason: result.sidecarReason ?? null,
      blockedAction: result.blockedAction ?? null,
      context: input.context ?? {},
    },
    outcome: result.allowed ? 'success' : 'blocked',
    errorCode: result.allowed ? undefined : OrganismError.GATE_BLOCKED,
  });
}

export async function evaluateRuntimeAction(input: RuntimeActionGateInput): Promise<RuntimeActionGateResult> {
  const policy = input.policy ?? loadProjectPolicy(input.projectId);
  const text = actionText(input);

  if (!isActionAllowed(policy, input.action)) {
    const result = buildResult(
      input,
      false,
      requiresApproval(policy, input.action),
      'project_policy_block',
      `Action "${input.action}" is not allowed by policy for ${input.projectId}.`,
      { blockedAction: input.action },
    );
    auditGate(input, result);
    return result;
  }

  const blockedRequestedAction = inferBlockedRequestedAction(text, policy);
  if (blockedRequestedAction) {
    const result = buildResult(
      input,
      false,
      true,
      'sensitive_action_block',
      `Action "${blockedRequestedAction}" is blocked in ${policy.autonomyMode} mode for ${input.projectId}.`,
      { blockedAction: blockedRequestedAction },
    );
    auditGate(input, result);
    return result;
  }

  if (input.description && input.workflowKind) {
    const envelope = resolveTaskSafetyEnvelope(policy, input.description, input.workflowKind);
    if (envelope.blockedReason) {
      const result = buildResult(input, false, true, 'safety_envelope_block', envelope.blockedReason, { blockedAction: input.action });
      auditGate(input, result);
      return result;
    }
  }

  if (containsShellRedirection(input.command)) {
    const result = buildResult(
      input,
      true,
      true,
      'contains_redirection',
      'Command contains shell redirection and requires explicit approval before execution.',
    );
    auditGate(input, result);
    return result;
  }

  const sidecar = await checkPolicyViaSidecar(text, {
    projectId: input.projectId,
    action: input.action,
    actor: input.actor,
    taskId: input.taskId ?? null,
    workflowKind: input.workflowKind ?? null,
    ...(input.context ?? {}),
  });

  if (sidecar.result === 'FAIL') {
    const result = buildResult(input, false, true, 'sidecar_policy_block', sidecar.reason, { sidecarReason: sidecar.reason });
    auditGate(input, result);
    return result;
  }

  const approvalRequired = requiresApproval(policy, input.action);
  const result = buildResult(
    input,
    true,
    approvalRequired,
    approvalRequired ? 'approval_required' : 'allowed',
    approvalRequired
      ? `Action "${input.action}" is permitted but requires human approval for ${input.projectId}.`
      : 'Runtime action gate passed.',
    { sidecarReason: sidecar.reason },
  );
  auditGate(input, result);
  return result;
}

export async function assertRuntimeActionAllowed(input: RuntimeActionGateInput): Promise<RuntimeActionGateResult> {
  const result = await evaluateRuntimeAction(input);
  if (!result.allowed) {
    throw new Error(`POLICY BLOCK: ${result.reason}`);
  }
  if (result.requiresApproval) {
    throw new Error(`APPROVAL REQUIRED: ${result.reason}`);
  }
  return result;
}

export function workflowToRuntimeAction(workflowKind: WorkflowKind): ProjectAction {
  switch (workflowKind) {
    case 'ship':
      return 'deploy';
    case 'validate':
      return 'run_tests';
    case 'review':
    case 'plan':
    case 'monitor':
    case 'shaping':
      return 'run_tests';
    case 'implement':
    case 'recover':
    default:
      return 'edit_code';
  }
}
