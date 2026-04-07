import { NextRequest } from 'next/server';
import { getTaskDetail } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const { id } = await params;
  const data = await getTaskDetail(id);
  if (!data) return Response.json({ error: 'Task not found' }, { status: 404 });
  return Response.json(data);
}
