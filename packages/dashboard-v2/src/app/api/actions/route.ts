import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET: list recent actions and their status
export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ actions: [] });

  const result = await client.execute(
    'SELECT * FROM dashboard_actions ORDER BY created_at DESC LIMIT 20'
  );
  return Response.json({ actions: result.rows });
}

// POST: create a new action request
export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ error: 'No database connection' }, { status: 500 });

  const body = await req.json();
  const { action, payload } = body;

  const validActions = ['review', 'execute', 'status', 'onboard'];
  if (!validActions.includes(action)) {
    return Response.json({ error: `Invalid action. Valid: ${validActions.join(', ')}` }, { status: 400 });
  }

  await client.execute({
    sql: 'INSERT INTO dashboard_actions (action, payload, status, created_at) VALUES (?, ?, ?, ?)',
    args: [action, JSON.stringify(payload ?? {}), 'pending', Date.now()],
  });

  return Response.json({ ok: true, action });
}
