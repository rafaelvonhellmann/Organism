import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client, Row } from '@libsql/client';
import { getClient, ensureTables } from './db';
import { getProjectAutonomyHealth } from '../../../../packages/core/src/autonomy-governor';

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

  return {
    goals: goalsRows.map(formatGoal),
    runs: runs.map((run) => ({
      ...run,
      steps: stepsByRun.get(run.id) ?? [],
    })),
    interrupts: interruptsRows.map(formatInterrupt),
    approvals: approvalsRows.map(formatApproval),
    recentEvents: eventsRows.map(formatEvent).reverse(),
    compareTargets: readCompareTargets(),
    autonomy: projectId ? [getProjectAutonomyHealth(projectId)] : readCompareTargets().map((target) => getProjectAutonomyHealth(target.projectId)),
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
