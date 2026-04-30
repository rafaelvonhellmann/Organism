import * as crypto from 'crypto';
import { getDb } from './task-queue.js';
import { recordRuntimeEvent } from './runtime-events.js';
import { ensureRunMemory, mergeRunFacts, updateRunProgress, writeRunHandoff } from './run-memory.js';
import {
  ApprovalRecord,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  Goal,
  GoalSourceKind,
  GoalStatus,
  Interrupt,
  InterruptStatus,
  ProjectPolicy,
  ProjectAction,
  ProviderFailureKind,
  RetryClass,
  RiskLane,
  RunConfigSnapshot,
  RunDisplayStatus,
  RunSession,
  RunSessionStatus,
  RunStep,
  RunStepStatus,
  WorkflowKind,
} from '../../shared/src/types.js';
import { loadProjectPolicy } from './project-policy.js';

const SIDECAR_TOOL_NAMES = [
  'route_model',
  'rag_retrieve',
  'check_policy',
  'detect_doom_loop',
  'persist_memory',
];

function now(): number {
  return Date.now();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function policyHash(policy: ProjectPolicy | null): string | undefined {
  if (!policy) return undefined;
  return crypto.createHash('sha256')
    .update(stableJson({
      projectId: policy.projectId,
      autonomyMode: policy.autonomyMode,
      allowedActions: policy.allowedActions,
      blockedActions: policy.blockedActions,
      approvalThresholds: policy.approvalThresholds,
      workspaceMode: policy.workspaceMode,
      launchGuards: policy.launchGuards,
      autonomySurfaces: policy.autonomySurfaces,
      envRequirements: policy.envRequirements,
    }))
    .digest('hex');
}

function safeLoadPolicy(projectId: string): ProjectPolicy | null {
  try {
    return loadProjectPolicy(projectId);
  } catch {
    return null;
  }
}

function parseJsonObject<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function requiredReviewStages(lane: RiskLane | null | undefined): string[] {
  switch (lane) {
    case 'LOW':
      return ['quality-agent'];
    case 'MEDIUM':
      return ['quality-agent', 'codex-review'];
    case 'HIGH':
      return ['quality-agent', 'codex-review', 'quality-guardian', 'g4-board'];
    default:
      return [];
  }
}

export function deriveRunDisplayStatus(input: {
  status: RunSessionStatus;
  retryClass?: RetryClass | null;
  providerFailureKind?: ProviderFailureKind | null;
}): { displayStatus: RunDisplayStatus; displayReason: string | null } {
  if (input.status === 'claimed') {
    return { displayStatus: 'claimed', displayReason: 'Worker has claimed the run but has not started execution.' };
  }
  if (input.status === 'pending') {
    return { displayStatus: 'pending', displayReason: null };
  }
  if (input.status === 'running') {
    return { displayStatus: 'running', displayReason: null };
  }
  if (input.status === 'completed') {
    return { displayStatus: 'succeeded', displayReason: null };
  }
  if (input.status === 'cancelled') {
    return { displayStatus: 'cancelled', displayReason: null };
  }
  if (input.status === 'blocked') {
    return { displayStatus: 'blocked', displayReason: 'Run is blocked until policy, approval, or operator input changes.' };
  }
  if (input.status === 'error') {
    return { displayStatus: 'error', displayReason: 'Run stopped because of runtime or infrastructure error.' };
  }
  if (input.status === 'retry_scheduled') {
    return {
      displayStatus: input.retryClass === 'policy_block' || input.retryClass === 'manual_pause'
        ? 'blocked'
        : 'retry_scheduled',
      displayReason: input.retryClass ? `Retry class: ${input.retryClass}` : null,
    };
  }
  if (input.status === 'paused') {
    return {
      displayStatus: input.retryClass === 'policy_block' || input.retryClass === 'manual_pause'
        ? 'blocked'
        : 'retry_scheduled',
      displayReason: input.retryClass && input.retryClass !== 'none' ? `Paused: ${input.retryClass}` : 'Run is paused.',
    };
  }
  if (input.status === 'failed') {
    if (
      input.providerFailureKind === 'auth_failure'
      || input.providerFailureKind === 'missing_secret'
      || input.providerFailureKind === 'tool_failure'
      || input.providerFailureKind === 'transport_error'
      || input.providerFailureKind === 'timeout'
    ) {
      return { displayStatus: 'error', displayReason: `Runtime failure: ${input.providerFailureKind}` };
    }
    if (input.providerFailureKind === 'policy_block' || input.retryClass === 'policy_block') {
      return { displayStatus: 'blocked', displayReason: 'Run failed because policy blocked execution.' };
    }
    return { displayStatus: 'failed', displayReason: null };
  }
  return { displayStatus: 'unknown', displayReason: `Unknown run status: ${input.status}` };
}

export function createRunConfigSnapshot(params: {
  goalId: string;
  projectId: string;
  agent: string;
  workflowKind: WorkflowKind;
  sourceKind?: GoalSourceKind | null;
  riskLane?: RiskLane | null;
  modelProfile?: RunConfigSnapshot['modelProfile'];
  modelBackend?: string | null;
  codeExecutor?: string | null;
  notes?: Record<string, unknown>;
}): RunConfigSnapshot {
  const policy = safeLoadPolicy(params.projectId);
  return {
    schemaVersion: 1,
    capturedAt: now(),
    projectId: params.projectId,
    goalId: params.goalId,
    agent: params.agent,
    workflowKind: params.workflowKind,
    sourceKind: params.sourceKind ?? null,
    riskLane: params.riskLane ?? null,
    modelProfile: params.modelProfile ?? null,
    modelBackend: params.modelBackend ?? process.env.ORGANISM_MODEL_BACKEND ?? null,
    codeExecutor: params.codeExecutor ?? process.env.ORGANISM_CODE_EXECUTOR ?? 'auto',
    sidecar: {
      mode: process.env.ORGANISM_SIDECAR_MODE === 'embedded'
        || process.env.ORGANISM_SIDECAR_MODE === 'external'
        || process.env.ORGANISM_SIDECAR_MODE === 'disabled'
        ? process.env.ORGANISM_SIDECAR_MODE
        : 'unknown',
      toolNames: [...SIDECAR_TOOL_NAMES],
    },
    workspace: {
      mode: policy?.workspaceMode ?? null,
      repoPath: policy?.repoPath ?? null,
      defaultBranch: policy?.defaultBranch ?? null,
    },
    policy: {
      autonomyMode: policy?.autonomyMode ?? null,
      allowedActions: policy?.allowedActions ?? [],
      blockedActions: policy?.blockedActions ?? [],
      envRequirements: policy?.envRequirements ?? [],
      hash: policyHash(policy),
    },
    review: {
      lane: params.riskLane ?? null,
      requiredStages: requiredReviewStages(params.riskLane),
    },
    workflowRecipe: null,
    notes: params.notes,
  };
}

function normalizeDescription(description: string): string {
  return description
    .replace(/^\[SHAPING\]\s*/gi, '')
    .replace(/^\[CASCADE\]\s*Follow-up from \S+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashGoal(projectId: string, workflowKind: WorkflowKind, description: string): string {
  return crypto.createHash('sha256')
    .update(`${projectId}::${workflowKind}::${normalizeDescription(description)}`)
    .digest('hex');
}

function rowToGoal(row: Record<string, unknown>): Goal {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: String(row.description),
    status: row.status as GoalStatus,
    sourceKind: row.source_kind as GoalSourceKind,
    workflowKind: row.workflow_kind as WorkflowKind,
    inputHash: String(row.input_hash),
    latestRunId: row.latest_run_id ? String(row.latest_run_id) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToRun(row: Record<string, unknown>): RunSession {
  const status = row.status as RunSessionStatus;
  const retryClass = row.retry_class as RetryClass;
  const providerFailureKind = row.provider_failure_kind as ProviderFailureKind;
  const display = deriveRunDisplayStatus({ status, retryClass, providerFailureKind });
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    projectId: String(row.project_id),
    agent: String(row.agent),
    workflowKind: row.workflow_kind as WorkflowKind,
    status,
    displayStatus: display.displayStatus,
    displayReason: display.displayReason,
    retryClass,
    retryAt: row.retry_at ? Number(row.retry_at) : null,
    providerFailureKind,
    configSnapshot: parseJsonObject<RunConfigSnapshot>(row.config_snapshot),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
  };
}

function rowToStep(row: Record<string, unknown>): RunStep {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    name: String(row.name),
    status: row.status as RunStepStatus,
    detail: row.detail ? String(row.detail) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
  };
}

function rowToInterrupt(row: Record<string, unknown>): Interrupt {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    type: row.type as Interrupt['type'],
    status: row.status as InterruptStatus,
    summary: String(row.summary),
    detail: row.detail ? String(row.detail) : null,
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
  };
}

function rowToArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    goalId: String(row.goal_id),
    kind: row.kind as ArtifactKind,
    title: String(row.title),
    path: row.path ? String(row.path) : null,
    content: row.content ? String(row.content) : null,
    createdAt: Number(row.created_at),
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    action: row.action as ProjectAction,
    status: row.status as ApprovalStatus,
    requestedBy: String(row.requested_by),
    requestedAt: Number(row.requested_at),
    decidedAt: row.decided_at ? Number(row.decided_at) : null,
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    reason: row.reason ? String(row.reason) : null,
  };
}

