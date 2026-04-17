import { NextRequest } from 'next/server';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const project = req.nextUrl.searchParams.get('project');
  if (!project) {
    return Response.json({ error: 'project is required' }, { status: 400 });
  }
  return Response.json(
    {
      projectId: project,
      generatedAt: Date.now(),
      summary: { pass: 0, warn: 0, fail: 0, na: 0 },
      blockers: [],
      items: [],
      source: 'hosted-fallback',
      note: 'Launch readiness is computed from the local Organism bridge when available.',
    },
    { status: 200 },
  );
}
