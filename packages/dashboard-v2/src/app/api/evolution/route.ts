import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
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

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const project = req.nextUrl.searchParams.get('project') ?? undefined;
  const raw = registryData as { perspectives?: PerspectiveEntry[] };
  const perspectives = raw.perspectives ?? [];

  // Try to read from perspective_fitness table in DB for richer data
  const client = getClient();
  const dbFitness = new Map<string, { fitness: number; invocations: number; avgRating: number; totalCost: number }>();

  if (client) {
    try {
      const pf = project ? ` WHERE project_id = '${project.replace(/'/g, "''")}'` : '';
      const result = await client.execute(
        `SELECT perspective_id, fitness_score, invocations, avg_rating, total_cost_usd FROM perspective_fitness${pf}`
      );
      for (const row of result.rows) {
        dbFitness.set(s(row.perspective_id), {
          fitness: n(row.fitness_score),
          invocations: n(row.invocations),
          avgRating: n(row.avg_rating),
          totalCost: n(row.total_cost_usd),
        });
      }
    } catch {
      // Table may not exist yet — fall back to registry data
    }
  }

  // Merge registry data with DB fitness data
  const rows = perspectives.map(p => {
    const dbEntry = dbFitness.get(p.id);
    const fitnessScore = dbEntry
      ? dbEntry.fitness
      : project && p.projectFitness[project] != null
        ? p.projectFitness[project]
        : null;

    return {
      id: p.id,
      domain: p.domain,
      status: p.status,
      model: p.model,
      fitnessScore,
      invocations: dbEntry?.invocations ?? p.totalInvocations,
      avgRating: dbEntry?.avgRating ?? p.avgRating,
      totalCost: dbEntry?.totalCost ?? p.totalCostUsd,
    };
  });

  // Sort by fitness score descending (nulls last)
  rows.sort((a, b) => {
    if (a.fitnessScore == null && b.fitnessScore == null) return 0;
    if (a.fitnessScore == null) return 1;
    if (b.fitnessScore == null) return -1;
    return b.fitnessScore - a.fitnessScore;
  });

  return Response.json(rows);
}
