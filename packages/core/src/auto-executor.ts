import { getDb, getTask } from './task-queue.js';
import { extractFindings, extractHandoffs } from './agent-envelope.js';
import { loadRegistry } from './registry.js';
import { canCreatePolicyFollowup, inheritFollowupPolicy, parseFollowupPolicy } from './followup-policy.js';
import { createGovernedFollowupTask } from './governed-tasks.js';
import { RiskLane, TypedFinding, HandoffRequest, WorkflowKind } from '../../shared/src/types.js';

const PROJECT_REVIEW_MODES = new Set(['project_review', 'autonomy_cycle_review', 'self_audit_review']);
const EXECUTION_FOLLOWUP_KINDS = new Set<WorkflowKind>(['implement', 'recover']);
const REVIEW_ONLY_AGENTS = new Set(['quality-agent', 'quality-guardian', 'codex-review', 'domain-model', 'grill-me', 'legal', 'security-audit']);

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

function extractDecision(output: Record<string, unknown>): 'APPROVED' | 'NEEDS_REVISION' | null {
  const direct = output.decision;
  if (direct === 'APPROVED' || direct === 'NEEDS_REVISION') return direct;

  const candidates = [
    output.review,
    output.text,
    output.summary,
    typeof output.payload === 'object' && output.payload ? (output.payload as Record<string, unknown>).review : null,
    typeof output.payload === 'object' && output.payload ? (output.payload as Record<string, unknown>).text : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if (/\*\*Decision:\*\*\s*APPROVED/i.test(candidate) || /\bDecision:\s*APPROVED\b/i.test(candidate)) return 'APPROVED';
    if (/\*\*Decision:\*\*\s*NEEDS_REVISION/i.test(candidate) || /\bDecision:\s*NEEDS_REVISION\b/i.test(candidate)) return 'NEEDS_REVISION';
  }

  return null;
}

function extractReviewText(output: Record<string, unknown>): string {
  const candidates = [
    output.review,
    output.text,
    output.summary,
    typeof output.payload === 'object' && output.payload ? (output.payload as Record<string, unknown>).review : null,
    typeof output.payload === 'object' && output.payload ? (output.payload as Record<string, unknown>).text : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return JSON.stringify(output);
}

function reviewFollowupWorkflow(originalWorkflowKind: WorkflowKind | undefined): WorkflowKind {
  if (originalWorkflowKind === 'review' || originalWorkflowKind === 'plan') return 'implement';
  if (originalWorkflowKind === 'validate') return 'implement';
  if (originalWorkflowKind === 'ship') return 'implement';
  return originalWorkflowKind ?? 'implement';
}

function workflowPriority(workflowKind: WorkflowKind | undefined): number {
  switch (workflowKind) {
    case 'recover':
      return 0;
    case 'implement':
      return 1;
    case 'validate':
      return 2;
    case 'review':
      return 3;
    case 'plan':
      return 4;
    default:
      return 5;
  }
}

function severityPriority(severity: TypedFinding['severity']): number {
  switch (severity) {
    case 'MEDIUM':
      return 0;
    case 'LOW':
      return 1;
    case 'HIGH':
      return 2;
    case 'CRITICAL':
      return 3;
    default:
      return 4;
  }
}

function isProjectReviewOutput(output: Record<string, unknown>): boolean {
  return typeof output.mode === 'string' && PROJECT_REVIEW_MODES.has(output.mode);
}

function isExecutionFinding(finding: TypedFinding): boolean {
  const workflowKind = finding.followupKind ?? 'implement';
  if (!EXECUTION_FOLLOWUP_KINDS.has(workflowKind)) return false;
  const targetAgent = resolveTargetAgent(finding.targetCapability, 'engineering');
  return !REVIEW_ONLY_AGENTS.has(targetAgent);
}

function selectActionableFindings(output: Record<string, unknown>, findings: TypedFinding[]): TypedFinding[] {
  const actionable = findings.filter((finding) => finding.actionable);
  if (!isProjectReviewOutput(output)) {
    return actionable.slice(0, 3);
  }
  if (actionable.length === 0) return [];

  const prioritized = actionable
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const workflowDiff = workflowPriority(left.finding.followupKind) - workflowPriority(right.finding.followupKind);
      if (workflowDiff !== 0) return workflowDiff;

      const severityDiff = severityPriority(left.finding.severity) - severityPriority(right.finding.severity);
      if (severityDiff !== 0) return severityDiff;

      return left.index - right.index;
    });

  const chosen: TypedFinding[] = [];
  const primaryExecution = prioritized.find(({ finding }) => isExecutionFinding(finding));
  if (primaryExecution) {
    chosen.push(primaryExecution.finding);
  }

  if (primaryExecution?.finding.followupKind !== 'recover') {
    const validationFinding = prioritized.find(({ finding }) =>
      finding.followupKind === 'validate'
      && !chosen.some((selected) => selected.id === finding.id),
    );
    if (validationFinding) {
      chosen.push(validationFinding.finding);
    }
  }

  if (chosen.length === 0) {
    chosen.push(prioritized[0]!.finding);
  }

  return chosen.slice(0, 2);
}

