'use client';

const LOCAL_DASHBOARD_ORIGIN = 'http://127.0.0.1:7391';

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value && value.length > 0);
  if (entries.length === 0) return '';
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value) search.set(key, value);
  }
  return `?${search.toString()}`;
}

async function loadLocalBridge<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T | null> {
  try {
    const response = await fetch(`${LOCAL_DASHBOARD_ORIGIN}${path}${buildQuery(params)}`, {
      cache: 'no-store',
      mode: 'cors',
      headers: { 'X-Organism-Bridge': '1' },
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export interface LocalRuntimeBridgeSnapshot {
  generatedAt: number;
  projectId: string | null;
  daemon: {
    startedAt: string | null;
    updatedAt: string | null;
    observedAt: number | null;
    source: string;
    version: string | null;
    alive: boolean;
  };
  activeRuns: number;
  pausedRuns: number;
  latestRunUpdatedAt: string | null;
}

export interface LocalHealthBridgeSnapshot {
  source: string;
  daemonAlive: boolean;
  lastActivity: string | null;
  minutesSinceActivity: number;
  daemonUpdatedAt: string | null;
  daemonAgeMs: number | null;
  activeRunUpdatedAt: string | null;
  todaySpend: number;
  taskCounts: Record<string, number>;
  pendingActions: number;
}

export interface LocalHistoryBridgeTask {
  id: string;
  agent: string;
  description: string;
  lane: string;
  costUsd: number | null;
  completedAt: number | null;
  createdAt: number;
  gate: {
    decision: string;
    reason: string | null;
    decidedAt: number | null;
  };
}

export interface LocalHistoryBridgeSnapshot {
  source: string;
  generatedAt: number;
  tasks: LocalHistoryBridgeTask[];
  total: number;
}

export function loadLocalRuntimeBridge(project?: string): Promise<LocalRuntimeBridgeSnapshot | null> {
  return loadLocalBridge<LocalRuntimeBridgeSnapshot>('/api/runtime', { project });
}

export function loadLocalHealthBridge(project?: string): Promise<LocalHealthBridgeSnapshot | null> {
  return loadLocalBridge<LocalHealthBridgeSnapshot>('/api/health', { project });
}

export function loadLocalHistoryBridge(project?: string, decision?: string, agent?: string): Promise<LocalHistoryBridgeSnapshot | null> {
  return loadLocalBridge<LocalHistoryBridgeSnapshot>('/api/history', { project, decision, agent });
}
