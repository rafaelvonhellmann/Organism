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
  runs: Array<{
    id: string;
    goalId: string;
    projectId: string;
    agent: string;
    workflowKind: string;
    status: string;
    retryClass: string;
    retryAt: number | null;
    providerFailureKind: string;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
    title: string | null;
    description: string | null;
    steps: Array<{
      id: string;
      runId: string;
      name: string;
      status: string;
      detail: string | null;
      createdAt: number;
      updatedAt: number;
      completedAt: number | null;
    }>;
    elapsedMs: number;
    estimatedDurationMs: number | null;
    etaMs: number | null;
    progressPct: number | null;
    progressBasis: string;
  }>;
  blockers: Array<{
    kind: 'review_paused' | 'review_retry' | 'awaiting_review' | 'execution_paused';
    severity: 'warning' | 'critical';
    title: string;
    detail: string;
    count: number;
    taskIds: string[];
  }>;
}

export interface LocalDaemonStatusSnapshot {
  source: string;
  observedAt: number | null;
  updatedAt: string | null;
  syncStatus: {
    status?: 'ok' | 'failed' | 'blocked';
    reason?: string | null;
  } | null;
  runtime: {
    modelBackend?: string | null;
    codeExecutor?: string | null;
    webSearchAvailable?: boolean;
  } | null;
  readiness: Array<{
    projectId?: string;
    cleanWorktree?: boolean;
    workspaceMode?: string;
    deployUnlocked?: boolean;
    completedRuns?: number;
    initialWorkflowLimit?: number;
    initialAllowedWorkflows?: string[];
    initialWorkflowGuardActive?: boolean;
    prAuthReady?: boolean;
    prAuthMode?: string;
    vercelAuthReady?: boolean;
    vercelAuthMode?: string;
    blockers?: string[];
    warnings?: string[];
    minimax?: {
      enabled?: boolean;
      ready?: boolean;
      allowedCommands?: string[];
    };
  }>;
  autonomy: Array<{
    projectId?: string;
    autonomyMode?: string;
    consecutiveHealthyRuns?: number;
    requiredConsecutiveRuns?: number;
    rolloutReady?: boolean;
    rolloutStage?: string;
    blockers?: string[];
  }>;
  rateLimitStatus: {
    limited?: boolean;
    resetsAt?: string | null;
    usagePct?: number;
  } | null;
  version: string | null;
}

export interface LocalStartDecisionSnapshot {
  projectId: string;
  mode: 'continue' | 'review' | 'implement' | 'validate';
  workflowKind: 'review' | 'implement' | 'validate';
  label: string;
  summary: string;
  reason: string;
  command: string | null;
  state: {
    activeTasks: number;
    activeRuns: number;
    blockedTasks: number;
    awaitingReview: number;
    latestCompletedWorkflow: string | null;
    initialWorkflowGuardActive: boolean;
  };
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

export async function loadLocalDaemonStatus(): Promise<LocalDaemonStatusSnapshot | null> {
  try {
    const response = await fetch(`${LOCAL_DASHBOARD_ORIGIN}/api/daemon-status`, {
      cache: 'no-store',
      mode: 'cors',
      headers: { 'X-Organism-Bridge': '1' },
    });
    if (!response.ok) return null;
    return await response.json() as LocalDaemonStatusSnapshot;
  } catch {
    return null;
  }
}

export async function loadLocalStartDecision(project?: string): Promise<LocalStartDecisionSnapshot | null> {
  if (!project) return null;
  try {
    const response = await fetch(`${LOCAL_DASHBOARD_ORIGIN}/api/start-decision${buildQuery(project)}`, {
      cache: 'no-store',
      mode: 'cors',
      headers: { 'X-Organism-Bridge': '1' },
    });
    if (!response.ok) return null;
    return await response.json() as LocalStartDecisionSnapshot;
  } catch {
    return null;
  }
}
