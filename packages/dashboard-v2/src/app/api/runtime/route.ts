import { NextRequest } from 'next/server';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';
import { getRuntimeSnapshot } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const project = req.nextUrl.searchParams.get('project') ?? undefined;
  const data = await getRuntimeSnapshot(project);
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
