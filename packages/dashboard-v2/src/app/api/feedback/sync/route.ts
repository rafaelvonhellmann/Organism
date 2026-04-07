import { NextRequest } from 'next/server';
import { ensureTables } from '@/lib/db';
import { importFeedbackAnnotation } from '@/lib/queries';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/feedback/sync
 *
 * Ingest annotations from an external source (Agentation or similar).
 * The caller is responsible for fetching from the Agentation server and
 * posting here. This keeps the dashboard free of direct Agentation deps.
 *
 * Body: { annotations: Array<{
 *   externalId: string;
 *   sessionId?: string;
 *   pageUrl?: string;
 *   kind?: string;
 *   body: string;
 *   severity?: string;
 *   raw?: unknown;
 *   source?: string;  // defaults to 'agentation'
 * }> }
 *
 * Returns: { imported: number, skipped: number (duplicates) }
 */
export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  await ensureTables();

  const body = await req.json();
  const annotations = body.annotations;

  if (!Array.isArray(annotations)) {
    return Response.json({ error: 'annotations must be an array' }, { status: 400 });
  }

  if (annotations.length > 200) {
    return Response.json({ error: 'max 200 annotations per sync call' }, { status: 400 });
  }

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const ann of annotations) {
    if (!ann.externalId || !ann.body) {
      errors.push(`Missing externalId or body for annotation: ${JSON.stringify(ann).slice(0, 100)}`);
      continue;
    }

    const id = await importFeedbackAnnotation({
      source: ann.source ?? 'agentation',
      sessionId: ann.sessionId ?? null,
      externalId: String(ann.externalId),
      pageUrl: ann.pageUrl ?? null,
      annotationKind: ann.kind ?? null,
      body: String(ann.body),
      severity: ann.severity ?? null,
      rawPayload: ann.raw ?? null,
    });

    if (id) {
      imported++;
    } else {
      skipped++;
    }
  }

  return Response.json({
    imported,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  });
}
