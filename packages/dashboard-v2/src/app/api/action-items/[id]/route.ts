import { NextRequest } from 'next/server';
import { ensureTables } from '@/lib/db';
import { updateActionItem } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const { id } = await params;
  const body = await req.json();
  const { status, priority, rafaelNotes, title, description, dueDate } = body as {
    status?: string;
    priority?: string;
    rafaelNotes?: string;
    title?: string;
    description?: string;
    dueDate?: string;
  };

  if (status && !['todo', 'in_progress', 'done'].includes(status)) {
    return Response.json({ error: 'status must be todo, in_progress, or done' }, { status: 400 });
  }

  if (priority && !['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
    return Response.json({ error: 'priority must be HIGH, MEDIUM, or LOW' }, { status: 400 });
  }

  const result = await updateActionItem(id, { status, priority, rafaelNotes, title, description, dueDate });

  if (!result) {
    return Response.json({ error: 'Failed to update action item' }, { status: 500 });
  }

  return Response.json(result);
}
