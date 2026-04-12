import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client, Row } from '@libsql/client';
import { getClient, ensureTables } from './db';

function n(value: unknown): number {
  return Number(value) || 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('en-AU', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function tryParse(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function workspacePath(...segments: string[]): string {
  const direct = resolve(process.cwd(), ...segments);
  if (existsSync(direct)) return direct;
  return resolve(process.cwd(), '..', '..', ...segments);
}

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const STATE_DIR = process.env.ORGANISM_STATE_DIR ?? resolve(HOME, '.organism', 'state');
const DEFAULT_CORE_AGENTS = ['ceo', 'product-manager', 'engineering', 'devops', 'quality-agent', 'security-audit', 'legal', 'quality-guardian', 'codex-review'];
const ACTIVE_RUN_STALE_MS = 20 * 60 * 1000;
const FINAL_GRADUATION_RUNS = 20;
const ROLLOUT_STAGES = [
  { stage: 'bounded', label: 'bounded autonomy', threshold: 3 },
  { stage: 'deploy_ready', label: 'low-risk deploys', threshold: 5 },
  { stage: 'graduated', label: 'full graduation', threshold: FINAL_GRADUATION_RUNS },
] as const;
const USEFUL_ARTIFACT_KINDS = new Set(['patch', 'verification', 'report', 'deployment']);
const NON_TERMINAL_STATUSES = new Set(['pending', 'running', 'paused', 'retry_scheduled']);

function readProjectConfig(projectId: string): {
  autonomyMode: string;
  coreAgents: string[];
} {
  const configPath = workspacePath('knowledge', 'projects', projectId, 'config.json');
  if (!existsSync(configPath)) {
    return { autonomyMode: 'stabilization', coreAgents: DEFAULT_CORE_AGENTS };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      autonomyMode?: string;
      agents?: { generalist?: string[] };
    };
    return {
      autonomyMode: raw.autonomyMode ?? 'stabilization',
      coreAgents: Array.isArray(raw.agents?.generalist) && raw.agents.generalist.length > 0
        ? raw.agents.generalist
        : DEFAULT_CORE_AGENTS,
    };
  } catch {
    return { autonomyMode: 'stabilization', coreAgents: DEFAULT_CORE_AGENTS };
  }
}

async function getProjectAutonomyHealthSnapshot(client: Client | null, projectId: string) {
  const { autonomyMode, coreAgents } = readProjectConfig(projectId);
  const requiredConsecutiveRuns = FINAL_GRADUATION_RUNS;

  if (!client) {
    return {
      projectId,
      autonomyMode,
      requiredConsecutiveRuns,
      rolloutStage: 'stabilizing',
      nextRolloutStage: 'bounded',
      nextRolloutThreshold: 3,
      nextRolloutLabel: 'bounded autonomy',
      consecutiveHealthyRuns: 0,
      recentCompletedRuns: 0,
      recentProviderFailures: 0,
      activeRuns: 0,
      pendingInterrupts: 0,
      pendingApprovals: 0,
      rolloutReady: false,
      blockers: ['Database not connected'],
      coreAgents,
    };
  }

  const [
    recentRunsResult,
    completedResult,
    providerFailuresResult,
    activeRunsResult,
    pendingInterruptsResult,
    pendingApprovalsResult,
  ] = await Promise.all([
    client.execute({
      sql: `SELECT status, provider_failure_kind
            FROM run_sessions
            WHERE project_id = ?
              AND NOT (goal_id LIKE 'goal-%' AND status IN ('pending', 'running', 'paused', 'retry_scheduled'))
              AND NOT (status IN ('pending', 'running', 'paused', 'retry_scheduled') AND updated_at < ?)
            ORDER BY updated_at DESC
            LIMIT 50`,
      args: [projectId, Date.now() - ACTIVE_RUN_STALE_MS],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM run_sessions
            WHERE project_id = ? AND status = 'completed'`,
      args: [projectId],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM run_sessions
            WHERE project_id = ?
              AND provider_failure_kind IS NOT NULL
              AND provider_failure_kind != ''
              AND provider_failure_kind != 'none'
              AND goal_id NOT LIKE 'goal-%'`,
      args: [projectId],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM run_sessions
            WHERE project_id = ?
              AND status IN ('pending', 'running', 'paused', 'retry_scheduled')
              AND updated_at >= ?
              AND goal_id NOT LIKE 'goal-%'`,
      args: [projectId, Date.now() - ACTIVE_RUN_STALE_MS],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM interrupts i
            JOIN run_sessions r ON r.id = i.run_id
            WHERE r.project_id = ?
              AND i.status = 'pending'
              AND r.status != 'completed'
              AND NOT (i.type = 'approval' AND i.summary LIKE 'Deploy is still gated%')`,
      args: [projectId],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM approvals a
            JOIN run_sessions r ON r.id = a.run_id
            WHERE r.project_id = ?
              AND a.status = 'pending'
              AND r.status != 'completed'
              AND a.action != 'deploy'`,
      args: [projectId],
    }),
  ]);

  let consecutiveHealthyRuns = 0;
  for (const row of recentRunsResult.rows) {
    const status = s(row.status);
    const providerFailureKind = s(row.provider_failure_kind);
    if (status !== 'completed' || (providerFailureKind && providerFailureKind !== 'none')) break;
    consecutiveHealthyRuns += 1;
  }

  const recentCompletedRuns = n(completedResult.rows[0]?.c);
  const recentProviderFailures = n(providerFailuresResult.rows[0]?.c);
  const activeRuns = n(activeRunsResult.rows[0]?.c);
  const pendingInterrupts = n(pendingInterruptsResult.rows[0]?.c);
  const pendingApprovals = n(pendingApprovalsResult.rows[0]?.c);
  const rolloutStage = ROLLOUT_STAGES.reduce<'stabilizing' | 'bounded' | 'deploy_ready' | 'graduated'>(
    (stage, milestone) => (consecutiveHealthyRuns >= milestone.threshold ? milestone.stage : stage),
    'stabilizing',
  );
  const nextRollout = ROLLOUT_STAGES.find((milestone) => consecutiveHealthyRuns < milestone.threshold) ?? null;

  const blockers: string[] = [];
  if (nextRollout) {
    blockers.push(`Needs ${nextRollout.threshold - consecutiveHealthyRuns} more consecutive healthy runs for ${nextRollout.label}`);
  }
  if (recentProviderFailures > 0) {
    blockers.push('Recent provider failures still present in the last 50 runs');
  }
  if (pendingInterrupts > 0) {
    blockers.push('Pending interrupts need resolution');
  }
  if (pendingApprovals > 0) {
    blockers.push('Pending approvals still exist');
  }

  return {
    projectId,
    autonomyMode,
    requiredConsecutiveRuns,
    rolloutStage,
    nextRolloutStage: nextRollout?.stage ?? null,
    nextRolloutThreshold: nextRollout?.threshold ?? null,
    nextRolloutLabel: nextRollout?.label ?? null,
    consecutiveHealthyRuns,
    recentCompletedRuns,
    recentProviderFailures,
    activeRuns,
    pendingInterrupts,
    pendingApprovals,
    rolloutReady: blockers.length === 0,
    blockers,
    coreAgents,
  };
}

function formatGoal(row: Row) {
  return {
    id: s(row.id),
    projectId: s(row.project_id),
    title: s(row.title),
    description: s(row.description),
    status: s(row.status),
    sourceKind: s(row.source_kind),
    workflowKind: s(row.workflow_kind),
    latestRunId: row.latest_run_id ? s(row.latest_run_id) : null,
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
  };
}

type RuntimeGoal = ReturnType<typeof formatGoal>;

function formatRun(row: Row) {
  return {
    id: s(row.id),
    goalId: s(row.goal_id),
    projectId: s(row.project_id),
    agent: s(row.agent),
    workflowKind: s(row.workflow_kind),
    status: s(row.status),
    retryClass: s(row.retry_class),
    retryAt: row.retry_at != null ? n(row.retry_at) : null,
    providerFailureKind: s(row.provider_failure_kind),
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
    completedAt: row.completed_at != null ? n(row.completed_at) : null,
  };
}

type RuntimeRun = ReturnType<typeof formatRun>;
type RuntimeStep = ReturnType<typeof formatStep>;

function isSyntheticGoalId(goalId: string): boolean {
  return /^goal-\d+$/i.test(goalId);
}

function isRunNonTerminal(run: RuntimeRun): boolean {
  return NON_TERMINAL_STATUSES.has(run.status);
}

function isRunStale(run: RuntimeRun, now = Date.now()): boolean {
  return isRunNonTerminal(run) && (now - run.updatedAt) > ACTIVE_RUN_STALE_MS;
}

function runGroupKey(run: RuntimeRun): string {
  return `${run.projectId}::${run.goalId}::${run.agent}::${run.workflowKind}`;
}

function buildVisibleRuns(
  runs: RuntimeRun[],
  goals: Array<ReturnType<typeof formatGoal>>,
): RuntimeRun[] {
  const now = Date.now();
  const goalIds = new Set(goals.map((goal) => goal.id));
  const latestTerminalByGroup = new Map<string, number>();
  const latestNonTerminalByGroup = new Map<string, RuntimeRun>();

  for (const run of runs) {
    const key = runGroupKey(run);
    if (!isRunNonTerminal(run)) {
      const previous = latestTerminalByGroup.get(key) ?? 0;
      if (run.updatedAt > previous) {
        latestTerminalByGroup.set(key, run.updatedAt);
      }
      continue;
    }

    const existing = latestNonTerminalByGroup.get(key);
    if (!existing || run.updatedAt > existing.updatedAt) {
      latestNonTerminalByGroup.set(key, run);
    }
  }

  return runs.filter((run) => {
    if (!isRunNonTerminal(run)) {
      return true;
    }

    const stale = isRunStale(run, now);
    const newestActiveRun = latestNonTerminalByGroup.get(runGroupKey(run));
    if (newestActiveRun && newestActiveRun.id !== run.id) return false;

    const superseded = (latestTerminalByGroup.get(runGroupKey(run)) ?? 0) > run.updatedAt;
    const syntheticGoal = isSyntheticGoalId(run.goalId);

    if (stale) return false;
    if (syntheticGoal && superseded) return false;
    if (superseded) return false;
    return true;
  });
}

function goalGroupKey(goal: RuntimeGoal): string {
  return `${goal.projectId}::${goal.workflowKind}::${goal.title}`;
}

function buildVisibleGoals(goals: RuntimeGoal[], runs: RuntimeRun[]): RuntimeGoal[] {
  const now = Date.now();
  const activeGoalIds = new Set(
    runs
      .filter((run) => isRunNonTerminal(run) && !isRunStale(run, now))
      .map((run) => run.goalId),
  );
  const latestByGroup = new Map<string, RuntimeGoal>();

  for (const goal of goals) {
    const key = goalGroupKey(goal);
    const existing = latestByGroup.get(key);
    if (!existing || goal.updatedAt > existing.updatedAt) {
      latestByGroup.set(key, goal);
    }
  }

  return goals.filter((goal) => {
    const terminal = !NON_TERMINAL_STATUSES.has(goal.status);
    if (terminal) return true;
    if (activeGoalIds.has(goal.id)) return true;
    if (now - goal.updatedAt > ACTIVE_RUN_STALE_MS) return false;
    return latestByGroup.get(goalGroupKey(goal))?.id === goal.id;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildDurationKey(projectId: string, agent: string, workflowKind: string): string {
  return `${projectId}::${agent}::${workflowKind}`;
}

function estimateRunProgress(
  run: RuntimeRun,
  steps: RuntimeStep[],
  exactDurations: Map<string, number>,
  fallbackDurations: Map<string, number>,
) {
  const now = Date.now();
  const elapsedMs = Math.max(0, (run.completedAt ?? now) - run.createdAt);
  const exactKey = buildDurationKey(run.projectId, run.agent, run.workflowKind);
  const fallbackKey = `${run.agent}::${run.workflowKind}`;
  const estimatedDurationMs = exactDurations.get(exactKey) ?? fallbackDurations.get(fallbackKey) ?? null;

  const completedSteps = steps.filter((step) => step.status === 'completed').length;
  const hasRunningStep = steps.some((step) => step.status === 'running');
  const stepPct = steps.length > 0
    ? clamp(
        Math.round(((completedSteps + (hasRunningStep ? 0.35 : 0)) / Math.max(steps.length, 1)) * 100),
        5,
        run.status === 'completed' ? 100 : 95,
      )
    : null;
  const historicalPct = estimatedDurationMs && estimatedDurationMs > 0
    ? clamp(Math.round((elapsedMs / estimatedDurationMs) * 100), 5, run.status === 'completed' ? 100 : 95)
    : null;
  const progressPct = run.status === 'completed'
    ? 100
    : stepPct != null && historicalPct != null
      ? Math.max(stepPct, historicalPct)
      : stepPct ?? historicalPct;
  const etaMs = run.status === 'completed'
    ? 0
    : estimatedDurationMs != null
      ? Math.max(0, estimatedDurationMs - elapsedMs)
      : null;

  return {
    elapsedMs,
    estimatedDurationMs,
    etaMs,
    progressPct,
    progressBasis: stepPct != null ? 'steps' : historicalPct != null ? 'historical' : 'none',
  };
}

function formatStep(row: Row) {
  return {
    id: s(row.id),
    runId: s(row.run_id),
    name: s(row.name),
    status: s(row.status),
    detail: row.detail ? s(row.detail) : null,
    createdAt: n(row.created_at),
    updatedAt: n(row.updated_at),
    completedAt: row.completed_at != null ? n(row.completed_at) : null,
  };
}

function formatInterrupt(row: Row) {
  return {
    id: s(row.id),
    runId: s(row.run_id),
    type: s(row.type),
    status: s(row.status),
    summary: s(row.summary),
    detail: row.detail ? s(row.detail) : null,
    createdAt: n(row.created_at),
    resolvedAt: row.resolved_at != null ? n(row.resolved_at) : null,
  };
}

function formatApproval(row: Row) {
  return {
    id: s(row.id),
    runId: s(row.run_id),
    action: s(row.action),
    status: s(row.status),
    requestedBy: s(row.requested_by),
    requestedAt: n(row.requested_at),
    decidedAt: row.decided_at != null ? n(row.decided_at) : null,
    decidedBy: row.decided_by ? s(row.decided_by) : null,
    reason: row.reason ? s(row.reason) : null,
  };
}

function formatEvent(row: Row) {
  return {
    id: n(row.id),
    runId: s(row.run_id),
    goalId: s(row.goal_id),
    eventType: s(row.event_type),
    payload: tryParse(row.payload),
    ts: n(row.ts),
  };
}

function summarizeTaskOutput(raw: unknown): string | null {
  const parsed = tryParse(raw);
  if (parsed == null) return null;
  if (typeof parsed === 'string') return parsed.slice(0, 1200);
  if (typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const preferred = [record.summary, record.review, record.text, record.verdict, record.result]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof preferred === 'string') return preferred.slice(0, 1200);
    return JSON.stringify(parsed, null, 2).slice(0, 1200);
  }
  return String(parsed).slice(0, 1200);
}

function formatArtifact(row: Row) {
  return {
    id: s(row.id),
    runId: s(row.run_id),
    goalId: s(row.goal_id),
    kind: s(row.kind),
    title: s(row.title),
    path: row.path ? s(row.path) : null,
    content: row.content ? s(row.content) : null,
    createdAt: n(row.created_at),
  };
}

function formatRecentOutput(row: Row) {
  return {
    id: s(row.id),
    agent: s(row.agent),
    status: s(row.status),
    lane: s(row.lane),
    description: s(row.description),
    summary: summarizeTaskOutput(row.output),
    completedAt: row.completed_at != null ? n(row.completed_at) : null,
    createdAt: n(row.created_at),
  };
}

function buildUsefulOutputs(
  recentOutputs: Array<ReturnType<typeof formatRecentOutput>>,
  artifacts: Array<ReturnType<typeof formatArtifact>>,
) {
  const items = [
    ...artifacts
      .filter((artifact) => USEFUL_ARTIFACT_KINDS.has(artifact.kind))
      .map((artifact) => ({
        id: artifact.id,
        source: 'artifact' as const,
        kind: artifact.kind,
        title: artifact.title,
        summary: trimUsefulSummary(artifact.content),
        createdAt: artifact.createdAt,
        meta: artifact.path ? `${artifact.kind} · ${artifact.path}` : artifact.kind,
      })),
    ...recentOutputs
      .filter((output) => output.status === 'completed' || output.status === 'awaiting_review')
      .map((output) => ({
        id: output.id,
        source: 'task' as const,
        kind: 'task_output',
        title: output.description,
        summary: trimUsefulSummary(output.summary),
        createdAt: output.completedAt ?? output.createdAt,
        meta: `${output.agent} · ${output.status}`,
      })),
  ].sort((left, right) => right.createdAt - left.createdAt);

  const seen = new Set<string>();
  const unique = [];
  for (const item of items) {
    const key = `${item.source}::${item.kind}::${item.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= 4) break;
  }

  return unique;
}

function trimUsefulSummary(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 320 ? `${compact.slice(0, 317).trimEnd()}...` : compact;
}

interface RuntimeBlockerRow {
  id: string;
  goal_id: string | null;
  agent: string;
  status: string;
  workflow_kind: string | null;
  description: string;
  error: string | null;
  provider_failure_kind: string | null;
  retry_at: number | null;
  created_at: number;
  completed_at: number | null;
}

function isReviewLaneBlocker(row: RuntimeBlockerRow): boolean {
  return row.workflow_kind === 'review'
    || row.workflow_kind === 'validate'
    || ['quality-agent', 'quality-guardian', 'codex-review', 'grill-me', 'legal', 'security-audit'].includes(row.agent);
}

function buildCurrentBlockers(rows: RuntimeBlockerRow[], runs: RuntimeRun[]) {
  const activeRuns = runs.filter((run) => run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled');
  const latestExecutionByGoal = new Map<string, number>();

  for (const row of rows) {
    if (!row.goal_id) continue;
    if (row.workflow_kind !== 'implement' && row.workflow_kind !== 'recover' && row.workflow_kind !== 'ship') continue;
    const latestExecution = latestExecutionByGoal.get(row.goal_id) ?? 0;
    if (row.created_at > latestExecution) {
      latestExecutionByGoal.set(row.goal_id, row.created_at);
    }
  }

  const isSupersededReviewDebt = (row: RuntimeBlockerRow): boolean => {
    if (!row.goal_id || !isReviewLaneBlocker(row)) return false;
    const latestExecution = latestExecutionByGoal.get(row.goal_id) ?? 0;
    return latestExecution > row.created_at;
  };

  const pausedReview = rows.filter((row) => row.status === 'paused' && isReviewLaneBlocker(row) && !isSupersededReviewDebt(row));
  const retryingReview = rows.filter((row) => row.status === 'retry_scheduled' && isReviewLaneBlocker(row) && !isSupersededReviewDebt(row));
  const awaitingReview = rows.filter((row) => row.status === 'awaiting_review');
  const pausedExecution = rows.filter((row) => row.status === 'paused' && !isReviewLaneBlocker(row));
  const blockers: Array<{
    kind: 'review_paused' | 'review_retry' | 'awaiting_review' | 'execution_paused';
    severity: 'warning' | 'critical';
    title: string;
    detail: string;
    count: number;
    taskIds: string[];
  }> = [];

  if (pausedReview.length > 0) {
    const latest = pausedReview[0]!;
    const agents = [...new Set(pausedReview.map((row) => row.agent))].join(', ');
    blockers.push({
      kind: 'review_paused',
      severity: activeRuns.length === 0 ? 'critical' : 'warning',
      title: `${pausedReview.length} paused review task${pausedReview.length === 1 ? '' : 's'} blocking progress`,
      detail: `The current blocker is validation/review work, not the earlier engineering timeout. Affected agents: ${agents}. Latest error: ${latest.error ?? latest.provider_failure_kind ?? 'unknown'}.`,
      count: pausedReview.length,
      taskIds: pausedReview.map((row) => row.id),
    });
  }

  if (retryingReview.length > 0) {
    const latest = retryingReview[0]!;
    blockers.push({
      kind: 'review_retry',
      severity: activeRuns.length === 0 ? 'warning' : 'warning',
      title: `${retryingReview.length} review task${retryingReview.length === 1 ? '' : 's'} scheduled to retry`,
      detail: `Review auto-heal has already rescheduled these tasks. Next retry: ${latest.retry_at ? formatTime(latest.retry_at) : 'soon'}.`,
      count: retryingReview.length,
      taskIds: retryingReview.map((row) => row.id),
    });
  }

  if (awaitingReview.length > 0) {
    blockers.push({
      kind: 'awaiting_review',
      severity: 'warning',
      title: `${awaitingReview.length} task${awaitingReview.length === 1 ? '' : 's'} awaiting review`,
      detail: `These tasks have finished execution but are waiting in the review lane. They are not active runs right now.`,
      count: awaitingReview.length,
      taskIds: awaitingReview.map((row) => row.id),
    });
  }

  if (pausedExecution.length > 0) {
    const latest = pausedExecution[0]!;
    blockers.push({
      kind: 'execution_paused',
      severity: 'warning',
      title: `${pausedExecution.length} paused execution task${pausedExecution.length === 1 ? '' : 's'}`,
      detail: `Execution work is paused separately from the review lane. Latest issue: ${latest.error ?? latest.provider_failure_kind ?? latest.description}.`,
      count: pausedExecution.length,
      taskIds: pausedExecution.map((row) => row.id),
    });
  }

  return blockers;
}

async function execute(client: Client | null, sql: string, args: Array<string | number> = []) {
  if (!client) return [];
  const result = await client.execute({ sql, args });
  return result.rows;
}

function readCompareTargets() {
  const projectsDir = workspacePath('knowledge', 'projects');
  if (!existsSync(projectsDir)) return [];

  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const configPath = resolve(projectsDir, entry.name, 'config.json');
      if (!existsSync(configPath)) return [];
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
          id?: string;
          name?: string;
          deployTargets?: Array<{ name?: string; url?: string; project?: string }>;
        };
        const deployTargets = Array.isArray(config.deployTargets) ? config.deployTargets : [];
        return deployTargets.map((target) => ({
          projectId: config.id ?? entry.name,
          label: config.name ?? entry.name,
          current: {
            name: target.name ?? entry.name,
            project: target.project ?? entry.name,
            url: target.url ?? null,
          },
          forked: {
            name: `${target.name ?? entry.name}-v2`,
            project: `${target.project ?? entry.name}-v2`,
            url: target.url ? target.url.replace('.vercel.app', '-v2.vercel.app') : null,
          },
        }));
      } catch {
        return [];
      }
    });
}

function formatDaemonStatus(raw: {
  runtime?: { modelBackend?: string | null; codeExecutor?: string | null; webSearchAvailable?: boolean };
  rateLimitStatus?: { limited?: boolean; resetsAt?: string | null; usagePct?: number };
  readiness?: Array<{
    projectId?: string;
    cleanWorktree?: boolean;
    workspaceMode?: string;
    deployUnlocked?: boolean;
    completedRuns?: number;
    initialWorkflowLimit?: number;
    initialAllowedWorkflows?: string[];
    initialWorkflowGuardActive?: boolean;
    prAuthReady?: boolean;
    prAuthMode?: string;
    vercelAuthReady?: boolean;
    vercelAuthMode?: string;
    blockers?: string[];
    warnings?: string[];
    minimax?: { enabled?: boolean; ready?: boolean; allowedCommands?: string[] };
  }>;
  startedAt?: string;
  updatedAt?: string;
  version?: string;
} | null, meta?: { observedAt?: number | null; source?: 'file' | 'db' }) {
  if (!raw) return null;
  return {
    runtime: {
      modelBackend: raw.runtime?.modelBackend ?? null,
      codeExecutor: raw.runtime?.codeExecutor ?? null,
      webSearchAvailable: raw.runtime?.webSearchAvailable ?? false,
    },
    rateLimitStatus: {
      limited: raw.rateLimitStatus?.limited ?? false,
      resetsAt: raw.rateLimitStatus?.resetsAt ?? null,
      usagePct: raw.rateLimitStatus?.usagePct ?? 0,
    },
    readiness: Array.isArray(raw.readiness)
      ? raw.readiness.map((item) => ({
        projectId: item.projectId ?? '',
        cleanWorktree: item.cleanWorktree ?? false,
        workspaceMode: item.workspaceMode ?? 'direct',
        deployUnlocked: item.deployUnlocked ?? false,
        completedRuns: item.completedRuns ?? 0,
        initialWorkflowLimit: item.initialWorkflowLimit ?? 0,
        initialAllowedWorkflows: Array.isArray(item.initialAllowedWorkflows) ? item.initialAllowedWorkflows : [],
        initialWorkflowGuardActive: item.initialWorkflowGuardActive ?? false,
        prAuthReady: item.prAuthReady ?? false,
        prAuthMode: item.prAuthMode ?? 'none',
        vercelAuthReady: item.vercelAuthReady ?? false,
        vercelAuthMode: item.vercelAuthMode ?? 'none',
        blockers: Array.isArray(item.blockers) ? item.blockers : [],
        warnings: Array.isArray(item.warnings) ? item.warnings : [],
        minimax: {
          enabled: item.minimax?.enabled ?? false,
          ready: item.minimax?.ready ?? false,
          allowedCommands: Array.isArray(item.minimax?.allowedCommands) ? item.minimax!.allowedCommands! : [],
        },
      }))
      : [],
    startedAt: raw.startedAt ?? null,
    updatedAt: raw.updatedAt ?? (meta?.observedAt ? new Date(meta.observedAt).toISOString() : null),
    observedAt: meta?.observedAt ?? null,
    source: meta?.source ?? 'db',
    version: raw.version ?? null,
  };
}

function readDaemonStatusFromFile() {
  const statusPath = resolve(STATE_DIR, 'daemon-status.json');
  if (!existsSync(statusPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statusPath, 'utf8'));
    return formatDaemonStatus(raw, {
      observedAt: Math.round(statSync(statusPath).mtimeMs),
      source: 'file',
    });
  } catch {
    return null;
  }
}

async function readDaemonStatusFromDb(client: Client | null) {
  if (!client) return null;
  try {
    const result = await client.execute(`SELECT payload, updated_at FROM daemon_status WHERE id = 'primary' LIMIT 1`);
    if (result.rows.length === 0 || !result.rows[0].payload) return null;
    const raw = JSON.parse(String(result.rows[0].payload));
    return formatDaemonStatus(raw, {
      observedAt: result.rows[0].updated_at != null ? n(result.rows[0].updated_at) : null,
      source: 'db',
    });
  } catch {
    return null;
  }
}

export async function getRuntimeSnapshot(projectId?: string) {
  await ensureTables();
  const client = getClient();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const projectArgs = projectId ? [projectId] : [];
  const taskOutputFilter = projectId ? 'WHERE project_id = ? AND output IS NOT NULL' : 'WHERE output IS NOT NULL';
  const blockerFilter = projectId
    ? `WHERE project_id = ? AND status IN ('in_progress', 'paused', 'retry_scheduled', 'awaiting_review')`
    : `WHERE status IN ('in_progress', 'paused', 'retry_scheduled', 'awaiting_review')`;

  const [goalsRows, runsRows, interruptsRows, approvalsRows, eventsRows, artifactsRows, outputRows, blockerRows] = await Promise.all([
    execute(
      client,
      `SELECT * FROM goals ${projectFilter} ORDER BY updated_at DESC LIMIT 20`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT * FROM run_sessions ${projectFilter} ORDER BY updated_at DESC LIMIT 20`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT i.*, r.status as run_status
       FROM interrupts i
       JOIN run_sessions r ON r.id = i.run_id
       ${projectId ? 'WHERE r.project_id = ?' : ''}
       ORDER BY i.created_at DESC LIMIT 20`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT a.*, r.status as run_status
       FROM approvals a
       JOIN run_sessions r ON r.id = a.run_id
       ${projectId ? 'WHERE r.project_id = ?' : ''}
       ORDER BY a.requested_at DESC LIMIT 20`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT e.*
       FROM runtime_events e
       JOIN goals g ON g.id = e.goal_id
       ${projectId ? 'WHERE g.project_id = ?' : ''}
       ORDER BY e.id DESC LIMIT 80`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT a.*
       FROM artifacts a
       JOIN run_sessions r ON r.id = a.run_id
       ${projectId ? 'WHERE r.project_id = ?' : ''}
       ORDER BY a.created_at DESC LIMIT 20`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT id, agent, status, lane, description, output, completed_at, created_at
       FROM tasks
      ${taskOutputFilter}
       ORDER BY COALESCE(completed_at, created_at) DESC
       LIMIT 12`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT id, goal_id, agent, status, workflow_kind, description, error, provider_failure_kind, retry_at, created_at, completed_at
       FROM tasks
       ${blockerFilter}
       ORDER BY COALESCE(completed_at, created_at) DESC
       LIMIT 24`,
      projectArgs,
    ),
  ]);

  const rawGoals = goalsRows.map(formatGoal);
  const runs = buildVisibleRuns(runsRows.map(formatRun), rawGoals);
  const formattedGoals = buildVisibleGoals(rawGoals, runs);
  const runIds = runs.map((run) => run.id);

  let stepsRows: Row[] = [];
  if (client && runIds.length > 0) {
    const placeholders = runIds.map(() => '?').join(', ');
    stepsRows = await execute(
      client,
      `SELECT * FROM run_steps WHERE run_id IN (${placeholders}) ORDER BY created_at ASC`,
      runIds,
    ) as Row[];
  }

  const stepsByRun = new Map<string, ReturnType<typeof formatStep>[]>();
  for (const row of stepsRows) {
    const step = formatStep(row);
    const list = stepsByRun.get(step.runId) ?? [];
    list.push(step);
    stepsByRun.set(step.runId, list);
  }

  const [exactDurationRows, fallbackDurationRows] = client
    ? await Promise.all([
        execute(
          client,
          `SELECT project_id, agent, workflow_kind, AVG(completed_at - created_at) as avg_duration_ms
           FROM run_sessions
           WHERE status = 'completed'
             AND completed_at IS NOT NULL
             AND completed_at > created_at
           GROUP BY project_id, agent, workflow_kind`,
        ),
        execute(
          client,
          `SELECT agent, workflow_kind, AVG(completed_at - created_at) as avg_duration_ms
           FROM run_sessions
           WHERE status = 'completed'
             AND completed_at IS NOT NULL
             AND completed_at > created_at
           GROUP BY agent, workflow_kind`,
        ),
      ])
    : [[], []];

  const exactDurations = new Map<string, number>();
  for (const row of exactDurationRows) {
    const avgDuration = n(row.avg_duration_ms);
    if (avgDuration > 0) {
      exactDurations.set(buildDurationKey(s(row.project_id), s(row.agent), s(row.workflow_kind)), avgDuration);
    }
  }

  const fallbackDurations = new Map<string, number>();
  for (const row of fallbackDurationRows) {
    const avgDuration = n(row.avg_duration_ms);
    if (avgDuration > 0) {
      fallbackDurations.set(`${s(row.agent)}::${s(row.workflow_kind)}`, avgDuration);
    }
  }

  const compareTargets = readCompareTargets();
  const autonomy = projectId
    ? [await getProjectAutonomyHealthSnapshot(client, projectId)]
    : await Promise.all(compareTargets.map((target) => getProjectAutonomyHealthSnapshot(client, target.projectId)));
  const daemon = readDaemonStatusFromFile() ?? await readDaemonStatusFromDb(client);
  const visibleInterrupts = interruptsRows.filter((row) => {
    const pending = s(row.status) === 'pending';
    const deployGate = s(row.type) === 'approval' && s(row.summary).startsWith('Deploy is still gated');
    const runCompleted = s(row.run_status) === 'completed';
    return !(pending && deployGate && runCompleted);
  });
  const visibleApprovals = approvalsRows.filter((row) => {
    const pending = s(row.status) === 'pending';
    const deployGate = s(row.action) === 'deploy';
    const runCompleted = s(row.run_status) === 'completed';
    return !(pending && deployGate && runCompleted);
  });
  const formattedArtifacts = artifactsRows.map(formatArtifact);
  const formattedRecentOutputs = outputRows.map(formatRecentOutput);

  return {
    generatedAt: Date.now(),
    goals: formattedGoals,
    runs: runs.map((run) => ({
      ...run,
      steps: stepsByRun.get(run.id) ?? [],
      ...estimateRunProgress(run, stepsByRun.get(run.id) ?? [], exactDurations, fallbackDurations),
    })),
    interrupts: visibleInterrupts.map(formatInterrupt),
    approvals: visibleApprovals.map(formatApproval),
    artifacts: formattedArtifacts,
    recentOutputs: formattedRecentOutputs,
    usefulOutputs: buildUsefulOutputs(formattedRecentOutputs, formattedArtifacts),
    blockers: buildCurrentBlockers(blockerRows as unknown as RuntimeBlockerRow[], runs),
    recentEvents: eventsRows.map(formatEvent).reverse(),
    compareTargets,
    autonomy,
    daemon,
  };
}

export async function getRuntimeEvents(options: {
  projectId?: string;
  afterId?: number;
  limit?: number;
}) {
  await ensureTables();
  const client = getClient();
  if (!client) return { events: [], latestId: options.afterId ?? 0 };

  const conditions: string[] = [];
  const args: Array<string | number> = [];

  if (options.projectId) {
    conditions.push('g.project_id = ?');
    args.push(options.projectId);
  }
  if (options.afterId != null) {
    conditions.push('e.id > ?');
    args.push(options.afterId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? 50;

  const rows = await execute(
    client,
    `SELECT e.*
     FROM runtime_events e
     JOIN goals g ON g.id = e.goal_id
     ${where}
     ORDER BY e.id ASC
     LIMIT ${limit}`,
    args,
  );

  const events = rows.map(formatEvent);
  return {
    events,
    latestId: events.length > 0 ? events[events.length - 1].id : (options.afterId ?? 0),
  };
}
