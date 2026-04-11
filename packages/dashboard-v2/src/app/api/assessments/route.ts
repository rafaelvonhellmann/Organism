import { NextRequest } from 'next/server';
import { getClient, ensureTables } from '@/lib/db';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function n(v: unknown): number { return Number(v) || 0; }
function s(v: unknown): string { return v == null ? '' : String(v); }
function esc(v: string): string { return v.replace(/'/g, "''"); }

const PROJECT_DISPLAY_NAMES: Record<string, string> = {
  'synapse': 'Synapse',
  'tokens-for-good': 'Tokens for Good',
  'organism': 'Organism (internal)',
};

function displayName(id: string): string {
  return PROJECT_DISPLAY_NAMES[id] ?? id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface ReviewRun {
  id: string;
  date: string;
  hour: number;
  projectId: string;
  projectName: string;
  agentCount: number;
  agents: string[];
  taskCount: number;
  totalCost: number;
  synthesisSummary: string | null;
  statuses: { approved: number; rejected: number; dismissed: number; changes_requested: number; pending: number };
  topFindings: { agent: string; description: string; severity: string }[];
  earliestTaskId: string | null;
}

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();
  if (!client) {
    return Response.json({ runs: [], total: 0 });
  }

  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const project = sp.get('project');

  const projectFilter = project ? ` AND t.project_id = '${esc(project)}'` : '';

  // Group tasks by project_id + date + hour to identify review runs.
  // A "review run" = tasks created within the same hour for the same project,
  // either because there were multiple primary tasks or because the hour contains
  // explicit review workflow tasks such as a canary repo review.
  try {
    const result = await client.execute({
      sql: `
        SELECT
          t.project_id,
          strftime('%Y-%m-%d', t.created_at / 1000, 'unixepoch') AS run_date,
          CAST(strftime('%H', t.created_at / 1000, 'unixepoch') AS INTEGER) AS run_hour,
          COUNT(DISTINCT t.id) AS task_count,
          COUNT(DISTINCT CASE
            WHEN t.agent NOT IN ('grill-me', 'codex-review', 'quality-agent', 'risk-classifier')
            THEN t.id
          END) AS primary_task_count,
          COUNT(DISTINCT CASE
            WHEN t.workflow_kind = 'review'
            THEN t.id
          END) AS review_task_count,
          COUNT(DISTINCT t.agent) AS agent_count,
          GROUP_CONCAT(DISTINCT t.agent) AS agents,
          COALESCE(SUM(t.cost_usd), 0) AS total_cost,
          MIN(t.id) AS earliest_task_id,
          MIN(t.created_at) AS earliest_created
        FROM tasks t
        WHERE 1 = 1
          ${projectFilter}
        GROUP BY t.project_id, run_date, run_hour
        HAVING primary_task_count >= 2 OR review_task_count >= 1
        ORDER BY run_date DESC, run_hour DESC
        LIMIT 100
      `,
      args: [],
    });

    const runs: ReviewRun[] = [];

    for (const row of result.rows) {
      const pid = s(row.project_id);
      const runDate = s(row.run_date);
      const runHour = n(row.run_hour);
      const agentList = s(row.agents).split(',').filter(Boolean);
      const runId = `${pid}-${runDate}-${runHour}`;

      // Get status counts for tasks in this run window
      const hourStart = new Date(`${runDate}T00:00:00Z`).getTime() + runHour * 3600_000;
      const hourEnd = hourStart + 3600_000;

      // Try review_decisions first, fall back to gates
      let statuses = { approved: 0, rejected: 0, dismissed: 0, changes_requested: 0, pending: 0 };

      try {
        const decisionResult = await client.execute({
          sql: `
            SELECT rd.decision, COUNT(*) AS c
            FROM tasks t
            LEFT JOIN review_decisions rd ON rd.task_id = t.id
            WHERE t.project_id = ?
              AND t.created_at >= ? AND t.created_at < ?
              AND t.agent NOT IN ('grill-me', 'codex-review', 'quality-agent', 'risk-classifier')
            GROUP BY rd.decision
          `,
          args: [pid, hourStart, hourEnd],
        });

        for (const dr of decisionResult.rows) {
          const dec = s(dr.decision);
          const cnt = n(dr.c);
          if (dec === 'approved') statuses.approved = cnt;
          else if (dec === 'rejected') statuses.rejected = cnt;
          else if (dec === 'dismissed') statuses.dismissed = cnt;
          else if (dec === 'changes_requested') statuses.changes_requested = cnt;
          else statuses.pending += cnt;
        }
      } catch {
        // review_decisions may not exist; try gates
        try {
          const gateResult = await client.execute({
            sql: `
              SELECT g.decision, COUNT(*) AS c
              FROM tasks t
              LEFT JOIN gates g ON g.task_id = t.id AND g.gate = 'G4'
              WHERE t.project_id = ?
                AND t.created_at >= ? AND t.created_at < ?
                AND t.agent NOT IN ('grill-me', 'codex-review', 'quality-agent', 'risk-classifier')
              GROUP BY g.decision
            `,
            args: [pid, hourStart, hourEnd],
          });

          for (const gr of gateResult.rows) {
            const dec = s(gr.decision);
            const cnt = n(gr.c);
            if (dec === 'approved') statuses.approved = cnt;
            else if (dec === 'rejected') statuses.rejected = cnt;
            else if (dec === 'dismissed') statuses.dismissed = cnt;
            else if (dec === 'changes_requested') statuses.changes_requested = cnt;
            else statuses.pending += cnt;
          }
        } catch {
          // No gate data available
        }
      }

      // Get synthesis agent output if it exists, otherwise fall back to the
      // latest review artifact so canary reviews still show up as insights.
      let synthesisSummary: string | null = null;
      try {
        const synthResult = await client.execute({
          sql: `
            SELECT t.output FROM tasks t
            WHERE t.project_id = ? AND t.agent = 'synthesis'
              AND t.created_at >= ? AND t.created_at < ?
            ORDER BY t.created_at DESC LIMIT 1
          `,
          args: [pid, hourStart, hourEnd],
        });
        if (synthResult.rows.length > 0 && synthResult.rows[0].output) {
          const raw = synthResult.rows[0].output;
          if (typeof raw === 'string') {
            try {
              const parsed = JSON.parse(raw);
              synthesisSummary = typeof parsed === 'string' ? parsed : (parsed.summary ?? parsed.text ?? JSON.stringify(parsed).slice(0, 500));
            } catch {
              synthesisSummary = raw.slice(0, 500);
            }
          }
        }
      } catch {
        // No synthesis data
      }

      if (!synthesisSummary) {
        try {
          const reviewResult = await client.execute({
            sql: `
              SELECT t.output
              FROM tasks t
              WHERE t.project_id = ?
                AND t.created_at >= ? AND t.created_at < ?
                AND t.agent IN ('quality-agent', 'codex-review')
              ORDER BY t.created_at DESC LIMIT 1
            `,
            args: [pid, hourStart, hourEnd],
          });

          if (reviewResult.rows.length > 0 && reviewResult.rows[0].output) {
            const raw = reviewResult.rows[0].output;
            if (typeof raw === 'string') {
              try {
                const parsed = JSON.parse(raw) as { summary?: string; review?: string; text?: string };
                synthesisSummary = parsed.summary ?? parsed.review ?? parsed.text ?? JSON.stringify(parsed).slice(0, 500);
              } catch {
                synthesisSummary = raw.slice(0, 500);
              }
            }
          }
        } catch {
          // No review artifact data.
        }
      }

      // Get top findings (high-severity tasks in this run)
      const topFindings: { agent: string; description: string; severity: string }[] = [];
      try {
        const findingsResult = await client.execute({
          sql: `
            SELECT t.agent, t.description, t.lane
            FROM tasks t
            WHERE t.project_id = ?
              AND t.created_at >= ? AND t.created_at < ?
              AND t.agent NOT IN ('risk-classifier', 'synthesis')
            ORDER BY
              CASE t.lane WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
              t.created_at ASC
            LIMIT 5
          `,
          args: [pid, hourStart, hourEnd],
        });

        for (const fr of findingsResult.rows) {
          topFindings.push({
            agent: s(fr.agent),
            description: s(fr.description),
            severity: s(fr.lane) || 'MEDIUM',
          });
        }
      } catch {
        // No findings data
      }

      runs.push({
        id: runId,
        date: runDate,
        hour: runHour,
        projectId: pid,
        projectName: displayName(pid),
        agentCount: n(row.agent_count),
        agents: agentList,
        taskCount: n(row.task_count),
        totalCost: n(row.total_cost),
        synthesisSummary,
        statuses,
        topFindings,
        earliestTaskId: row.earliest_task_id ? s(row.earliest_task_id) : null,
      });
    }

    return Response.json({ runs, total: runs.length });
  } catch (err) {
    console.error('[assessments] Query error:', err);
    return Response.json({ runs: [], total: 0, error: 'Query failed' });
  }
}