function unwrapNestedQuotedFollowup(description: string, prefix: string): string {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${escapedPrefix}\\s+for\\s+"(.+)"$`, 'i');
  let current = description.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();

  while (true) {
    const match = current.match(matcher);
    if (!match) return current;
    const next = match[1]!.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
    if (next === current) return current;
    current = next;
  }
}

function compactTaskFocus(description: string): string {
  const compacted = [
    'Fix build in preserved worktree',
    'Recover preserved worktree handoff',
    'Address codex-review findings',
    'Address quality review findings',
  ].reduce((value, prefix) => unwrapNestedQuotedFollowup(value, prefix), description);

  return tightenTaskSummary(compacted, 120);
}

function tightenTaskSummary(description: string, maxLength = 140): string {
  let compacted = description.replace(/\s+/g, ' ').trim();
  const sentence = compacted.split(/(?<=[.!?])\s+/)[0];
  if (sentence) compacted = sentence.trim();

  if (compacted.length > 96) {
    const andMatch = /\s+and\s+/i.exec(compacted);
    if (andMatch && typeof andMatch.index === 'number') {
      const primaryClause = compacted.slice(0, andMatch.index).trim();
      if (primaryClause.length >= 32) {
        compacted = primaryClause;
      }
    }
  }

  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 3).trimEnd()}...` : compacted;
}

async function createFindingTask(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  input: string | null;
  project_id: string;
  goal_id: string | null;
}, finding: TypedFinding): Promise<boolean> {
  const requestedAgent = resolveTargetAgent(finding.targetCapability, 'engineering');
  const requestedWorkflowKind = finding.followupKind ?? 'implement';
  const requestedLane = laneFromSeverity(finding.severity);
  const followupDescription = tightenTaskSummary(finding.remediation ?? finding.summary);
  const created = await createGovernedFollowupTask({
    source: {
      id: task.id,
      agent: task.agent,
      projectId: task.project_id,
      goalId: task.goal_id,
    },
    preferredAgent: requestedAgent,
    workflowKind: requestedWorkflowKind,
    lane: requestedLane,
    description: followupDescription,
    projectId: task.project_id,
    goalId: task.goal_id,
    parentTaskId: task.id,
    allowReadOnlyDegrade: true,
    input: (route) => ({
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        sourceFindingId: finding.id,
        sourceSummary: finding.summary,
        evidence: finding.evidence ?? null,
        remediation: finding.remediation ?? null,
        autoExecuted: true,
        execution: route.workflowKind === 'implement' || route.workflowKind === 'recover',
        projectId: task.project_id,
        ...inheritFollowupPolicy(task.input ? JSON.parse(task.input) : null),
      }),
    auditPayload: {
        followupType: 'finding',
        findingId: finding.id,
      },
  });
  return created !== null;
}

