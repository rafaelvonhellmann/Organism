import { NextRequest } from 'next/server';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';
import { getRuntimeEvents } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

function sseEncode(event: string, data: unknown, id?: number): Uint8Array {
  const body = [
    id != null ? `id: ${id}` : null,
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ].filter(Boolean).join('\n');
  return new TextEncoder().encode(body);
}

export async function GET(req: NextRequest) {
  if (!requireAuth(req)) return unauthorizedResponse();

  const project = req.nextUrl.searchParams.get('project') ?? undefined;
  const afterId = Number(req.nextUrl.searchParams.get('afterId') ?? '0') || 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let currentAfterId = afterId;

      const tick = async () => {
        const data = await getRuntimeEvents({ projectId: project, afterId: currentAfterId, limit: 50 });
        if (data.events.length > 0) {
          currentAfterId = data.latestId;
          controller.enqueue(sseEncode('runtime', data, data.latestId));
        }
      };

      const heartbeat = () => {
        controller.enqueue(sseEncode('heartbeat', { ts: Date.now() }));
      };

      tick().catch(() => {});
      const intervalId = setInterval(() => { tick().catch(() => {}); }, 1500);
      const heartbeatId = setInterval(heartbeat, 15000);

      req.signal.addEventListener('abort', () => {
        clearInterval(intervalId);
        clearInterval(heartbeatId);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
