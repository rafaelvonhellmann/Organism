import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client, Row } from '@libsql/client';
import { getClient, ensureTables } from './db';

function n(value: unknown): number {
  return Number(value) || 0;
}

function s(value: unknown): string {
  return value == null ? '' : String(value);
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
  const requiredConsecutiveRuns = 20;

  if (!client) {
    return {
      projectId,
      autonomyMode,
      requiredConsecutiveRuns,
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
            ORDER BY updated_at DESC
            LIMIT 50`,
      args: [projectId],
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
              AND provider_failure_kind != 'none'`,
      args: [projectId],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM run_sessions
            WHERE project_id = ?
              AND status IN ('pending', 'running', 'paused', 'retry_scheduled')`,
      args: [projectId],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM interrupts i
            JOIN run_sessions r ON r.id = i.run_id
            WHERE r.project_id = ? AND i.status = 'pending'`,
      args: [projectId],
    }),
    client.execute({
      sql: `SELECT COUNT(*) as c
            FROM approvals a
            JOIN run_sessions r ON r.id = a.run_id
            WHERE r.project_id = ? AND a.status = 'pending'`,
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

  const blockers: string[] = [];
  if (consecutiveHealthyRuns < requiredConsecutiveRuns) {
    blockers.push(`Needs ${requiredConsecutiveRuns - consecutiveHealthyRuns} more consecutive healthy runs`);
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

function readDaemonStatus() {
  const statusPath = resolve(STATE_DIR, 'daemon-status.json');
  if (!existsSync(statusPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as {
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
      version?: string;
    };
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
      version: raw.version ?? null,
    };
  } catch {
    return null;
  }
}

export async function getRuntimeSnapshot(projectId?: string) {
  await ensureTables();
  const client = getClient();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const projectArgs = projectId ? [projectId] : [];

  const [goalsRows, runsRows, interruptsRows, approvalsRows, eventsRows] = await Promise.all([
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
      `SELECT i.*
       FROM interrupts i
       JOIN run_sessions r ON r.id = i.run_id
       ${projectId ? 'WHERE r.project_id = ?' : ''}
       ORDER BY i.created_at DESC LIMIT 20`,
      projectArgs,
    ),
    execute(
      client,
      `SELECT a.*
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
  ]);

  const runs = runsRows.map(formatRun);
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

  const compareTargets = readCompareTargets();
  const autonomy = projectId
    ? [await getProjectAutonomyHealthSnapshot(client, projectId)]
    : await Promise.all(compareTargets.map((target) => getProjectAutonomyHealthSnapshot(client, target.projectId)));

  return {
    goals: goalsRows.map(formatGoal),
    runs: runs.map((run) => ({
      ...run,
      steps: stepsByRun.get(run.id) ?? [],
    })),
    interrupts: interruptsRows.map(formatInterrupt),
    approvals: approvalsRows.map(formatApproval),
    recentEvents: eventsRows.map(formatEvent).reverse(),
    compareTargets,
    autonomy,
    daemon: readDaemonStatus(),
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
