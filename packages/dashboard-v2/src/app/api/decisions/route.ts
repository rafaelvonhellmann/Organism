import { NextRequest } from 'next/server';
import { getClient, ensureTables } from '@/lib/db';
import { createActionItem } from '@/lib/queries';
import { buildInnovationRadarFeedbackRows } from '@/lib/innovation-radar-feedback';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_DECISIONS = ['approved', 'changes_requested', 'rejected', 'reply', 'dismissed'] as const;
type Decision = typeof VALID_DECISIONS[number];

/** Map lane to priority and compute due date */
function laneToPriority(lane: string): { priority: string; dueDate: string } {
  const now = new Date();
  switch (lane) {
    case 'HIGH': {
      const d = new Date(now.getTime() + 7 * 86400000);
      return { priority: 'HIGH', dueDate: d.toISOString().slice(0, 10) };
    }
    case 'LOW': {
      const d = new Date(now.getTime() + 30 * 86400000);
      return { priority: 'LOW', dueDate: d.toISOString().slice(0, 10) };
    }
    default: {
      const d = new Date(now.getTime() + 14 * 86400000);
      return { priority: 'MEDIUM', dueDate: d.toISOString().slice(0, 10) };
    }
  }
}

/** Extract a title from the task description (first 80 chars) */
function extractTitle(description: string): string {
  const cleaned = description
    .replace(/^(Strategic review|Technology strategy|Financial analysis|Product gap analysis|Architecture review|Infrastructure audit|Security audit|Marketing strategy|Marketing execution|SEO analysis|Community strategy|PR plan|Australian legal review|Sales strategy|Customer success|Team plan|Competitive intelligence|Metrics framework|Research workflow review|\[QUALITY AUDIT\]|Quality review|Codex review):?\s*/i, '')
    .replace(/^[""\u201C]/, '')
    .replace(/[""\u201D]$/, '')
    .replace(/\s+using codeEvidence.*$/i, '');
  const first = cleaned.split(/[.!?\n]/)[0].trim();
  if (first.length > 80) return first.slice(0, 77) + '...';
  return first || description.slice(0, 80);
}

