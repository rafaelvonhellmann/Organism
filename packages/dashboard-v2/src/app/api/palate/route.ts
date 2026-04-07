import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';
import sourcesData from '@/data/palate-sources.json';

export const dynamic = 'force-dynamic';

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();

  // 1. Sources from bundled data (synced at build time)
  const sources = (sourcesData as { sources?: Array<{
    id: string; localPath: string; fitness: number; tags: string[];
    scope: string; approved: boolean; addedBy: string; addedAt: number;
  }> }).sources ?? [];

  // 2. Injection stats from audit log (Turso)
  let totalInjections = 0;
  let totalRawTokens = 0;
  let totalDistilledTokens = 0;
  let totalSavings = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const byCapability: Record<string, number> = {};

  if (client) {
    try {
      const result = await client.execute(
        `SELECT payload FROM audit_log WHERE action = 'source_injection' ORDER BY ts DESC LIMIT 500`,
      );
      for (const row of result.rows) {
        const p = JSON.parse(s(row.payload));
        totalInjections++;
        totalRawTokens += n(p.rawTokens ?? p.estimatedTokens ?? 0);
        totalDistilledTokens += n(p.distilledTokens ?? p.estimatedTokens ?? 0);
        totalSavings += n(p.tokenSavings ?? 0);
        cacheHits += n(p.cacheHits ?? 0);
        cacheMisses += n(p.cacheMisses ?? 0);
        const cap = s(p.capabilityId ?? 'unknown');
        byCapability[cap] = (byCapability[cap] ?? 0) + 1;
      }
    } catch { /* audit query failed */ }
  }

  // 3. Wiki ratings (Turso)
  let ratings: Array<{ page: string; count: number; avg: number }> = [];
  if (client) {
    try {
      const result = await client.execute(
        `SELECT page, COUNT(*) as cnt, AVG(rating) as avg_rating FROM wiki_ratings GROUP BY page`,
      );
      ratings = result.rows.map((r) => ({
        page: s(r.page),
        count: n(r.cnt),
        avg: Math.round(n(r.avg_rating) * 10) / 10,
      }));
    } catch { /* table may not exist yet */ }
  }

  // 4. Source fitness from DB (Turso)
  const fitnessMap = new Map<string, { injections: number; lastInjected: number | null }>();
  if (client) {
    try {
      const result = await client.execute(`SELECT source_id, injections, last_injected FROM source_fitness`);
      for (const row of result.rows) {
        fitnessMap.set(s(row.source_id), {
          injections: n(row.injections),
          lastInjected: row.last_injected ? n(row.last_injected) : null,
        });
      }
    } catch { /* table may not exist yet */ }
  }

  // Enrich sources with DB fitness data
  const enrichedSources = sources.map((src) => {
    const dbFitness = fitnessMap.get(src.id);
    return {
      ...src,
      totalInjections: dbFitness?.injections ?? 0,
      lastInjected: dbFitness?.lastInjected ?? null,
    };
  });

  return Response.json({
    sources: enrichedSources,
    stats: {
      totalInjections,
      totalRawTokens,
      totalDistilledTokens,
      totalSavings,
      savingsPercent: totalRawTokens > 0 ? Math.round((totalSavings / totalRawTokens) * 100) : 0,
      cacheHits,
      cacheMisses,
      byCapability,
    },
    ratings,
  });
}
