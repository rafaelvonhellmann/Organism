import * as http from 'http';
import * as fs from 'fs';
import { statSync } from 'fs';
import * as path from 'path';
import { getSystemStatus } from '../../core/src/orchestrator.js';
import { getSpendSummary, getSystemSpend, getTopCostAgents, getCostByLane, getHighestCostTasks, getBudgetOverruns } from '../../core/src/budget.js';
import { getPendingTasks, getDeadLetterTasks, getDb } from '../../core/src/task-queue.js';
import { readRecentForAgent } from '../../core/src/audit.js';
import { decideProjectStart } from '../../core/src/start-continue.js';
import { getProjectLaunchAudit } from '../../core/src/launch-audit.js';
import { STATE_DIR } from '../../shared/src/state-dir.js';
import { ensureDaemon } from '../../../scripts/ensure-services.js';

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '7391');
const HOSTED_DASHBOARD_URL = process.env.ORGANISM_DASHBOARD_URL ?? 'https://organism-hq.vercel.app';
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:7391',
  'http://127.0.0.1:7391',
  'https://organism-hq.vercel.app',
  'https://organism-hq-v2.vercel.app',
]);

let daemonWakePromise: Promise<void> | null = null;

function wakeDaemonInBackground(reason: string): void {
  if (daemonWakePromise) return;
  daemonWakePromise = ensureDaemon()
    .then(() => {
      console.log(`[Dashboard] Ensured daemon for ${reason}`);
    })
    .catch((error) => {
      console.error(`[Dashboard] Failed to ensure daemon for ${reason}:`, error);
    })
    .finally(() => {
      daemonWakePromise = null;
    });
}

