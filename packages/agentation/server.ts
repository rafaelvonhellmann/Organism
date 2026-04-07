/**
 * Agentation Server Stub — minimal Express server for dev/testing.
 *
 * In-memory annotation store. No persistence. Under 200 lines.
 * Port 4030.
 */

import express from 'express';

const app = express();
app.use(express.json());

const PORT = Number(process.env.AGENTATION_PORT) || 4030;
const AUTH_TOKEN = process.env.AGENTATION_AUTH_TOKEN?.trim() || '';

// ── Types ───────────────────────────────────────────────────────

interface Annotation {
  id: string;
  sessionId: string;
  pageUrl: string;
  kind: string;
  severity: string;
  body: string;
  selector: string | null;
  status: 'pending' | 'acknowledged' | 'resolved' | 'dismissed';
  replies: Array<{ id: string; author: string; body: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

// ── In-memory store ─────────────────────────────────────────────

const annotations: Annotation[] = [];
let nextId = 1;

function genId(): string {
  return `ann-${String(nextId++).padStart(4, '0')}`;
}

// ── Auth middleware ──────────────────────────────────────────────

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!AUTH_TOKEN) return next(); // no token set = skip auth

  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match && match[1] === AUTH_TOKEN) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

app.use(authMiddleware);

// ── Routes ──────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// List sessions (derived from annotations)
app.get('/sessions', (_req, res) => {
  const sessionMap = new Map<string, {
    id: string; pageUrl: string; title: string;
    createdAt: string; annotationCount: number; pendingCount: number;
  }>();

  for (const ann of annotations) {
    const existing = sessionMap.get(ann.sessionId);
    if (existing) {
      existing.annotationCount++;
      if (ann.status === 'pending') existing.pendingCount++;
    } else {
      sessionMap.set(ann.sessionId, {
        id: ann.sessionId,
        pageUrl: ann.pageUrl,
        title: `Session ${ann.sessionId}`,
        createdAt: ann.createdAt,
        annotationCount: 1,
        pendingCount: ann.status === 'pending' ? 1 : 0,
      });
    }
  }

  res.json({ sessions: Array.from(sessionMap.values()) });
});

// List annotations (with optional status filter)
app.get('/annotations', (req, res) => {
  const status = req.query.status as string | undefined;
  const sessionId = req.query.session_id as string | undefined;

  let filtered = annotations;
  if (status) filtered = filtered.filter(a => a.status === status);
  if (sessionId) filtered = filtered.filter(a => a.sessionId === sessionId);

  res.json({ annotations: filtered });
});

// Create annotation (for testing)
app.post('/annotations', (req, res) => {
  const { sessionId, pageUrl, kind, severity, body, selector } = req.body;
  if (!body) {
    res.status(400).json({ error: 'body is required' });
    return;
  }

  const ann: Annotation = {
    id: genId(),
    sessionId: sessionId ?? `session-${Date.now()}`,
    pageUrl: pageUrl ?? 'http://localhost:3000',
    kind: kind ?? 'suggestion',
    severity: severity ?? 'medium',
    body: String(body),
    selector: selector ?? null,
    status: 'pending',
    replies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  annotations.push(ann);
  res.status(201).json(ann);
});

// Acknowledge
app.patch('/annotations/:id/acknowledge', (req, res) => {
  const ann = annotations.find(a => a.id === req.params.id);
  if (!ann) { res.status(404).json({ error: 'Not found' }); return; }
  ann.status = 'acknowledged';
  ann.updatedAt = new Date().toISOString();
  res.json({ ok: true, annotation: ann });
});

// Resolve
app.patch('/annotations/:id/resolve', (req, res) => {
  const ann = annotations.find(a => a.id === req.params.id);
  if (!ann) { res.status(404).json({ error: 'Not found' }); return; }
  ann.status = 'resolved';
  ann.updatedAt = new Date().toISOString();
  res.json({ ok: true, annotation: ann });
});

// Dismiss
app.patch('/annotations/:id/dismiss', (req, res) => {
  const ann = annotations.find(a => a.id === req.params.id);
  if (!ann) { res.status(404).json({ error: 'Not found' }); return; }
  ann.status = 'dismissed';
  ann.updatedAt = new Date().toISOString();
  res.json({ ok: true, annotation: ann });
});

// Reply
app.post('/annotations/:id/reply', (req, res) => {
  const ann = annotations.find(a => a.id === req.params.id);
  if (!ann) { res.status(404).json({ error: 'Not found' }); return; }

  const { body: replyBody, author } = req.body;
  if (!replyBody) { res.status(400).json({ error: 'body is required' }); return; }

  const reply = {
    id: `reply-${Date.now()}`,
    author: author ?? 'human',
    body: String(replyBody),
    createdAt: new Date().toISOString(),
  };

  ann.replies.push(reply);
  ann.updatedAt = new Date().toISOString();
  res.json({ ok: true, reply });
});

// ── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`  Agentation stub server running on http://localhost:${PORT}`);
  console.log(`  Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled (no AGENTATION_AUTH_TOKEN set)'}`);
  console.log(`  In-memory store — annotations will be lost on restart.`);
});
