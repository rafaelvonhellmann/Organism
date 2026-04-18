'use client';

const LOCAL_DASHBOARD_ORIGIN = 'http://127.0.0.1:7391';
const LOCAL_RETRY_QUEUE_KEY = 'organism.pendingLocalActions';

export interface DashboardActionRequest {
  action: string;
  payload?: Record<string, unknown>;
}

export interface DashboardActionResponse {
  ok: boolean;
  action?: string;
  via: 'remote' | 'local' | 'queued';
}

export interface DashboardActionRecord {
  id: number;
  action: string;
  payload: string;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
}

interface QueuedDashboardAction {
  id: string;
  request: DashboardActionRequest;
  createdAt: number;
}

function buildQuery(project?: string): string {
  if (!project) return '';
  return `?project=${encodeURIComponent(project)}`;
}

function shouldFallbackToLocal(status: number, error: string | null): boolean {
  if (status >= 500) return true;
  if (!error) return false;
  const normalized = error.toLowerCase();
  return normalized.includes('failed to create action')
    || normalized.includes('failed to create review action')
    || normalized.includes('no database connection')
    || normalized.includes('sql write operations are forbidden')
    || normalized.includes('writes are blocked')
    || normalized.includes('upgrade your plan')
    || normalized.includes('blocked');
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readQueuedActions(): QueuedDashboardAction[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_RETRY_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is QueuedDashboardAction => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<QueuedDashboardAction>;
      return typeof candidate.id === 'string'
        && typeof candidate.createdAt === 'number'
        && !!candidate.request
        && typeof candidate.request.action === 'string';
    }) : [];
  } catch {
    return [];
  }
}

function writeQueuedActions(actions: QueuedDashboardAction[]): void {
  if (!canUseLocalStorage()) return;
  if (actions.length === 0) {
    window.localStorage.removeItem(LOCAL_RETRY_QUEUE_KEY);
    return;
  }
  window.localStorage.setItem(LOCAL_RETRY_QUEUE_KEY, JSON.stringify(actions));
}

function queueDashboardAction(request: DashboardActionRequest): void {
  const queued = readQueuedActions();
  const payloadJson = JSON.stringify(request.payload ?? {});
  const exists = queued.some((item) =>
    item.request.action === request.action && JSON.stringify(item.request.payload ?? {}) === payloadJson,
  );
  if (exists) return;
  queued.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    request,
    createdAt: Date.now(),
  });
  writeQueuedActions(queued.slice(0, 20));
}

export function getQueuedDashboardActionCount(): number {
  return readQueuedActions().length;
}

async function submitToLocalBridge(request: DashboardActionRequest): Promise<DashboardActionResponse> {
  const local = await fetch(`${LOCAL_DASHBOARD_ORIGIN}/api/actions`, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      'X-Organism-Bridge': '1',
    },
    body: JSON.stringify(request),
  });

  const localBody = await readJson<{ ok?: boolean; action?: string; error?: string }>(local);
  if (!local.ok || !localBody?.ok) {
    throw new Error(localBody?.error ?? 'Failed to create action');
  }
  return { ok: true, action: localBody.action ?? request.action, via: 'local' };
}

export async function flushQueuedDashboardActions(): Promise<number> {
  const queued = readQueuedActions();
  if (queued.length === 0) return 0;

  const remaining: QueuedDashboardAction[] = [];
  let flushed = 0;

  for (const item of queued.reverse()) {
    try {
      await submitToLocalBridge(item.request);
      flushed += 1;
    } catch {
      remaining.unshift(item);
    }
  }

  writeQueuedActions(remaining);
  return flushed;
}

export async function submitDashboardAction(request: DashboardActionRequest): Promise<DashboardActionResponse> {
  let remoteError: string | null = null;
  let remoteStatus = 0;

  try {
    const remote = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    remoteStatus = remote.status;
    const body = await readJson<{ ok?: boolean; action?: string; error?: string }>(remote);
    if (remote.ok && body?.ok) {
      return { ok: true, action: body.action ?? request.action, via: 'remote' };
    }
    remoteError = body?.error ?? null;
    if (!shouldFallbackToLocal(remote.status, remoteError)) {
      throw new Error(remoteError ?? 'Failed to create action');
    }
  } catch (error) {
    if (error instanceof Error && !shouldFallbackToLocal(remoteStatus || 500, error.message)) {
      throw error;
    }
    remoteError = error instanceof Error ? error.message : String(error);
  }

  try {
    return await submitToLocalBridge(request);
  } catch (error) {
    queueDashboardAction(request);
    return {
      ok: true,
      action: request.action,
      via: 'queued',
    };
  }
}

export async function loadDashboardActions(project?: string): Promise<DashboardActionRecord[]> {
  const [remoteResult, localResult] = await Promise.allSettled([
    fetch(`/api/actions${buildQuery(project)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return [] as DashboardActionRecord[];
        const body = await readJson<{ actions?: DashboardActionRecord[] }>(response);
        return body?.actions ?? [];
      }),
    fetch(`${LOCAL_DASHBOARD_ORIGIN}/api/actions${buildQuery(project)}`, {
      cache: 'no-store',
      mode: 'cors',
      headers: { 'X-Organism-Bridge': '1' },
    })
      .then(async (response) => {
        if (!response.ok) return [] as DashboardActionRecord[];
        const body = await readJson<{ actions?: DashboardActionRecord[] }>(response);
        return body?.actions ?? [];
      })
      .catch(() => [] as DashboardActionRecord[]),
  ]);

  const remoteActions = remoteResult.status === 'fulfilled' ? remoteResult.value : [];
  const localActions = localResult.status === 'fulfilled' ? localResult.value : [];

  if (localActions.length === 0) return remoteActions;
  if (remoteActions.length === 0) return localActions;

  const remoteLatest = Math.max(...remoteActions.map((action) => Number(action.created_at) || 0));
  const localLatest = Math.max(...localActions.map((action) => Number(action.created_at) || 0));
  return localLatest >= remoteLatest ? localActions : remoteActions;
}
