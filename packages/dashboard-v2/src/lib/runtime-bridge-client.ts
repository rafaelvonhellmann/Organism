'use client';

const LOCAL_DASHBOARD_ORIGIN = 'http://127.0.0.1:7391';

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

function buildQuery(project?: string): string {
  if (!project) return '';
  return `?project=${encodeURIComponent(project)}`;
}

export async function loadLocalRuntimeBridge(project?: string): Promise<LocalRuntimeBridgeSnapshot | null> {
  try {
    const response = await fetch(`${LOCAL_DASHBOARD_ORIGIN}/api/runtime${buildQuery(project)}`, {
      cache: 'no-store',
      mode: 'cors',
      headers: { 'X-Organism-Bridge': '1' },
    });
    if (!response.ok) return null;
    return await response.json() as LocalRuntimeBridgeSnapshot;
  } catch {
    return null;
  }
}
