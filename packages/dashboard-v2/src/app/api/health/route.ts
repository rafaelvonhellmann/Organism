import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ status: 'no_db' });

  const project = req.nextUrl.searchParams.get('project');
  const projectClause = project ? ' WHERE project_id = ?' : '';
  const projectArgs = project ? [project] : [];

  const [daemonStatus, lastTask, lastAudit, activeRun, todaySpend, taskCounts, pendingActions] = await Promise.all([
    client.execute(`SELECT updated_at FROM daemon_status WHERE id = 'primary' LIMIT 1`),
    client.execute({
      sql: `SELECT MAX(COALESCE(completed_at, started_at, created_at)) as last_task_ts FROM tasks${projectClause}`,
      args: projectArgs,
    }),
    client.execute('SELECT MAX(ts) as last_audit_ts FROM audit_log'),
    client.execute({
      sql: `SELECT MAX(updated_at) as last_run_ts
            FROM run_sessions${projectClause}
            ${project ? 'AND' : 'WHERE'} status IN ('pending', 'running', 'paused', 'retry_scheduled')`,
      args: projectArgs,
    }),
    client.execute({
      sql: `SELECT COALESCE(SUM(cost_usd), 0) as total FROM agent_spend WHERE date = date('now')${project ? ' AND project_id = ?' : ''}`,
      args: projectArgs,
    }),
    client.execute({
      sql: `SELECT status, COUNT(*) as cnt FROM tasks${projectClause} GROUP BY status`,
      args: projectArgs,
    }),
    client.execute('SELECT COUNT(*) as cnt FROM dashboard_actions WHERE status = \'pending\''),
  ]);

  const daemonStatusTs = Number(daemonStatus.rows[0]?.updated_at ?? 0);
  const lastTaskTs = Number(lastTask.rows[0]?.last_task_ts ?? 0);
  const lastAuditTs = Number(lastAudit.rows[0]?.last_audit_ts ?? 0);
  const lastRunTs = Number(activeRun.rows[0]?.last_run_ts ?? 0);
  const lastActivityTs = Math.max(daemonStatusTs, lastTaskTs, lastAuditTs, lastRunTs);

  const now = Date.now();
  const minutesSinceActivity = lastActivityTs > 0 ? Math.floor((now - lastActivityTs) / 60000) : -1;
  const daemonAgeMs = daemonStatusTs > 0 ? now - daemonStatusTs : null;
  const daemonAlive = lastActivityTs > 0 && (now - lastActivityTs) < 3 * 60 * 1000;

  return Response.json({
    daemonAlive,
    lastActivity: lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null,
    minutesSinceActivity,
    daemonUpdatedAt: daemonStatusTs > 0 ? new Date(daemonStatusTs).toISOString() : null,
    daemonAgeMs,
    activeRunUpdatedAt: lastRunTs > 0 ? new Date(lastRunTs).toISOString() : null,
    todaySpend: Number(todaySpend.rows[0]?.total ?? 0),
    taskCounts: Object.fromEntries(taskCounts.rows.map(r => [r.status, Number(r.cnt)])),
    pendingActions: Number(pendingActions.rows[0]?.cnt ?? 0),
  });
}