// Dashboard HTML — single-page auto-refreshing status board
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<title>Organism Dashboard</title>
<style>
  body { font-family: monospace; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 4px; }
  .subtitle { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  th { color: #8b949e; text-align: left; padding: 4px 12px; border-bottom: 1px solid #21262d; }
  td { padding: 4px 12px; border-bottom: 1px solid #161b22; }
  .ok { color: #3fb950; }
  .warn { color: #d29922; }
  .crit { color: #f85149; }
  .idle { color: #8b949e; }
  .section { color: #58a6ff; margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
  .alert { background: #2d1b1b; border: 1px solid #f85149; border-radius: 4px; padding: 8px 12px; margin: 4px 0; }
  pre { background: #161b22; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 11px; }
</style>
</head>
<body>
<h1>Organism</h1>
<div class="subtitle" id="ts">Loading...</div>
<div id="content">Loading dashboard...</div>
<script>
  document.getElementById('ts').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
</script>
</body>
</html>`;

function buildDashboardData(projectFilter?: string) {
  try {
    const status = getSystemStatus(projectFilter);
    const spend = getSpendSummary(undefined, projectFilter);
    const systemTotal = getSystemSpend();
    const pending = getPendingTasks(undefined, projectFilter);
    const deadLetters = getDeadLetterTasks();

    return {
      systemTotal: systemTotal.toFixed(4),
      systemCap: process.env.SYSTEM_DAILY_CAP_USD ?? '50',
      pendingCount: pending.length,
      deadLetterCount: deadLetters.length,
      projectFilter: projectFilter ?? 'all',
      alerts: status.alerts,
      agents: spend.map((s) => ({
        name: s.agent,
        spent: `$${s.spent.toFixed(4)}`,
        cap: `$${s.cap.toFixed(2)}`,
        pct: s.pct.toFixed(0),
        status: s.pct > 90 ? 'crit' : s.pct > 80 ? 'warn' : s.pct > 0 ? 'ok' : 'idle',
      })),
      pending: pending.slice(0, 10).map((t) => ({
        id: t.id.slice(0, 8),
        agent: t.agent,
        lane: t.lane,
        project: t.projectId ?? 'organism',
        description: t.description.slice(0, 60),
      })),
      deadLetters: deadLetters.slice(0, 5).map((t) => ({
        id: t.id.slice(0, 8),
        agent: t.agent,
        project: t.projectId ?? 'organism',
        description: t.description.slice(0, 60),
        error: t.error,
      })),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

function getAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const allowedOrigin = getAllowedOrigin(req.headers.origin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Organism-Bridge');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

function redirectToHostedUi(req: http.IncomingMessage, res: http.ServerResponse): void {
  const requestUrl = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const target = new URL(requestUrl.pathname + requestUrl.search, HOSTED_DASHBOARD_URL);
  res.writeHead(302, { Location: target.toString() });
  res.end();
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function listDashboardActions(projectFilter?: string) {
  const rows = getDb()
    .prepare('SELECT id, action, payload, status, result, created_at, completed_at FROM dashboard_actions ORDER BY created_at DESC LIMIT 100')
    .all() as Array<Record<string, unknown>>;

  return rows.filter((row) => {
    if (!projectFilter) return true;
    try {
      const payload = row.payload ? JSON.parse(String(row.payload)) as { project?: string } : {};
      return payload.project === projectFilter;
    } catch {
      return false;
    }
  });
}

function enqueueDashboardAction(body: unknown) {
  const input = typeof body === 'object' && body !== null ? body as { action?: unknown; payload?: unknown } : {};
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};

  if (!action) {
    return { ok: false, status: 400, error: 'Missing action' };
  }

  const projectRequired = action === 'command' || action === 'review' || action === 'start';
  const project = payload && typeof payload === 'object' && 'project' in payload
    ? typeof (payload as { project?: unknown }).project === 'string'
      ? (payload as { project: string }).project.trim()
      : ''
    : '';

  if (projectRequired && !project) {
    return { ok: false, status: 400, error: 'Project selection is required for this action' };
  }

  const result = getDb().prepare(`
    INSERT INTO dashboard_actions (action, payload, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `).run(action, JSON.stringify(payload ?? {}), Date.now()) as { lastInsertRowid?: number | bigint };

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      action,
      id: Number(result.lastInsertRowid ?? 0),
    },
  };
}

function buildStartDecision(projectId: string) {
  return decideProjectStart(projectId);
}

function buildLocalRuntimeBridge(projectFilter?: string) {
  const daemonStatusPath = path.join(STATE_DIR, 'daemon-status.json');
  const daemonLockPath = path.join(STATE_DIR, 'daemon.lock.json');
  let daemon: Record<string, unknown> | null = null;
  let daemonLock: Record<string, unknown> | null = null;
  try {
    if (fs.existsSync(daemonStatusPath)) {
      daemon = JSON.parse(fs.readFileSync(daemonStatusPath, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    daemon = null;
  }
  try {
    if (fs.existsSync(daemonLockPath)) {
      daemonLock = JSON.parse(fs.readFileSync(daemonLockPath, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    daemonLock = null;
  }

  const daemonPid = typeof daemonLock?.pid === 'number' ? daemonLock.pid : null;
  let daemonAlive = false;
  if (daemonPid !== null) {
    try {
      process.kill(daemonPid, 0);
      daemonAlive = true;
    } catch {
      daemonAlive = false;
    }
  }

  const cutoff = Date.now() - 20 * 60 * 1000;
  const projectClause = projectFilter ? 'AND project_id = ?' : '';
  const runProjectClause = projectFilter ? 'AND r.project_id = ?' : '';
  const projectArgs = projectFilter ? [projectFilter] : [];
  const db = getDb();
  const activeRunsRow = getDb().prepare(`
    SELECT COUNT(*) AS count, MAX(updated_at) AS latest
    FROM run_sessions
    WHERE status IN ('pending', 'running')
      AND updated_at >= ?
      ${projectClause}
  `).get(cutoff, ...projectArgs) as { count: number | null; latest: number | null } | undefined;
  const pausedRunsRow = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM run_sessions
    WHERE status IN ('paused', 'retry_scheduled')
      AND updated_at >= ?
      ${projectClause}
  `).get(cutoff, ...projectArgs) as { count: number | null } | undefined;
  const activeRunRows = db.prepare(`
    SELECT
      r.id,
      r.goal_id,
      r.project_id,
      r.agent,
      r.workflow_kind,
      r.status,
      r.retry_class,
      r.retry_at,
      r.provider_failure_kind,
      r.created_at,
      r.updated_at,
      r.completed_at,
      g.title,
      g.description
    FROM run_sessions r
    LEFT JOIN goals g ON g.id = r.goal_id
    WHERE r.status IN ('pending', 'running')
      AND r.updated_at >= ?
      ${runProjectClause}
    ORDER BY r.updated_at DESC
    LIMIT 8
  `).all(cutoff, ...projectArgs) as Array<{
    id: string;
    goal_id: string;
    project_id: string;
    agent: string;
    workflow_kind: string | null;
    status: string;
    retry_class: string | null;
    retry_at: number | null;
    provider_failure_kind: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    title: string | null;
    description: string | null;
  }>;
  const activeRunIds = activeRunRows.map((row) => row.id);
  const latestStepsByRun = new Map<string, {
    id: string;
    run_id: string;
    name: string;
    status: string;
    detail: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
  }>();

  if (activeRunIds.length > 0) {
    const placeholders = activeRunIds.map(() => '?').join(', ');
    const latestStepRows = db.prepare(`
      SELECT s.*
      FROM run_steps s
      INNER JOIN (
        SELECT run_id, MAX(COALESCE(updated_at, created_at)) AS latest_ts
        FROM run_steps
        WHERE run_id IN (${placeholders})
        GROUP BY run_id
      ) latest
        ON latest.run_id = s.run_id
       AND COALESCE(s.updated_at, s.created_at) = latest.latest_ts
      ORDER BY s.updated_at DESC
    `).all(...activeRunIds) as Array<{
      id: string;
      run_id: string;
      name: string;
      status: string;
      detail: string | null;
      created_at: number;
      updated_at: number;
      completed_at: number | null;
    }>;

    for (const step of latestStepRows) {
      if (!latestStepsByRun.has(step.run_id)) {
        latestStepsByRun.set(step.run_id, step);
      }
    }
  }

  const blockerRows = db.prepare(`
    SELECT id, goal_id, agent, status, workflow_kind, description, error, provider_failure_kind, retry_at
    FROM tasks
    WHERE status IN ('paused', 'retry_scheduled', 'awaiting_review')
      ${projectFilter ? 'AND project_id = ?' : ''}
    ORDER BY COALESCE(completed_at, started_at, created_at) DESC
    LIMIT 24
  `).all(...projectArgs) as Array<{
    id: string;
    goal_id: string | null;
    agent: string;
    status: string;
    workflow_kind: string | null;
    description: string;
    error: string | null;
    provider_failure_kind: string | null;
    retry_at: number | null;
  }>;

  const isReviewLane = (row: { agent: string; workflow_kind: string | null }) =>
    row.workflow_kind === 'review'
    || row.workflow_kind === 'validate'
    || ['quality-agent', 'quality-guardian', 'codex-review', 'domain-model', 'grill-me', 'legal', 'security-audit'].includes(row.agent);

  const retryingReview = blockerRows.filter((row) => row.status === 'retry_scheduled' && isReviewLane(row));
  const pausedReview = blockerRows.filter((row) => row.status === 'paused' && isReviewLane(row));
  const awaitingReview = blockerRows.filter((row) => row.status === 'awaiting_review');
  const retryingExecution = blockerRows.filter((row) => row.status === 'retry_scheduled' && !isReviewLane(row));
  const pausedExecution = blockerRows.filter((row) => row.status === 'paused' && !isReviewLane(row));
  const blockers: Array<{
    kind: 'review_paused' | 'review_retry' | 'awaiting_review' | 'execution_paused';
    severity: 'warning' | 'critical';
    title: string;
    detail: string;
    count: number;
    taskIds: string[];
  }> = [];

  if (pausedReview.length > 0) {
    const latest = pausedReview[0];
    blockers.push({
      kind: 'review_paused',
      severity: activeRunRows.length === 0 ? 'critical' : 'warning',
      title: `${pausedReview.length} paused review task${pausedReview.length === 1 ? '' : 's'} blocking progress`,
      detail: `The review lane is paused. Latest issue: ${latest?.error ?? latest?.provider_failure_kind ?? latest?.description ?? 'unknown'}.`,
      count: pausedReview.length,
      taskIds: pausedReview.map((row) => row.id),
    });
  }

  if (retryingReview.length > 0) {
    const latest = retryingReview[0];
    blockers.push({
      kind: 'review_retry',
      severity: 'warning',
      title: `${retryingReview.length} review task${retryingReview.length === 1 ? '' : 's'} scheduled to retry`,
      detail: `Review auto-heal has already rescheduled these tasks. Next retry: ${latest?.retry_at ? new Date(latest.retry_at).toISOString() : 'soon'}.`,
      count: retryingReview.length,
      taskIds: retryingReview.map((row) => row.id),
    });
  }

  if (awaitingReview.length > 0) {
    blockers.push({
      kind: 'awaiting_review',
      severity: 'warning',
      title: `${awaitingReview.length} task${awaitingReview.length === 1 ? '' : 's'} awaiting review`,
      detail: 'Execution finished, but these tasks are still waiting in the review lane.',
      count: awaitingReview.length,
      taskIds: awaitingReview.map((row) => row.id),
    });
  }

  if (pausedExecution.length > 0) {
    const latest = pausedExecution[0];
    blockers.push({
      kind: 'execution_paused',
      severity: 'critical',
      title: `${pausedExecution.length} work item${pausedExecution.length === 1 ? '' : 's'} paused during execution`,
      detail: `Latest execution issue: ${latest?.error ?? latest?.provider_failure_kind ?? latest?.description ?? 'unknown'}.`,
      count: pausedExecution.length,
      taskIds: pausedExecution.map((row) => row.id),
    });
  }

  if (retryingExecution.length > 0) {
    const latest = retryingExecution[0];
    blockers.push({
      kind: 'execution_paused',
      severity: 'warning',
      title: `${retryingExecution.length} work item${retryingExecution.length === 1 ? '' : 's'} scheduled to retry`,
      detail: `Execution recovery has queued another attempt. Next retry: ${latest?.retry_at ? new Date(latest.retry_at).toISOString() : 'soon'}. Latest issue: ${latest?.error ?? latest?.provider_failure_kind ?? latest?.description ?? 'unknown'}.`,
      count: retryingExecution.length,
      taskIds: retryingExecution.map((row) => row.id),
    });
  }

  const updatedAt = typeof daemon?.updatedAt === 'string' ? daemon.updatedAt : null;
  const lockStartedAt = typeof daemonLock?.startedAt === 'string' ? daemonLock.startedAt : null;
  const observedAt = updatedAt
    ? Date.parse(updatedAt)
    : daemonAlive && lockStartedAt
      ? Date.parse(lockStartedAt)
      : null;

  return {
    generatedAt: Date.now(),
    projectId: projectFilter ?? null,
    daemon: {
      startedAt: typeof daemon?.startedAt === 'string' ? daemon.startedAt : lockStartedAt,
      updatedAt,
      observedAt,
      source: 'local-bridge',
      version: typeof daemon?.version === 'string' ? daemon.version : null,
      alive: daemonAlive,
    },
    activeRuns: Number(activeRunsRow?.count ?? 0),
    pausedRuns: Number(pausedRunsRow?.count ?? 0),
    latestRunUpdatedAt: activeRunsRow?.latest ? new Date(Number(activeRunsRow.latest)).toISOString() : null,
    runs: activeRunRows.map((row) => {
      const latestStep = latestStepsByRun.get(row.id);
      const elapsedMs = Math.max(0, (row.completed_at ?? Date.now()) - row.created_at);
      return {
        id: row.id,
        goalId: row.goal_id,
        projectId: row.project_id,
        agent: row.agent,
        workflowKind: row.workflow_kind ?? 'review',
        status: row.status,
        retryClass: row.retry_class ?? 'none',
        retryAt: row.retry_at,
        providerFailureKind: row.provider_failure_kind ?? 'none',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        title: row.title,
        description: row.description,
        steps: latestStep ? [{
          id: latestStep.id,
          runId: latestStep.run_id,
          name: latestStep.name,
          status: latestStep.status,
          detail: latestStep.detail,
          createdAt: latestStep.created_at,
          updatedAt: latestStep.updated_at,
          completedAt: latestStep.completed_at,
        }] : [],
        elapsedMs,
        estimatedDurationMs: null,
        etaMs: null,
        progressPct: latestStep?.status === 'running' ? 45 : null,
        progressBasis: latestStep?.status === 'running' ? 'local-heartbeat' : 'none',
      };
    }),
    blockers,
  };
}

function buildLocalDaemonStatusBridge() {
  const daemonStatusPath = path.join(STATE_DIR, 'daemon-status.json');
  if (!fs.existsSync(daemonStatusPath)) {
    return {
      source: 'local-bridge',
      observedAt: null,
      updatedAt: null,
      syncStatus: null,
      runtime: null,
      readiness: [],
      autonomy: [],
      rateLimitStatus: null,
      version: null,
    };
  }

  try {
    const stat = statSync(daemonStatusPath);
    const raw = JSON.parse(fs.readFileSync(daemonStatusPath, 'utf8')) as Record<string, unknown>;
    return {
      source: 'local-bridge',
      observedAt: Math.round(stat.mtimeMs),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(Math.round(stat.mtimeMs)).toISOString(),
      syncStatus: raw.syncStatus ?? null,
      runtime: raw.runtime ?? null,
      readiness: Array.isArray(raw.readiness) ? raw.readiness : [],
      autonomy: Array.isArray(raw.autonomy) ? raw.autonomy : [],
      rateLimitStatus: raw.rateLimitStatus ?? null,
      version: typeof raw.version === 'string' ? raw.version : null,
    };
  } catch {
    return {
      source: 'local-bridge',
      observedAt: null,
      updatedAt: null,
      syncStatus: null,
      runtime: null,
      readiness: [],
      autonomy: [],
      rateLimitStatus: null,
      version: null,
    };
  }
}

function buildLocalHealthBridge(projectFilter?: string) {
  const runtime = buildLocalRuntimeBridge(projectFilter);
  const db = getDb();
  const projectClause = projectFilter ? 'WHERE project_id = ?' : '';
  const projectArgs = projectFilter ? [projectFilter] : [];

  const lastTaskRow = db.prepare(`
    SELECT MAX(COALESCE(completed_at, started_at, created_at)) AS last_task_ts
    FROM tasks
    ${projectClause}
  `).get(...projectArgs) as { last_task_ts?: number | null } | undefined;

  const lastAuditRow = db.prepare(`
    SELECT MAX(ts) AS last_audit_ts
    FROM audit_log
  `).get() as { last_audit_ts?: number | null } | undefined;

  const todaySpendRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM agent_spend
    WHERE date = date('now')
    ${projectFilter ? 'AND project_id = ?' : ''}
  `).get(...projectArgs) as { total?: number | null } | undefined;

  const taskCountsRows = db.prepare(`
    SELECT status, COUNT(*) AS cnt
    FROM tasks
    ${projectClause}
    GROUP BY status
  `).all(...projectArgs) as Array<{ status?: string | null; cnt?: number | null }>;

  const pendingActionsRow = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM dashboard_actions
    WHERE status = 'pending'
  `).get() as { cnt?: number | null } | undefined;

  const now = Date.now();
  const lastActivityTs = Math.max(
    runtime.daemon.observedAt ?? 0,
    Number(lastTaskRow?.last_task_ts ?? 0),
    Number(lastAuditRow?.last_audit_ts ?? 0),
    runtime.latestRunUpdatedAt ? Date.parse(runtime.latestRunUpdatedAt) : 0,
  );

  return {
    source: 'local-bridge',
    daemonAlive: runtime.daemon.alive || runtime.activeRuns > 0,
    lastActivity: lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null,
    minutesSinceActivity: lastActivityTs > 0 ? Math.floor((now - lastActivityTs) / 60000) : -1,
    daemonUpdatedAt: runtime.daemon.updatedAt,
    daemonAgeMs: runtime.daemon.observedAt ? now - runtime.daemon.observedAt : null,
    activeRunUpdatedAt: runtime.latestRunUpdatedAt,
    todaySpend: Number(todaySpendRow?.total ?? 0),
    taskCounts: Object.fromEntries(taskCountsRows.map((row) => [String(row.status ?? 'unknown'), Number(row.cnt ?? 0)])),
    pendingActions: Number(pendingActionsRow?.cnt ?? 0),
  };
}

function buildLocalHistoryBridge(projectFilter?: string, decisionFilter?: string, agentFilter?: string) {
  const db = getDb();
  const conditions = ["t.agent NOT IN ('domain-model', 'grill-me', 'codex-review', 'quality-agent')"];
  const args: Array<string | number> = [];

  if (projectFilter) {
    conditions.push('t.project_id = ?');
    args.push(projectFilter);
  }
  if (agentFilter) {
    conditions.push('t.agent = ?');
    args.push(agentFilter);
  }
  if (decisionFilter) {
    conditions.push('g.decision = ?');
    args.push(decisionFilter);
  }

  const rows = db.prepare(`
    SELECT t.id, t.agent, t.description, t.lane, t.cost_usd, t.completed_at, t.created_at,
           g.decision, g.reason, g.decided_at
    FROM tasks t
    INNER JOIN gates g ON g.task_id = t.id
    WHERE g.gate = 'G4'
      AND g.decision != 'pending'
      AND ${conditions.join(' AND ')}
    ORDER BY g.decided_at DESC
    LIMIT 200
  `).all(...args) as Array<Record<string, unknown>>;

  return {
    source: 'local-bridge',
    generatedAt: Date.now(),
    tasks: rows.map((row) => ({
      id: String(row.id ?? ''),
      agent: String(row.agent ?? ''),
      description: String(row.description ?? ''),
      lane: String(row.lane ?? ''),
      costUsd: row.cost_usd == null ? null : Number(row.cost_usd),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      createdAt: Number(row.created_at ?? 0),
      gate: {
        decision: String(row.decision ?? ''),
        reason: row.reason == null ? null : String(row.reason),
        decidedAt: row.decided_at == null ? null : Number(row.decided_at),
      },
    })),
    total: rows.length,
  };
}

function buildLocalLaunchReadinessBridge(projectId?: string) {
  if (!projectId) {
    return { error: 'project is required' };
  }
  return getProjectLaunchAudit(projectId);
}

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url?.startsWith('/api/status')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildDashboardData(project), null, 2));
    return;
  }

  if (req.url?.startsWith('/api/runtime')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildLocalRuntimeBridge(project)));
    return;
  }

  if (req.url?.startsWith('/api/health')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project') ?? undefined;
    const health = buildLocalHealthBridge(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  if (req.url?.startsWith('/api/daemon-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildLocalDaemonStatusBridge()));
    return;
  }

  if (req.url?.startsWith('/api/start-decision')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project')?.trim();
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Project is required' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildStartDecision(project)));
    return;
  }

  if (req.url?.startsWith('/api/launch-readiness')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project')?.trim();
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project is required' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildLocalLaunchReadinessBridge(project)));
    return;
  }

  if (req.url?.startsWith('/api/history')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const project = url.searchParams.get('project') ?? undefined;
    const decision = url.searchParams.get('decision') ?? undefined;
    const agent = url.searchParams.get('agent') ?? undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildLocalHistoryBridge(project, decision, agent)));
    return;
  }

  if (req.url?.startsWith('/api/actions')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'GET') {
      const project = url.searchParams.get('project') ?? undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ actions: listDashboardActions(project) }));
      return;
    }

    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const result = enqueueDashboardAction(body);
          if (!result.ok) {
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          const queuedProject = typeof (body as { payload?: { project?: unknown } })?.payload?.project === 'string'
            ? String((body as { payload?: { project?: unknown } }).payload?.project)
            : null;
          wakeDaemonInBackground(`dashboard action${queuedProject ? ` for ${queuedProject}` : ''}`);
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.body));
        })
        .catch((error) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
      return;
    }
  }

  // Cost observability endpoint — highest-cost agents, tasks, lanes, and overruns
  if (req.url?.startsWith('/api/cost-report')) {
    try {
      const report = {
        generatedAt: new Date().toISOString(),
        topAgents: getTopCostAgents(15),
        costByLane: getCostByLane(),
        highestCostTasks: getHighestCostTasks(10),
        budgetOverruns: getBudgetOverruns(15),
        todaySpend: getSystemSpend(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (req.url && !req.url.startsWith('/api/')) {
    redirectToHostedUi(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (error) => {
  console.error('[Dashboard] Server error:', error);
});

server.listen(PORT, () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard] API: http://localhost:${PORT}/api/status`);
});

// Print status to terminal every 30 seconds
setInterval(() => {
  const data = buildDashboardData();
  if ('error' in data) {
    console.error(`[Dashboard] Error: ${data.error}`);
    return;
  }
  console.log(`\n[Dashboard] ${new Date().toISOString()}`);
  console.log(`  System spend: $${data.systemTotal} / $${data.systemCap}`);
  console.log(`  Pending tasks: ${data.pendingCount} | Dead letters: ${data.deadLetterCount}`);
  if (data.alerts.length > 0) {
    console.log(`  ALERTS: ${data.alerts.join(' | ')}`);
  }
  for (const agent of data.agents) {
    if (agent.status !== 'idle') {
      console.log(`  ${agent.name}: ${agent.spent} / ${agent.cap} (${agent.pct}%)`);
    }
  }
}, 30_000);

process.on('uncaughtException', (error) => {
  console.error('[Dashboard] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Dashboard] Unhandled rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('[Dashboard] SIGTERM received, closing server...');
  server.close(() => {
    console.log('[Dashboard] Server closed after SIGTERM.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Dashboard] SIGINT received, closing server...');
  server.close(() => {
    console.log('[Dashboard] Server closed after SIGINT.');
    process.exit(0);
  });
});

process.on('exit', (code) => {
  console.log(`[Dashboard] Process exiting with code ${code}`);
});

export default server;
