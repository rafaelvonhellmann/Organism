import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ status: 'no_db' });

  // Last task completed
  const lastTask = await client.execute(
    'SELECT agent, completed_at, cost_usd FROM tasks WHERE status = \'completed\' ORDER BY completed_at DESC LIMIT 1'
  );

  // Last audit entry (proxy for "is the daemon alive")
  const lastAudit = await client.execute(
    'SELECT ts, action FROM audit_log ORDER BY ts DESC LIMIT 1'
  );

  // Today's spend
  const todaySpend = await client.execute(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM agent_spend WHERE date = date('now')`
  );

  // Tasks by status
  const taskCounts = await client.execute(
    `SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status`
  );

  // Pending actions
  const pendingActions = await client.execute(
    `SELECT COUNT(*) as cnt FROM dashboard_actions WHERE status = 'pending'`
  );

  const lastTaskRow = lastTask.rows[0];
  const lastAuditRow = lastAudit.rows[0];
  const lastActivityTs = Math.max(
    Number(lastTaskRow?.completed_at ?? 0),
    Number(lastAuditRow?.ts ?? 0)
  );

  const now = Date.now();
  const minutesSinceActivity = lastActivityTs > 0 ? Math.floor((now - lastActivityTs) / 60000) : -1;

  return Response.json({
    daemonAlive: minutesSinceActivity >= 0 && minutesSinceActivity < 5,
    lastActivity: lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null,
    minutesSinceActivity,
    todaySpend: Number(todaySpend.rows[0]?.total ?? 0),
    taskCounts: Object.fromEntries(taskCounts.rows.map(r => [r.status, Number(r.cnt)])),
    pendingActions: Number(pendingActions.rows[0]?.cnt ?? 0),
  });
}
