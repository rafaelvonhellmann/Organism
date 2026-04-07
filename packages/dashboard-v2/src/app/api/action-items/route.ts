import { NextRequest } from 'next/server';
import { ensureTables } from '@/lib/db';
import { getActionItems, getActionItemCounts, createActionItem } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const project = sp.get('project') ?? undefined;
  const status = sp.get('status') ?? undefined;
  const priority = sp.get('priority') ?? undefined;
  const countsOnly = sp.get('counts') === '1';

  if (countsOnly) {
    const counts = await getActionItemCounts(project);
    return Response.json(counts);
  }

  const items = await getActionItems({ project, status, priority });
  const counts = await getActionItemCounts(project);

  return Response.json({ items, counts });
}

export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const body = await req.json();
  const { projectId, title, description, priority, sourceTaskId, sourceAgent, dueDate } = body as {
    projectId: string;
    title: string;
    description?: string;
    priority?: string;
    sourceTaskId?: string;
    sourceAgent?: string;
    dueDate?: string;
  };

  if (!projectId || !title) {
    return Response.json({ error: 'projectId and title are required' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const result = await createActionItem({
    id,
    projectId,
    title,
    description: description ?? '',
    priority: priority ?? 'MEDIUM',
    sourceTaskId,
    sourceAgent,
    dueDate,
  });

  if (!result) {
    return Response.json({ error: 'Failed to create action item' }, { status: 500 });
  }

  return Response.json({ ...result, id });
}