async function createHandoffTask(task: {
  id: string;
  agent: string;
  description: string;
  output: string;
  input: string | null;
  project_id: string;
  goal_id: string | null;
}, handoff: HandoffRequest): Promise<boolean> {
  const created = await createGovernedFollowupTask({
    source: {
      id: task.id,
      agent: task.agent,
      projectId: task.project_id,
      goalId: task.goal_id,
    },
    preferredAgent: handoff.targetAgent,
    workflowKind: handoff.workflowKind,
    lane: handoff.workflowKind === 'validate' ? 'LOW' : 'MEDIUM',
    description: handoff.summary,
    projectId: task.project_id,
    goalId: task.goal_id,
    parentTaskId: task.id,
    allowReadOnlyDegrade: true,
    input: (route) => ({
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        handoffId: handoff.id,
        handoffReason: handoff.reason,
        sourceOutput: task.output.slice(0, 3000),
        autoExecuted: true,
        execution: handoff.execution === true && (route.workflowKind === 'implement' || route.workflowKind === 'recover'),
        projectId: task.project_id,
        ...inheritFollowupPolicy(task.input ? JSON.parse(task.input) : null),
      }),
    auditPayload: {
        followupType: 'handoff',
        handoffId: handoff.id,
      },
  });
  return created !== null;
}

async function createRevisionFollowupTask(
  task: {
    id: string;
    agent: string;
    description: string;
    output: string;
    input: string | null;
    project_id: string;
    goal_id: string | null;
  },
  output: Record<string, unknown>,
): Promise<boolean> {
  const decision = extractDecision(output);
  if (decision !== 'NEEDS_REVISION') return false;

  const originalTaskId = typeof output.originalTaskId === 'string'
    ? output.originalTaskId
    : typeof output.payload === 'object' && output.payload && typeof (output.payload as Record<string, unknown>).originalTaskId === 'string'
      ? String((output.payload as Record<string, unknown>).originalTaskId)
      : null;
  if (!originalTaskId) return false;

  const originalTask = getTask(originalTaskId);
  if (!originalTask) return false;
  if (['quality-agent', 'codex-review', 'domain-model', 'grill-me', 'quality-guardian'].includes(originalTask.agent)) return false;

  const requestedAgent = originalTask.agent === 'quality-agent' ? 'engineering' : originalTask.agent;
  const requestedWorkflowKind = reviewFollowupWorkflow(originalTask.workflowKind);
  const summary = tightenTaskSummary(`Address ${task.agent} findings for "${compactTaskFocus(originalTask.description)}"`);
  const reviewText = extractReviewText(output).slice(0, 6000);
  const created = await createGovernedFollowupTask({
    source: {
      id: task.id,
      agent: task.agent,
      projectId: task.project_id,
      goalId: task.goal_id,
    },
    preferredAgent: requestedAgent,
    workflowKind: requestedWorkflowKind,
    lane: originalTask.lane === 'HIGH' ? 'MEDIUM' : 'LOW',
    description: summary,
    projectId: originalTask.projectId ?? task.project_id,
    goalId: originalTask.goalId ?? task.goal_id,
    parentTaskId: originalTask.id,
    allowReadOnlyDegrade: true,
    input: (route) => ({
          sourceTaskId: task.id,
          sourceAgent: task.agent,
          originalTaskId: originalTask.id,
          originalDescription: originalTask.description,
          qualityFeedback: reviewText,
          sourceOutput: reviewText,
          autoExecuted: true,
          execution: route.agent === 'engineering' && (route.workflowKind === 'implement' || route.workflowKind === 'recover'),
          projectId: originalTask.projectId ?? task.project_id,
          ...inheritFollowupPolicy(task.input ? JSON.parse(task.input) : null),
        }),
    auditPayload: {
          followupType: 'review_revision',
          originalTaskId: originalTask.id,
        },
  });
  return created !== null;
}

