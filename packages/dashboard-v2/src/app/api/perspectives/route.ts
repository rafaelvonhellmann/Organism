import { NextRequest } from 'next/server';
import registryData from '@/data/perspective-registry.json';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface PerspectiveEntry {
  id: string;
  domain: string;
  systemPrompt: string;
  relevanceKeywords: string[];
  projectFitness: Record<string, number>;
  status: string;
  model: string;
  totalInvocations: number;
  totalCostUsd: number;
  avgRating: number;
  lastUsed: number;
}

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const project = req.nextUrl.searchParams.get('project') ?? undefined;
  const raw = registryData as { perspectives?: PerspectiveEntry[] };
  let perspectives = raw.perspectives ?? [];

  // If a project is specified, annotate with project-specific fitness
  if (project) {
    perspectives = perspectives.map(p => ({
      ...p,
      fitnessForProject: p.projectFitness[project] ?? null,
    }));
  }

  return Response.json(perspectives);
}