export function ensureGoal(params: {
  projectId: string;
  title: string;
  description: string;
  sourceKind: GoalSourceKind;
  workflowKind: WorkflowKind;
  dedupeSeed?: string;
}): Goal {
  const db = getDb();
  const inputHash = hashGoal(params.projectId, params.workflowKind, params.dedupeSeed ?? params.description);
  const existing = db.prepare(`
    SELECT * FROM goals
    WHERE project_id = ? AND workflow_kind = ? AND input_hash = ?
      AND status NOT IN ('completed', 'failed', 'cancelled')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(params.projectId, params.workflowKind, inputHash) as Record<string, unknown> | undefined;

  if (existing) {
    return rowToGoal(existing);
  }

  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO goals (id, project_id, title, description, status, source_kind, workflow_kind, input_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(id, params.projectId, params.title, normalizeDescription(params.description), params.sourceKind, params.workflowKind, inputHash, ts, ts);

  ensureRunMemory(id, params.projectId);
  mergeRunFacts(id, {
    projectId: params.projectId,
    workflowKind: params.workflowKind,
    sourceKind: params.sourceKind,
    title: params.title,
  });
  updateRunProgress(id, [
    `- Goal created for **${params.title}**`,
    `- Workflow: \`${params.workflowKind}\``,
    `- Source: \`${params.sourceKind}\``,
  ]);

  return rowToGoal(db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown>);
}