async function createEngineeringRecoveryTask(
  task: {
    id: string;
    agent: string;
    description: string;
    output: string;
    input: string | null;
    project_id: string;
    goal_id: string | null;
  },
  output: Record<string, unknown>,
): Promise<boolean> {
  if (task.agent !== 'engineering') return false;

  const payload = typeof output.payload === 'object' && output.payload
    ? output.payload as Record<string, unknown>
    : null;

  const mode = typeof output.mode === 'string'
    ? output.mode
    : typeof payload?.mode === 'string'
      ? String(payload.mode)
      : null;
  if (mode !== 'executed') return false;

  const changedFiles = Array.isArray(output.changedFiles)
    ? output.changedFiles as unknown[]
    : Array.isArray(payload?.changedFiles)
      ? payload.changedFiles as unknown[]
      : [];
  if (changedFiles.length === 0) return false;

  const workspaceCleanup = typeof output.workspaceCleanup === 'object' && output.workspaceCleanup
    ? output.workspaceCleanup as Record<string, unknown>
    : typeof payload?.workspaceCleanup === 'object' && payload.workspaceCleanup
      ? payload.workspaceCleanup as Record<string, unknown>
      : null;
  const verification = Array.isArray(output.verification)
    ? output.verification as unknown[]
    : Array.isArray(payload?.verification)
      ? payload.verification as unknown[]
      : [];

  const cleanupBlocked = workspaceCleanup?.removed === false;
  const failedVerification = verification.some((step) => {
    if (!step || typeof step !== 'object') return false;
    return (step as Record<string, unknown>).ok === false;
  });

  if (!cleanupBlocked && !failedVerification) return false;

  const recoverWorktreePath = typeof workspaceCleanup?.path === 'string' ? workspaceCleanup.path : undefined;
  const verificationNotes = verification
    .filter((step): step is Record<string, unknown> => !!step && typeof step === 'object')
    .filter((step) => step.ok === false)
    .map((step) => `${String(step.action ?? 'verification')}: ${String(step.output ?? 'failed').slice(0, 400)}`)
    .slice(0, 3);
  const primaryVerificationTarget = verificationNotes[0]?.split(':')[0] ?? 'verification';
  const compactFocus = compactTaskFocus(task.description);
  const summary = failedVerification
    ? `Fix ${primaryVerificationTarget} in preserved worktree for "${compactFocus}"`
    : `Recover preserved worktree handoff for "${compactFocus}"`;
  const created = await createGovernedFollowupTask({
    source: {
      id: task.id,
      agent: task.agent,
      projectId: task.project_id,
      goalId: task.goal_id,
    },
    preferredAgent: 'engineering',
    workflowKind: 'recover',
    lane: failedVerification ? 'MEDIUM' : 'LOW',
    description: summary,
    projectId: task.project_id,
    goalId: task.goal_id,
    parentTaskId: task.id,
    allowReadOnlyDegrade: true,
    input: (route) => ({
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        sourceOutput: extractReviewText(output).slice(0, 6000),
        recoverWorktreePath,
        verificationFailures: verificationNotes,
        autoExecuted: true,
        execution: route.agent === 'engineering' && (route.workflowKind === 'implement' || route.workflowKind === 'recover'),
        projectId: task.project_id,
        ...inheritFollowupPolicy(task.input ? JSON.parse(task.input) : null),
      }),
    auditPayload: {
        followupType: 'engineering_recovery',
        recoverWorktreePath,
      },
  });
  return created !== null;
}

