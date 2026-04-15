import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getSystemStatus } from '../../core/src/orchestrator.js';
import { getSpendSummary, getSystemSpend, getTopCostAgents, getCostByLane, getHighestCostTasks, getBudgetOverruns } from '../../core/src/budget.js';
import { getPendingTasks, getDeadLetterTasks, getDb } from '../../core/src/task-queue.js';
import { readRecentForAgent } from '../../core/src/audit.js';
import { STATE_DIR } from '../../shared/src/state-dir.js';

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '7391');
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:7391',
  'http://127.0.0.1:7391',
  'https://organism-hq.vercel.app',
  'https://organism-hq-v2.vercel.app',
]);

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

  const projectRequired = action === 'command' || action === 'review';
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
  const projectArgs = projectFilter ? [projectFilter] : [];
  const activeRunsRow = getDb().prepare(`
    SELECT COUNT(*) AS count, MAX(updated_at) AS latest
    FROM run_sessions
    WHERE status IN ('pending', 'running', 'paused', 'retry_scheduled')
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
  };
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
  const conditions = ["t.agent NOT IN ('grill-me', 'codex-review', 'quality-agent')"];
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildLocalHealthBridge(project)));
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

  res.writeHead(404);
  res.end('Not found');
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

export default server;
