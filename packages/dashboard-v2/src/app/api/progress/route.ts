import { NextRequest } from 'next/server';
import { getRuntimeSnapshot } from '@/lib/runtime';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const project = req.nextUrl.searchParams.get('project') ?? 'organism';
  const snapshot = await getRuntimeSnapshot(project);

  const objectives = snapshot.goals.map((goal) => {
    const run = snapshot.runs.find((item) => item.id === goal.latestRunId);
    const owner = run?.agent ?? 'system';
    const status =
      goal.status === 'completed' ? 'done' :
      goal.status === 'running' || goal.status === 'pending' ? 'in_progress' :
      'stalled';

    return {
      agent: owner,
      label: goal.title,
      status,
    };
  });

  return Response.json({ project, objectives });
}