export function updateGoalStatus(goalId: string, status: GoalStatus, latestRunId?: string | null): Goal {
  const ts = now();
  getDb().prepare(`
    UPDATE goals
    SET status = ?, updated_at = ?, latest_run_id = COALESCE(?, latest_run_id)
    WHERE id = ?
  `).run(status, ts, latestRunId ?? null, goalId);

  return getGoal(goalId)!;
}

export function getGoal(goalId: string): Goal | null {
  const row = getDb().prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as Record<string, unknown> | undefined;
  return row ? rowToGoal(row) : null;
}

export function listGoals(projectId?: string): Goal[] {
  const rows = projectId
    ? getDb().prepare('SELECT * FROM goals WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
    : getDb().prepare('SELECT * FROM goals ORDER BY updated_at DESC').all();
  return (rows as Array<Record<string, unknown>>).map(rowToGoal);
}

export function createRunSession(params: {
  goalId: string;
  projectId: string;
  agent: string;
  workflowKind: WorkflowKind;
  status?: RunSessionStatus;
  sourceKind?: GoalSourceKind | null;
  riskLane?: RiskLane | null;
  modelProfile?: RunConfigSnapshot['modelProfile'];
  modelBackend?: string | null;
  codeExecutor?: string | null;
  configSnapshot?: RunConfigSnapshot | null;
  notes?: Record<string, unknown>;
}): RunSession {
  const db = getDb();
  const id = crypto.randomUUID();
  const ts = now();
  const initialStatus = params.status ?? 'running';
  const configSnapshot = params.configSnapshot ?? createRunConfigSnapshot({
    goalId: params.goalId,
    projectId: params.projectId,
    agent: params.agent,
    workflowKind: params.workflowKind,
    sourceKind: params.sourceKind,
    riskLane: params.riskLane,
    modelProfile: params.modelProfile,
    modelBackend: params.modelBackend,
    codeExecutor: params.codeExecutor,
    notes: params.notes,
  });
  db.prepare(`
    INSERT INTO run_sessions (
      id, goal_id, project_id, agent, workflow_kind, status, retry_class, retry_at, provider_failure_kind, config_snapshot, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'none', NULL, 'none', ?, ?, ?)
  `).run(
    id,
    params.goalId,
    params.projectId,
    params.agent,
    params.workflowKind,
    initialStatus,
    JSON.stringify(configSnapshot),
    ts,
    ts,
  );

  updateGoalStatus(
    params.goalId,
    initialStatus === 'paused' ? 'paused' :
    initialStatus === 'blocked' ? 'blocked' :
    initialStatus === 'error' ? 'error' :
    'running',
    id,
  );
  recordRuntimeEvent({
    runId: id,
    goalId: params.goalId,
    eventType: 'run.started',
    payload: { agent: params.agent, workflowKind: params.workflowKind, configSnapshot },
    agent: params.agent,
  });
  recordRuntimeEvent({
    runId: id,
    goalId: params.goalId,
    eventType: 'agent.active',
    payload: { agent: params.agent },
    agent: params.agent,
  });

  mergeRunFacts(params.goalId, { latestRunId: id, activeAgent: params.agent });
  updateRunProgress(params.goalId, [
    `- Run started with **${params.agent}**`,
    `- Workflow: \`${params.workflowKind}\``,
  ]);

  return rowToRun(db.prepare('SELECT * FROM run_sessions WHERE id = ?').get(id) as Record<string, unknown>);
}

export function getRunSession(runId: string): RunSession | null {
  const row = getDb().prepare('SELECT * FROM run_sessions WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function getLatestRunForGoal(goalId: string): RunSession | null {
  const row = getDb().prepare(`
    SELECT * FROM run_sessions WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(goalId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function updateRunStatus(params: {
  runId: string;
  status: RunSessionStatus;
  retryClass?: RetryClass;
  retryAt?: number | null;
  providerFailureKind?: ProviderFailureKind;
  summary?: string;
}): RunSession {
  const ts = now();
  const resetTransientFailureState = params.status === 'running' || params.status === 'completed';
  const nextRetryClass = params.retryClass ?? (resetTransientFailureState ? 'none' : null);
  const nextProviderFailureKind = params.providerFailureKind ?? (resetTransientFailureState ? 'none' : null);
  getDb().prepare(`
    UPDATE run_sessions
    SET status = ?, retry_class = COALESCE(?, retry_class), retry_at = ?, provider_failure_kind = COALESCE(?, provider_failure_kind),
        updated_at = ?, completed_at = CASE WHEN ? IN ('completed', 'failed', 'error', 'cancelled') THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(
    params.status,
    nextRetryClass,
    params.retryAt ?? null,
    nextProviderFailureKind,
    ts,
    params.status,
    ts,
    params.runId,
  );

  const run = getRunSession(params.runId)!;
  const goalStatus: GoalStatus =
    params.status === 'completed' ? 'completed' :
    params.status === 'failed' ? 'failed' :
    params.status === 'error' ? 'error' :
    params.status === 'blocked' ? 'blocked' :
    params.status === 'retry_scheduled' ? 'retry_scheduled' :
    params.status === 'paused' ? 'paused' :
    params.status === 'cancelled' ? 'cancelled' :
    'running';
  updateGoalStatus(run.goalId, goalStatus, run.id);

  if (params.status === 'paused' || params.status === 'retry_scheduled' || params.status === 'blocked') {
    recordRuntimeEvent({
      runId: run.id,
      goalId: run.goalId,
      eventType: 'run.paused',
      payload: {
        retryClass: params.retryClass ?? run.retryClass,
        retryAt: params.retryAt ?? run.retryAt,
        providerFailureKind: params.providerFailureKind ?? run.providerFailureKind,
        summary: params.summary ?? null,
        displayStatus: getRunSession(params.runId)?.displayStatus ?? null,
      },
      agent: run.agent,
    });
  } else if (params.status === 'running') {
    recordRuntimeEvent({
      runId: run.id,
      goalId: run.goalId,
      eventType: 'run.resumed',
      payload: { summary: params.summary ?? null },
      agent: run.agent,
    });
  } else if (params.status === 'completed' || params.status === 'failed' || params.status === 'error' || params.status === 'cancelled') {
    recordRuntimeEvent({
      runId: run.id,
      goalId: run.goalId,
      eventType: 'run.finished',
      payload: { status: params.status, summary: params.summary ?? null },
      agent: run.agent,
    });
  }

  if (params.summary) {
    writeRunHandoff(run.goalId, `# Handoff\n\n${params.summary}\n`);
  }

  return getRunSession(params.runId)!;
}

export function createRunStep(params: { runId: string; name: string; detail?: string | null }): RunStep {
  const db = getDb();
  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(`
    INSERT INTO run_steps (id, run_id, name, status, detail, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, params.runId, params.name, params.detail ?? null, ts, ts);

  return rowToStep(db.prepare('SELECT * FROM run_steps WHERE id = ?').get(id) as Record<string, unknown>);
}

export function updateRunStep(params: {
  stepId: string;
  status: RunStepStatus;
  detail?: string | null;
}): RunStep | null {
  const ts = now();
  const db = getDb();
  db.prepare(`
    UPDATE run_steps
    SET status = ?, detail = COALESCE(?, detail), updated_at = ?, completed_at = CASE WHEN ? IN ('completed', 'failed', 'skipped') THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(params.status, params.detail ?? null, ts, params.status, ts, params.stepId);

  const row = db.prepare('SELECT * FROM run_steps WHERE id = ?').get(params.stepId) as Record<string, unknown> | undefined;
  if (!row) {
    console.warn(`[run-state] Tried to update missing run step ${params.stepId}`);
    return null;
  }
  const step = rowToStep(row);
  db.prepare(`
    UPDATE run_sessions
    SET updated_at = ?
    WHERE id = ?
  `).run(ts, step.runId);
  return step;
}

export function listRunSteps(runId: string): RunStep[] {
  const rows = getDb().prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Array<Record<string, unknown>>;
  return rows.map(rowToStep);
}

export function createInterrupt(params: {
  runId: string;
  type: Interrupt['type'];
  summary: string;
  detail?: string | null;
}): Interrupt {
  const run = getRunSession(params.runId);
  if (!run) throw new Error(`Run ${params.runId} not found`);

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO interrupts (id, run_id, type, status, summary, detail, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, params.runId, params.type, params.summary, params.detail ?? null, now());

  recordRuntimeEvent({
    runId: run.id,
    goalId: run.goalId,
    eventType: 'interrupt.requested',
    payload: { type: params.type, summary: params.summary },
    agent: run.agent,
  });

  return rowToInterrupt(db.prepare('SELECT * FROM interrupts WHERE id = ?').get(id) as Record<string, unknown>);
}

export function resolveInterrupt(interruptId: string, status: Exclude<InterruptStatus, 'pending'>, detail?: string): Interrupt {
  const ts = now();
  getDb().prepare(`
    UPDATE interrupts SET status = ?, detail = COALESCE(?, detail), resolved_at = ? WHERE id = ?
  `).run(status, detail ?? null, ts, interruptId);

  const row = getDb().prepare('SELECT * FROM interrupts WHERE id = ?').get(interruptId) as Record<string, unknown>;
  const interrupt = rowToInterrupt(row);
  const run = getRunSession(interrupt.runId);
  if (run) {
    recordRuntimeEvent({
      runId: run.id,
      goalId: run.goalId,
      eventType: 'interrupt.resolved',
      payload: { interruptId, status, detail: detail ?? null },
      agent: run.agent,
    });
  }
  return interrupt;
}

export function listInterrupts(runId: string): Interrupt[] {
  const rows = getDb().prepare('SELECT * FROM interrupts WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Array<Record<string, unknown>>;
  return rows.map(rowToInterrupt);
}

export function createArtifact(params: {
  runId: string;
  goalId: string;
  kind: ArtifactKind;
  title: string;
  path?: string | null;
  content?: string | null;
}): Artifact {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO artifacts (id, run_id, goal_id, kind, title, path, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.runId, params.goalId, params.kind, params.title, params.path ?? null, params.content ?? null, now());

  if (params.content) {
    writeRunHandoff(params.goalId, `# ${params.title}\n\n${params.content}\n`);
  }

  return rowToArtifact(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, unknown>);
}

export function listArtifacts(goalId: string): Artifact[] {
  const rows = getDb().prepare('SELECT * FROM artifacts WHERE goal_id = ? ORDER BY created_at ASC').all(goalId) as Array<Record<string, unknown>>;
  return rows.map(rowToArtifact);
}

export function createApprovalRecord(params: {
  runId: string;
  action: ProjectAction;
  requestedBy: string;
  reason?: string | null;
}): ApprovalRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO approvals (id, run_id, action, status, requested_by, requested_at, reason)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, params.runId, params.action, params.requestedBy, now(), params.reason ?? null);

  return rowToApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>);
}

export function updateApprovalRecord(id: string, status: ApprovalStatus, decidedBy: string, reason?: string | null): ApprovalRecord {
  getDb().prepare(`
    UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = COALESCE(?, reason) WHERE id = ?
  `).run(status, now(), decidedBy, reason ?? null, id);

  return rowToApproval(getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>);
}

export function listApprovals(runId: string): ApprovalRecord[] {
  const rows = getDb().prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at ASC').all(runId) as Array<Record<string, unknown>>;
  return rows.map(rowToApproval);
}

export function mapProviderFailure(error: string): { retryClass: RetryClass; providerFailureKind: ProviderFailureKind; pauseUntilMs: number | null } {
  const lower = error.toLowerCase();
  if (lower.includes('credit balance is too low') || lower.includes('hit your limit') || lower.includes('rate limit')) {
    return { retryClass: 'rate_limit', providerFailureKind: 'rate_limit', pauseUntilMs: now() + 60 * 60 * 1000 };
  }
  if (lower.includes('overloaded') || lower.includes('error 529')) {
    return { retryClass: 'provider_overload', providerFailureKind: 'overload', pauseUntilMs: now() + 15 * 60 * 1000 };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborterror')) {
    return { retryClass: 'transient_error', providerFailureKind: 'timeout', pauseUntilMs: now() + 10 * 60 * 1000 };
  }
  if (lower.includes('openai_api_key') || lower.includes('anthropic_api_key') || lower.includes('missing required secrets') || lower.includes('secret')) {
    return { retryClass: 'missing_secret', providerFailureKind: 'missing_secret', pauseUntilMs: null };
  }
  if (
    lower.includes('sql write operations are forbidden')
    || lower.includes('writes are blocked')
    || lower.includes('upgrade your plan')
  ) {
    return { retryClass: 'policy_block', providerFailureKind: 'policy_block', pauseUntilMs: null };
  }
  if (
    lower.includes('unauthorized')
    || lower.includes('forbidden')
    || lower.includes('authentication')
    || lower.includes('invalid api key')
    || lower.includes('auth token')
    || lower.includes('permission denied')
  ) {
    return { retryClass: 'auth_failure', providerFailureKind: 'auth_failure', pauseUntilMs: null };
  }
  if (
    lower.includes('not allowed by policy')
    || lower.includes('blocked in')
    || lower.includes('safety block')
    || lower.includes('approval required')
    || lower.includes('policy block')
  ) {
    return { retryClass: 'policy_block', providerFailureKind: 'policy_block', pauseUntilMs: null };
  }
  if (
    lower.includes('spawn error')
    || lower.includes('not available on path')
    || lower.includes('is not a git repository')
    || lower.includes('project path does not exist')
    || lower.includes('no implementation registered')
    || lower.includes('failed to read output')
  ) {
    return { retryClass: 'tool_failure', providerFailureKind: 'tool_failure', pauseUntilMs: null };
  }
  if (
    lower.includes('econnreset')
    || lower.includes('econnrefused')
    || lower.includes('socket hang up')
    || lower.includes('network error')
    || lower.includes('transport')
  ) {
    return { retryClass: 'transient_error', providerFailureKind: 'transport_error', pauseUntilMs: now() + 5 * 60 * 1000 };
  }
  return { retryClass: 'transient_error', providerFailureKind: 'transport_error', pauseUntilMs: now() + 5 * 60 * 1000 };
}
