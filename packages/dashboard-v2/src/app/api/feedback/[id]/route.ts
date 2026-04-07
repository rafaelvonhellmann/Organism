import { NextRequest } from 'next/server';
import { ensureTables } from '@/lib/db';
import {
  updateFeedbackStatus,
  convertFeedbackToActionItem,
  type FeedbackStatus,
} from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_STATUSES: FeedbackStatus[] = ['pending', 'acknowledged', 'resolved', 'dismissed', 'converted'];

/**
 * PATCH /api/feedback/:id
 *
 * Update the status of a feedback item.
 * Body: { status: FeedbackStatus }
 *
 * Or convert to an action item:
 * Body: { action: 'convert', projectId: string, title?: string, priority?: string }
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const { id } = await params;
  const body = await req.json();

  // Convert to action item
  if (body.action === 'convert') {
    const { projectId, title, priority } = body as {
      action: string;
      projectId: string;
      title?: string;
      priority?: string;
    };

    if (!projectId) {
      return Response.json({ error: 'projectId is required for conversion' }, { status: 400 });
    }

    const actionItemId = await convertFeedbackToActionItem(id, {
      projectId,
      title,
      priority,
    });

    if (!actionItemId) {
      return Response.json({ error: 'Failed to convert feedback — may already be converted, resolved, or dismissed' }, { status: 400 });
    }

    return Response.json({ converted: true, actionItemId });
  }

  // Simple status update
  const { status } = body as { status?: FeedbackStatus };
  if (!status || !VALID_STATUSES.includes(status)) {
    return Response.json(
      { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  const updated = await updateFeedbackStatus(id, status);
  if (!updated) {
    return Response.json(
      { error: 'Invalid state transition or feedback not found' },
      { status: 400 },
    );
  }

  return Response.json({ id, status, updated: true });
}
