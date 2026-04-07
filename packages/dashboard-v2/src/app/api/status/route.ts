import { NextRequest } from 'next/server';
import { getSystemOverview } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const project = req.nextUrl.searchParams.get('project') ?? undefined;
  const data = await getSystemOverview(project);
  return Response.json(data);
}