async function createEngineeringValidationTask(
  task: {
    id: string;
    agent: string;
    description: string;
    output: string;
    input: string | null;
    project_id: string;
    goal_id: string | null;
    workflow_kind?: WorkflowKind;
  },
  output: Record<string, unknown>,
): Promise<boolean> {
  if (task.agent !== 'engineering') return false;
  if (task.workflow_kind !== 'implement' && task.workflow_kind !== 'recover') return false;

  const payload = typeof output.payload === 'object' && output.payload
    ? output.payload as Record<string, unknown>
    : null;

  const mode = typeof output.mode === 'string'
    ? output.mode
    : typeof payload?.mode === 'string'
      ? String(payload.mode)
      : null;
  if (mode !== 'executed') return false;

  const changedFiles = Array.isArray(output.changedFiles)
    ? output.changedFiles as unknown[]
    : Array.isArray(payload?.changedFiles)
      ? payload.changedFiles as unknown[]
      : [];
  if (changedFiles.length === 0) return false;

  const workspaceCleanup = typeof output.workspaceCleanup === 'object' && output.workspaceCleanup
    ? output.workspaceCleanup as Record<string, unknown>
    : typeof payload?.workspaceCleanup === 'object' && payload.workspaceCleanup
      ? payload.workspaceCleanup as Record<string, unknown>
      : null;
  if (workspaceCleanup?.removed === false) return false;

  const verification = Array.isArray(output.verification)
    ? output.verification as unknown[]
    : Array.isArray(payload?.verification)
      ? payload.verification as unknown[]
      : [];
  const failedVerification = verification.some((step) => {
    if (!step || typeof step !== 'object') return false;
    return (step as Record<string, unknown>).ok === false;
  });
  if (failedVerification) return false;

  const compactFocus = compactTaskFocus(task.description);
  const summary = tightenTaskSummary(`Validate implementation for "${compactFocus}"`);
  const created = await createGovernedFollowupTask({
    source: {
      id: task.id,
      agent: task.agent,
      projectId: task.project_id,
      goalId: task.goal_id,
    },
    preferredAgent: 'quality-agent',
    workflowKind: 'validate',
    lane: 'LOW',
    description: summary,
    projectId: task.project_id,
    goalId: task.goal_id,
    parentTaskId: task.id,
    allowReadOnlyDegrade: true,
    input: () => ({
        sourceTaskId: task.id,
        sourceAgent: task.agent,
        originalTaskId: task.id,
        originalDescription: task.description,
        sourceOutput: extractReviewText(output).slice(0, 6000),
        changedFiles,
        autoExecuted: true,
        execution: false,
        projectId: task.project_id,
        ...inheritFollowupPolicy(task.input ? JSON.parse(task.input) : null),
      }),
    auditPayload: {
        followupType: 'engineering_validation',
      },
  });
  return created !== null;
}

/**
 * Scan recently completed tasks for structured follow-up work.
 * Only typed findings and handoffs can create new tasks.
 */
export async function processApprovedFindings(): Promise<number> {
  const db = getDb();
  const tasks = db.prepare(`
    SELECT id, agent, description, input, output, project_id, goal_id, source_kind
    , workflow_kind
    FROM tasks
    WHERE status = 'completed'
      AND output IS NOT NULL
      AND completed_at > ?
      AND (
        source_kind != 'agent_followup'
        OR agent IN ('quality-agent', 'codex-review', 'quality-guardian', 'engineering')
      )
  `).all(Date.now() - 24 * 60 * 60 * 1000) as Array<{
    id: string;
    agent: string;
    description: string;
    input: string | null;
    output: string;
    project_id: string;
    goal_id: string | null;
    workflow_kind: WorkflowKind;
    source_kind: string | null;
  }>;

  let created = 0;

  for (const task of tasks) {
    try {
      const taskInput = task.input ? JSON.parse(task.input) : null;
      const followupPolicy = parseFollowupPolicy(taskInput);
      const isAgentFollowup = task.source_kind === 'agent_followup';
      let createdForTask = 0;
      const output = JSON.parse(task.output);
      const findings = selectActionableFindings(output, extractFindings(output));
      const handoffs = extractHandoffs(output).slice(0, 2);

      for (const finding of findings) {
        const workflowKind = finding.followupKind ?? 'implement';
        if (!canCreatePolicyFollowup(followupPolicy, workflowKind, createdForTask, isAgentFollowup)) continue;
        if (await createFindingTask(task, finding)) {
          created++;
          createdForTask++;
        }
      }
      for (const handoff of handoffs) {
        if (!canCreatePolicyFollowup(followupPolicy, handoff.workflowKind, createdForTask, isAgentFollowup)) continue;
        if (await createHandoffTask(task, handoff)) {
          created++;
          createdForTask++;
        }
      }
      if (canCreatePolicyFollowup(followupPolicy, 'implement', createdForTask, isAgentFollowup) && await createRevisionFollowupTask(task, output)) {
        created++;
        createdForTask++;
      }
      if (canCreatePolicyFollowup(followupPolicy, 'validate', createdForTask, isAgentFollowup) && await createEngineeringValidationTask(task, output)) {
        created++;
        createdForTask++;
      }
      if (canCreatePolicyFollowup(followupPolicy, 'recover', createdForTask, isAgentFollowup) && await createEngineeringRecoveryTask(task, output)) {
        created++;
        createdForTask++;
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
