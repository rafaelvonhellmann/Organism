/**
 * Agentation Integration — Sidecar human-feedback layer.
 *
 * Connects to an Agentation annotation server (local MCP or HTTP) to
 * fetch, acknowledge, resolve, dismiss, and reply to human annotations
 * on web pages/UI elements.
 *
 * Completely optional. If disabled or unreachable, all methods return
 * graceful empty/null results. Organism core never blocks on this.
 */

// ── Types ────────────────────────────────────────────────────────

export interface AgentationConfig {
  enabled: boolean;
  serverUrl: string;        // e.g. "http://localhost:4100"
  authToken?: string;       // optional bearer token
  timeoutMs: number;        // per-request timeout (default 5000)
}

export type AnnotationKind =
  | 'bug'
  | 'ux'
  | 'content'
  | 'accessibility'
  | 'performance'
  | 'visual'
  | 'suggestion'
  | 'other';

export type AnnotationStatus =
  | 'pending'
  | 'acknowledged'
  | 'resolved'
  | 'dismissed';

export type AnnotationSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info';

export interface AnnotationSession {
  id: string;
  pageUrl: string;
  title: string;
  createdAt: string;
  annotationCount: number;
  pendingCount: number;
}

export interface Annotation {
  id: string;
  sessionId: string;
  pageUrl: string;
  kind: AnnotationKind;
  severity: AnnotationSeverity;
  body: string;
  selector?: string;        // CSS selector of the annotated element
  screenshot?: string;       // base64 or URL
  status: AnnotationStatus;
  replies: AnnotationReply[];
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationReply {
  id: string;
  author: string;           // 'human' | 'organism' | agent name
  body: string;
  createdAt: string;
}

// ── Config resolution ────────────────────────────────────────────

const DEFAULT_TIMEOUT = 5000;

function resolveConfig(): AgentationConfig {
  const enabled = process.env.AGENTATION_ENABLED?.toLowerCase();
  return {
    enabled: enabled === 'true' || enabled === '1',
    serverUrl: (process.env.AGENTATION_SERVER_URL ?? 'http://localhost:4100').replace(/\/$/, ''),
    authToken: process.env.AGENTATION_AUTH_TOKEN?.trim() || undefined,
    timeoutMs: Number(process.env.AGENTATION_TIMEOUT_MS) || DEFAULT_TIMEOUT,
  };
}

let _config: AgentationConfig | null = null;

export function getConfig(): AgentationConfig {
  if (!_config) _config = resolveConfig();
  return _config;
}

/** Reset cached config (useful for tests). */
export function resetConfig(): void {
  _config = null;
}

// ── HTTP helpers ─────────────────────────────────────────────────

interface FetchResult<T> {
  ok: boolean;
  data: T | null;
  error?: string;
}

async function agentationFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<FetchResult<T>> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, data: null, error: 'agentation_disabled' };
  }

  const url = `${cfg.serverUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (cfg.authToken) {
    headers['Authorization'] = `Bearer ${cfg.authToken}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        ok: false,
        data: null,
        error: `agentation_http_${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json() as T;
    return { ok: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish timeout from connection refused
    if (message.includes('abort')) {
      return { ok: false, data: null, error: 'agentation_timeout' };
    }
    return { ok: false, data: null, error: `agentation_unreachable: ${message}` };
  }
}

// ── Public API ───────────────────────────────────────────────────

/** Check whether Agentation is configured and reachable. */
export async function isAvailable(): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.enabled) return false;
  const result = await agentationFetch<{ ok: boolean }>('/health');
  return result.ok === true;
}

/** List all annotation sessions. */
export async function listSessions(): Promise<AnnotationSession[]> {
  const result = await agentationFetch<{ sessions: AnnotationSession[] }>('/sessions');
  return result.data?.sessions ?? [];
}

/** Fetch pending annotations, optionally filtered by session. */
export async function fetchPendingAnnotations(
  sessionId?: string,
): Promise<Annotation[]> {
  const path = sessionId
    ? `/annotations?status=pending&session_id=${encodeURIComponent(sessionId)}`
    : '/annotations?status=pending';
  const result = await agentationFetch<{ annotations: Annotation[] }>(path);
  return result.data?.annotations ?? [];
}

/** Fetch a single annotation by ID. */
export async function getAnnotation(annotationId: string): Promise<Annotation | null> {
  const result = await agentationFetch<Annotation>(`/annotations/${encodeURIComponent(annotationId)}`);
  return result.data;
}

/** Acknowledge an annotation (Organism has seen it, will handle). */
export async function acknowledgeAnnotation(annotationId: string): Promise<boolean> {
  const result = await agentationFetch<{ ok: boolean }>(
    `/annotations/${encodeURIComponent(annotationId)}/acknowledge`,
    { method: 'POST' },
  );
  return result.ok;
}

/** Resolve an annotation (the issue has been addressed). */
export async function resolveAnnotation(
  annotationId: string,
  resolution?: string,
): Promise<boolean> {
  const result = await agentationFetch<{ ok: boolean }>(
    `/annotations/${encodeURIComponent(annotationId)}/resolve`,
    { method: 'POST', body: { resolution } },
  );
  return result.ok;
}

/** Dismiss an annotation (not actionable / won't fix). */
export async function dismissAnnotation(
  annotationId: string,
  reason?: string,
): Promise<boolean> {
  const result = await agentationFetch<{ ok: boolean }>(
    `/annotations/${encodeURIComponent(annotationId)}/dismiss`,
    { method: 'POST', body: { reason } },
  );
  return result.ok;
}

/** Reply to an annotation. */
export async function replyToAnnotation(
  annotationId: string,
  body: string,
  author: string = 'organism',
): Promise<boolean> {
  const result = await agentationFetch<{ ok: boolean }>(
    `/annotations/${encodeURIComponent(annotationId)}/reply`,
    { method: 'POST', body: { body, author } },
  );
  return result.ok;
}

// ── Batch operations (for sync ingestion) ────────────────────────

/** Fetch all annotations matching given IDs. */
export async function fetchAnnotationsByIds(ids: string[]): Promise<Annotation[]> {
  if (ids.length === 0) return [];
  const result = await agentationFetch<{ annotations: Annotation[] }>(
    '/annotations/batch',
    { method: 'POST', body: { ids } },
  );
  return result.data?.annotations ?? [];
}

/** Acknowledge multiple annotations at once. */
export async function acknowledgeAnnotationsBatch(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await agentationFetch<{ acknowledged: number }>(
    '/annotations/batch/acknowledge',
    { method: 'POST', body: { ids } },
  );
  return result.data?.acknowledged ?? 0;
}
