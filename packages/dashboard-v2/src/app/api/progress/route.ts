import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Same objectives as progress-monitor.ts — kept in sync
const OBJECTIVES = [
  { agent: 'engineering', label: 'SAQ enrichment + auth flow', keywords: ['enrichment', 'auth'] },
  { agent: 'product-manager', label: 'Backlog RICE scoring + activation metric', keywords: ['backlog', 'activation', 'RICE'] },
  { agent: 'ceo', label: 'ANZCA beachhead validation', keywords: ['beachhead', 'PMF', 'validation'] },
  { agent: 'cfo', label: 'Enrichment spend tracking', keywords: ['enrichment', 'spend', 'budget'] },
  { agent: 'marketing-strategist', label: 'Founder post for ANZCA groups', keywords: ['founder', 'post', 'Facebook'] },
  { agent: 'security-audit', label: 'Auth bypass + RLS verification', keywords: ['bypass', 'RLS', 'auth'] },
  { agent: 'data-analyst', label: 'Pre-launch KPIs + funnel design', keywords: ['KPI', 'funnel', 'analytics'] },
  { agent: 'medical-content-reviewer', label: 'Citation quality audit', keywords: ['citation', 'quality', 'audit'] },
  { agent: 'legal', label: 'TOS draft + copyright audit', keywords: ['terms', 'copyright', 'TOS'] },
];

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();
  const client = getClient();
  if (!client) return Response.json({ objectives: [] });

  const project = req.nextUrl.searchParams.get('project') ?? 'synapse';
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

  const objectives = [];
  for (const obj of OBJECTIVES) {
    // Check for completed tasks matching keywords
    let completed = false;
    let inProgress = false;

    for (const kw of obj.keywords) {
      const result = await client.execute({
        sql: `SELECT id, status FROM tasks WHERE agent = ? AND project_id = ? AND description LIKE ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        args: [obj.agent, project, `%${kw}%`, threeDaysAgo],
      });
      if (result.rows.length > 0) {
        const status = String(result.rows[0].status);
        if (status === 'completed') { completed = true; break; }
        if (status === 'pending' || status === 'in_progress') inProgress = true;
      }
    }

    objectives.push({
      agent: obj.agent,
      label: obj.label,
      status: completed ? 'done' : inProgress ? 'in_progress' : 'stalled',
    });
  }

  return Response.json({ project, objectives });
}