/** Extract the suggested action from the task output */
function extractSuggestedAction(output: unknown): string {
  if (!output) return '';
  const text = typeof output === 'string' ? output : JSON.stringify(output);

  // Look for recommendation/suggestion/action sections
  const patterns = [
    /(?:recommend(?:ation)?s?|suggest(?:ion)?s?|action(?:\s*item)?s?|next\s*steps?)[:\s]*([^\n]+(?:\n(?!#|\*\*)[^\n]+)*)/i,
    /(?:should|must|need\s*to)[:\s]*([^\n]+)/i,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim().length > 10) {
      const result = m[1].trim().slice(0, 500);
      return result;
    }
  }

  // Fallback: first 500 chars of the output text
  const plain = text
    .replace(/\\n/g, '\n')
    .replace(/[#*`]/g, '')
    .trim();
  return plain.slice(0, 500);
}

export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();
  if (!client) {
    return Response.json({ error: 'Database not connected' }, { status: 503 });
  }

  await ensureTables();

  const body = await req.json();
  const { taskId, decision, reason } = body as {
    taskId: string;
    decision: string;
    reason?: string;
  };

  if (!taskId || !decision) {
    return Response.json({ error: 'taskId and decision are required' }, { status: 400 });
  }

  if (!VALID_DECISIONS.includes(decision as Decision)) {
    return Response.json(
      { error: `decision must be one of: ${VALID_DECISIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const id = crypto.randomUUID();
  const decidedAt = Date.now();

  try {
    const taskResult = await client.execute({
      sql: 'SELECT description, lane, agent, project_id, output FROM tasks WHERE id = ?',
      args: [taskId],
    });
    const task = taskResult.rows.length > 0 ? taskResult.rows[0] : null;

    // 1. Always record in review_decisions (dashboard-owned table)
    await client.execute({
      sql: `INSERT INTO review_decisions (id, task_id, decision, reason, decided_by, decided_at, created_at)
            VALUES (?, ?, ?, ?, 'rafael', ?, ?)`,
      args: [id, taskId, decision, reason ?? null, decidedAt, decidedAt],
    });

    // 2. For approve/reject/dismiss, resolve the G4 gate so core sees the decision.
    //    If a pending G4 gate already exists (created by core's triggerG4Gate), update it.
    //    Otherwise insert a new G4 gate record. Reply leaves the task in the queue.
    if (decision !== 'reply') {
      const gateDecision = decision === 'dismissed' ? 'rejected' : decision;
      try {
        // Try to resolve an existing pending G4 gate first
        const existing = await client.execute({
          sql: `SELECT id FROM gates WHERE task_id = ? AND gate = 'G4' AND decision = 'pending' LIMIT 1`,
          args: [taskId],
        });

        if (existing.rows.length > 0) {
          // Update the existing G4 gate (created by core)
          await client.execute({
            sql: `UPDATE gates SET decision = ?, decided_by = 'rafael', reason = ?, decided_at = ?
                  WHERE id = ?`,
            args: [gateDecision, reason ?? null, decidedAt, String(existing.rows[0].id)],
          });
        } else {
          // No pending gate from core — insert a new G4 gate
          await client.execute({
            sql: `INSERT INTO gates (id, task_id, gate, decision, decided_by, reason, decided_at, created_at)
                  VALUES (?, ?, 'G4', ?, 'rafael', ?, ?, ?)`,
            args: [id, taskId, gateDecision, reason ?? null, decidedAt, decidedAt],
          });
        }
      } catch {
        // gates table may not exist if core hasn't created it yet — not fatal
        // The review_decisions record is the source of truth for the dashboard
      }
    }

    // 3. Transition task status based on decision
    let actionItemId: string | null = null;
    const description = task ? String(task.description ?? '') : '';
    const lane = task ? String(task.lane ?? 'MEDIUM') : 'MEDIUM';
    const agent = task ? String(task.agent ?? '') : '';
    const projectId = task ? String(task.project_id ?? 'organism') : 'organism';
    const output = task?.output;

    if (task && agent === 'competitive-intel' && decision !== 'reply') {
      const feedbackDecision = decision === 'dismissed' ? 'rejected' : decision;
      const shouldPersistFeedback =
        feedbackDecision === 'approved'
        || feedbackDecision === 'rejected'
        || (feedbackDecision === 'changes_requested' && Boolean(reason?.trim()));

      if (shouldPersistFeedback) {
        const feedbackRows = buildInnovationRadarFeedbackRows({
          decision: feedbackDecision,
          reason: reason ?? null,
          output,
        });

        await client.execute({
          sql: 'DELETE FROM innovation_radar_feedback WHERE task_id = ?',
          args: [taskId],
        });

        for (const row of feedbackRows) {
          await client.execute({
            sql: `INSERT INTO innovation_radar_feedback
              (id, task_id, project_id, opportunity_title, feedback_code, notes, trigger, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'rafael', ?)`,
            args: [
              crypto.randomUUID(),
              taskId,
              projectId,
              row.opportunityTitle,
              row.feedbackCode,
              row.notes,
              row.trigger,
              decidedAt,
            ],
          });
        }
      }
    }

    if (decision === 'approved') {
      await client.execute({
        sql: `UPDATE tasks SET status = 'completed' WHERE id = ?
              AND status IN ('awaiting_review', 'completed')`,
        args: [taskId],
      });

      // 4. Create an action item from the approved finding
      try {
        if (task) {
          const { priority, dueDate } = laneToPriority(lane);
          const title = extractTitle(description);
          const suggestedAction = extractSuggestedAction(output);

          actionItemId = crypto.randomUUID();
          await createActionItem({
            id: actionItemId,
            projectId,
            title,
            description: suggestedAction || description,
            priority,
            sourceTaskId: taskId,
            sourceAgent: agent,
            dueDate,
          });
        }
      } catch (err) {
        console.error('[decisions] Failed to create action item:', err);
        // Not fatal — the decision is still recorded
      }
    } else if (decision === 'rejected' || decision === 'dismissed') {
      await client.execute({
        sql: `UPDATE tasks SET status = 'failed', error = ? WHERE id = ?
              AND status IN ('awaiting_review', 'completed')`,
        args: [reason ?? (decision === 'dismissed' ? 'Dismissed by Rafael' : 'Rejected by Rafael'), taskId],
      });
    }
    // reply + changes_requested: task stays in queue, comment is recorded

    return Response.json({
      id,
      taskId,
      decision,
      decidedBy: 'rafael',
      reason: reason ?? null,
      decidedAt,
      actionItemId,
    });
  } catch (err) {
    console.error('[decisions] Error saving decision:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to save decision' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const client = getClient();
  if (!client) {
    return Response.json({ decisions: [] });
  }

  await ensureTables();

  const sp = req.nextUrl.searchParams;
  const taskId = sp.get('taskId');

  if (taskId) {
    const result = await client.execute({
      sql: `SELECT * FROM review_decisions WHERE task_id = ? ORDER BY decided_at DESC`,
      args: [taskId],
    });
    return Response.json({
      decisions: result.rows.map(r => ({
        id: String(r.id),
        taskId: String(r.task_id),
        decision: String(r.decision),
        reason: r.reason ? String(r.reason) : null,
        decidedBy: String(r.decided_by),
        decidedAt: Number(r.decided_at),
      })),
    });
  }

  // Return recent decisions
  const result = await client.execute(
    `SELECT * FROM review_decisions ORDER BY decided_at DESC LIMIT 100`,
  );
  return Response.json({
    decisions: result.rows.map(r => ({
      id: String(r.id),
      taskId: String(r.task_id),
      decision: String(r.decision),
      reason: r.reason ? String(r.reason) : null,
      decidedBy: String(r.decided_by),
      decidedAt: Number(r.decided_at),
    })),
  });
}
