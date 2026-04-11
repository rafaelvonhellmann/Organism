import { requireAuth, unauthorizedResponse } from '@/lib/auth';
import { NextRequest } from 'next/server';
import upstreamSources from '@/lib/upstream-sources';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const sources = await upstreamSources.getUpstreamSources();
  return Response.json({ sources });
}
