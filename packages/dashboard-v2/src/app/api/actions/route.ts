import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET: list recent actions and their status
export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ actions: [] });
  const project = req.nextUrl.searchParams.get('project')?.trim();

  const result = await client.execute(
    'SELECT * FROM dashboard_actions ORDER BY created_at DESC LIMIT 100'
  );
  const actions = project
    ? result.rows.filter((row) => {
        try {
          const payload = row.payload ? JSON.parse(String(row.payload)) as { project?: string } : {};
          return payload.project === project;
        } catch {
          return false;
        }
      })
    : result.rows;
  return Response.json({ actions });
}

// POST: create a new action request
export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ error: 'No database connection' }, { status: 500 });

  const body = await req.json();
  const { action, payload } = body;

  if (!action) return Response.json({ error: 'Missing action' }, { status: 400 });
  const projectRequired = action === 'command' || action === 'review';
  if (projectRequired && (!payload || typeof payload.project !== 'string' || payload.project.trim().length === 0)) {
    return Response.json({ error: 'Project selection is required for this action' }, { status: 400 });
  }

  await client.execute({
    sql: 'INSERT INTO dashboard_actions (action, payload, status, created_at) VALUES (?, ?, ?, ?)',
    args: [action, JSON.stringify(payload ?? {}), 'pending', Date.now()],
  });

  return Response.json({ ok: true, action });
}
