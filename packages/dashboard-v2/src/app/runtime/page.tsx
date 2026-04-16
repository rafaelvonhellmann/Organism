'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/header';
import { getInitialSelectedProject } from '@/lib/selected-project';
import { loadLocalDaemonStatus, loadLocalRuntimeBridge, type LocalDaemonStatusSnapshot, type LocalRuntimeBridgeSnapshot } from '@/lib/runtime-bridge-client';

interface RuntimeGoal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  sourceKind: string;
  workflowKind: string;
  latestRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RuntimeStep {
  id: string;
  runId: string;
  name: string;
  status: string;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface RuntimeRun {
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
  steps: RuntimeStep[];
  elapsedMs: number;
  estimatedDurationMs: number | null;
  etaMs: number | null;
  progressPct: number | null;
  progressBasis: string;
}

interface RuntimeInterrupt {
  id: string;
  runId: string;
  type: string;
  status: string;
  summary: string;
  detail: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

interface RuntimeApproval {
  id: string;
  runId: string;
  action: string;
  status: string;
  requestedBy: string;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  reason: string | null;
}

interface RuntimeEvent {
  id: number;
  runId: string;
  goalId: string;
  eventType: string;
  payload: unknown;
  ts: number;
}

interface RuntimeArtifact {
  id: string;
  runId: string;
  goalId: string;
  kind: string;
  title: string;
  path: string | null;
  content: string | null;
  createdAt: number;
}

interface RuntimeTaskOutput {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  summary: string | null;
  completedAt: number | null;
  createdAt: number;
}

interface CompareTarget {
  projectId: string;
  label: string;
  current: { name: string; project: string; url: string | null };
  forked: { name: string; project: string; url: string | null };
}

interface AutonomyHealth {
  projectId: string;
  autonomyMode: string;
  requiredConsecutiveRuns: number;
  rolloutStage: string;
  nextRolloutStage: string | null;
  nextRolloutThreshold: number | null;
  nextRolloutLabel: string | null;
  consecutiveHealthyRuns: number;
  recentCompletedRuns: number;
  recentProviderFailures: number;
  activeRuns: number;
  pendingInterrupts: number;
  pendingApprovals: number;
  rolloutReady: boolean;
  blockers: string[];
  coreAgents: string[];
}

interface RuntimeSnapshot {
  generatedAt: number;
  goals: RuntimeGoal[];
  runs: RuntimeRun[];
  interrupts: RuntimeInterrupt[];
  approvals: RuntimeApproval[];
  artifacts: RuntimeArtifact[];
  recentOutputs: RuntimeTaskOutput[];
  usefulOutputs: Array<{
    id: string;
    source: 'artifact' | 'task';
    kind: string;
    title: string;
    summary: string | null;
    createdAt: number;
    meta: string;
  }>;
  blockers: Array<{
    kind: 'review_paused' | 'review_retry' | 'awaiting_review' | 'execution_paused';
    severity: 'warning' | 'critical';
    title: string;
    detail: string;
    count: number;
    taskIds: string[];
  }>;
  recentEvents: RuntimeEvent[];
  compareTargets: CompareTarget[];
  autonomy: AutonomyHealth[];
  daemon: {
    runtime: {
      modelBackend: string | null;
      codeExecutor: string | null;
      webSearchAvailable: boolean;
    };
    rateLimitStatus: {
      limited: boolean;
      resetsAt: string | null;
      usagePct: number;
    };
    readiness: Array<{
      projectId: string;
      cleanWorktree: boolean;
      workspaceMode: string;
      deployUnlocked: boolean;
      completedRuns: number;
      initialWorkflowLimit: number;
      initialAllowedWorkflows: string[];
      initialWorkflowGuardActive: boolean;
      prAuthReady: boolean;
      prAuthMode: string;
      vercelAuthReady: boolean;
      vercelAuthMode: string;
      blockers: string[];
      warnings: string[];
      minimax: {
        enabled: boolean;
        ready: boolean;
        allowedCommands: string[];
      };
    }>;
    startedAt: string | null;
    updatedAt: string | null;
    observedAt: number | null;
    source: string;
    version: string | null;
  } | null;
}

function formatTime(ms: number | null): string {
  if (!ms) return 'n/a';
  return new Date(ms).toLocaleString('en-AU', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function statusTone(status: string): string {
  if (status === 'running' || status === 'completed') return 'text-emerald-400';
  if (status === 'paused' || status === 'retry_scheduled' || status === 'pending') return 'text-amber-400';
  return 'text-red-400';
}

function trimPreview(value: string | null, max = 280): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return 'n/a';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatEta(run: RuntimeRun): string {
  if (run.status === 'completed') return 'done';
  if (Date.now() - run.updatedAt > 120_000) return 'stalled';
  if (run.estimatedDurationMs == null) return 'estimating';
  if ((run.etaMs ?? 0) <= 0) return 'overdue';
  return formatDuration(run.etaMs);
}

function rolloutTone(stage: string): string {
  if (stage === 'graduated') return 'text-emerald-400';
  if (stage === 'deploy_ready') return 'text-sky-400';
  if (stage === 'bounded') return 'text-amber-300';
  return 'text-amber-400';
}

function workflowLabel(workflowKind: string): string {
  switch (workflowKind) {
    case 'review':
      return 'review';
    case 'implement':
      return 'implementation';
    case 'validate':
      return 'validation';
    case 'recover':
      return 'recovery';
    case 'plan':
      return 'planning';
    default:
      return workflowKind;
  }
}

export default function RuntimePage() {
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [localBridge, setLocalBridge] = useState<LocalRuntimeBridgeSnapshot | null>(null);
  const [localDaemonStatus, setLocalDaemonStatus] = useState<LocalDaemonStatusSnapshot | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchSnapshot = useCallback(async () => {
    const url = project ? `/api/runtime?project=${project}` : '/api/runtime';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const json = await res.json();
    setSnapshot(json);
    setLastUpdated(new Date());
  }, [project]);

  const fetchLocalBridge = useCallback(async () => {
    const bridge = await loadLocalRuntimeBridge(project || undefined);
    setLocalBridge(bridge);
  }, [project]);

  const fetchLocalDaemonStatus = useCallback(async () => {
    const status = await loadLocalDaemonStatus();
    setLocalDaemonStatus(status);
  }, []);

  useEffect(() => {
    fetchSnapshot().catch(() => {});
    fetchLocalBridge().catch(() => {});
    fetchLocalDaemonStatus().catch(() => {});
  }, [fetchSnapshot, fetchLocalBridge, fetchLocalDaemonStatus]);

  useEffect(() => {
    const id = setInterval(() => {
      fetchSnapshot().catch(() => {});
      fetchLocalBridge().catch(() => {});
      fetchLocalDaemonStatus().catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [fetchSnapshot, fetchLocalBridge, fetchLocalDaemonStatus]);

  useEffect(() => {
    const url = project ? `/api/runtime/events?project=${project}` : '/api/runtime/events';
    const es = new EventSource(url);

    es.addEventListener('runtime', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { events: RuntimeEvent[] };
        setSnapshot((prev) => {
          if (!prev) return prev;
          const recentEvents = [...prev.recentEvents, ...data.events].slice(-120);
          return { ...prev, recentEvents };
        });
        setLastUpdated(new Date());
        setConnected(true);
      } catch {
        // Ignore malformed event payloads.
      }
    });

    es.addEventListener('heartbeat', () => {
      setConnected(true);
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => es.close();
  }, [project]);

  const activeRuns = useMemo(
    () => snapshot?.runs.filter((run) => run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') ?? [],
    [snapshot],
  );
  const pausedRuns = useMemo(
    () => snapshot?.runs.filter((run) => run.status === 'paused' || run.status === 'retry_scheduled') ?? [],
    [snapshot],
  );
  const selectedReadiness = useMemo(() => {
    if (!project) return null;
    if (localDaemonStatus?.readiness?.length) {
      const localItem = localDaemonStatus.readiness.find((item) => item.projectId === project);
      if (localItem) {
        return {
          projectId: localItem.projectId ?? '',
          cleanWorktree: localItem.cleanWorktree ?? false,
          workspaceMode: localItem.workspaceMode ?? 'direct',
          deployUnlocked: localItem.deployUnlocked ?? false,
          completedRuns: localItem.completedRuns ?? 0,
          initialWorkflowLimit: localItem.initialWorkflowLimit ?? 0,
          initialAllowedWorkflows: Array.isArray(localItem.initialAllowedWorkflows) ? localItem.initialAllowedWorkflows : [],
          initialWorkflowGuardActive: localItem.initialWorkflowGuardActive ?? false,
          prAuthReady: localItem.prAuthReady ?? false,
          prAuthMode: localItem.prAuthMode ?? 'none',
          vercelAuthReady: localItem.vercelAuthReady ?? false,
          vercelAuthMode: localItem.vercelAuthMode ?? 'none',
          blockers: Array.isArray(localItem.blockers) ? localItem.blockers : [],
          warnings: Array.isArray(localItem.warnings) ? localItem.warnings : [],
          minimax: {
            enabled: localItem.minimax?.enabled ?? false,
            ready: localItem.minimax?.ready ?? false,
            allowedCommands: Array.isArray(localItem.minimax?.allowedCommands) ? localItem.minimax.allowedCommands : [],
          },
        };
      }
    }
    if (!snapshot?.daemon?.readiness?.length) return null;
    return snapshot.daemon.readiness.find((item) => item.projectId === project) ?? null;
  }, [localDaemonStatus, project, snapshot]);
  const selectedAutonomy = useMemo(() => {
    if (!project) return null;
    if (localDaemonStatus?.autonomy?.length) {
      const localItem = localDaemonStatus.autonomy.find((item) => item.projectId === project);
      if (localItem) {
        return {
          projectId: localItem.projectId ?? '',
          autonomyMode: localItem.autonomyMode ?? 'stabilization',
          consecutiveHealthyRuns: localItem.consecutiveHealthyRuns ?? 0,
          requiredConsecutiveRuns: localItem.requiredConsecutiveRuns ?? 3,
          rolloutReady: localItem.rolloutReady ?? false,
          rolloutStage: localItem.rolloutStage ?? 'stabilizing',
          nextRolloutStage: null,
          nextRolloutThreshold: null,
          nextRolloutLabel: null,
          recentCompletedRuns: 0,
          recentProviderFailures: 0,
          activeRuns: 0,
          pendingInterrupts: 0,
          pendingApprovals: 0,
          blockers: Array.isArray(localItem.blockers) ? localItem.blockers : [],
          coreAgents: [],
        };
      }
    }
    if (!snapshot?.autonomy?.length) return null;
    return snapshot.autonomy.find((item) => item.projectId === project) ?? null;
  }, [localDaemonStatus, project, snapshot]);
  const daemonAgeMs = snapshot?.daemon?.observedAt ? Math.max(0, Date.now() - snapshot.daemon.observedAt) : null;
  const daemonLooksStale = daemonAgeMs != null && daemonAgeMs > 90_000;
  const localBridgeLooksFresh = (localBridge?.daemon.observedAt ?? 0) > 0
    && Date.now() - (localBridge?.daemon.observedAt ?? 0) <= 90_000;
  const localDaemonAlive = localBridge?.daemon.alive === true;
  const preferLocalBridge = !!localBridge
    && (
      daemonLooksStale
      || !snapshot?.daemon
      || (localBridge.daemon.observedAt ?? 0) > (snapshot.daemon.observedAt ?? 0)
    );
  const effectiveRuntime = preferLocalBridge && localDaemonStatus?.runtime
    ? {
        modelBackend: localDaemonStatus.runtime.modelBackend ?? snapshot?.daemon?.runtime.modelBackend ?? null,
        codeExecutor: localDaemonStatus.runtime.codeExecutor ?? snapshot?.daemon?.runtime.codeExecutor ?? null,
        webSearchAvailable: localDaemonStatus.runtime.webSearchAvailable ?? snapshot?.daemon?.runtime.webSearchAvailable ?? false,
      }
    : snapshot?.daemon?.runtime;
  const effectiveActiveRunCount = preferLocalBridge
    ? localBridge?.activeRuns ?? activeRuns.length
    : activeRuns.length;
  const effectivePausedRunCount = preferLocalBridge
    ? localBridge?.pausedRuns ?? pausedRuns.length
    : pausedRuns.length;
  const effectiveDaemonObservedAt = preferLocalBridge
    ? localBridge?.daemon.observedAt ?? snapshot?.daemon?.observedAt ?? null
    : snapshot?.daemon?.observedAt ?? null;
  const effectiveDaemonUpdatedAt = preferLocalBridge
    ? localDaemonStatus?.updatedAt ?? localBridge?.daemon.updatedAt ?? snapshot?.daemon?.updatedAt ?? null
    : snapshot?.daemon?.updatedAt ?? null;
  const effectiveDaemonSource = preferLocalBridge
    ? localDaemonStatus?.source ?? localBridge?.daemon.source ?? snapshot?.daemon?.source ?? null
    : snapshot?.daemon?.source ?? null;
  const effectiveDaemonVersion = preferLocalBridge
    ? localDaemonStatus?.version ?? snapshot?.daemon?.version ?? null
    : snapshot?.daemon?.version ?? null;
  const effectiveRateLimitStatus = preferLocalBridge
    ? localDaemonStatus?.rateLimitStatus ?? snapshot?.daemon?.rateLimitStatus ?? null
    : snapshot?.daemon?.rateLimitStatus ?? null;
  const effectiveDaemonAgeMs = effectiveDaemonObservedAt != null ? Math.max(0, Date.now() - effectiveDaemonObservedAt) : null;
  const effectiveDaemonLooksStale = effectiveDaemonAgeMs != null && effectiveDaemonAgeMs > 90_000;
  const effectiveRuns = useMemo(
    () => (preferLocalBridge && (localBridge?.runs?.length ?? 0) > 0 ? localBridge.runs : activeRuns),
    [activeRuns, localBridge, preferLocalBridge],
  );
  const latestActiveRun = useMemo(() => {
    if (effectiveRuns.length === 0) return null;
    return [...effectiveRuns].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }, [effectiveRuns]);
  const latestActiveStep = useMemo(() => {
    if (!latestActiveRun) return null;
    return [...latestActiveRun.steps].reverse().find((step) => step.status === 'running')
      ?? [...latestActiveRun.steps].reverse()[0]
      ?? null;
  }, [latestActiveRun]);
  const effectiveBlockers = useMemo(
    () => (preferLocalBridge ? (localBridge?.blockers ?? []) : (snapshot?.blockers ?? [])),
    [localBridge, preferLocalBridge, snapshot],
  );
  const primaryBlocker = effectiveBlockers[0] ?? null;
  const blockerCount = effectiveBlockers.length;
  const rolloutActiveRuns = snapshot?.autonomy.reduce((sum, health) => sum + health.activeRuns, 0) ?? 0;
  const hasLiveSignals = effectiveActiveRunCount > 0 || rolloutActiveRuns > 0 || connected || localBridgeLooksFresh || localDaemonAlive;
  const daemonStateLabel = effectiveDaemonLooksStale
    ? hasLiveSignals ? 'active (sync stale)' : 'stale'
    : hasLiveSignals ? 'active' : blockerCount > 0 ? 'blocked' : 'idle';
  const localOnlyActive = !latestActiveRun && preferLocalBridge && (localBridge?.activeRuns ?? 0) > 0;
  const localOnlyBlocked = !latestActiveRun && preferLocalBridge && (localBridge?.activeRuns ?? 0) === 0 && (localBridge?.pausedRuns ?? 0) > 0;
  const currentStatusTitle = latestActiveRun
    ? `${latestActiveRun.agent} is running ${workflowLabel(latestActiveRun.workflowKind)}`
    : localOnlyActive
      ? 'Local daemon is still running work'
    : localOnlyBlocked
      ? 'No task is actively running right now'
    : primaryBlocker
      ? primaryBlocker.title
      : 'Idle and ready for the next step';
  const currentStatusDetail = latestActiveRun
    ? latestActiveStep?.detail
      ?? `${latestActiveRun.agent} is the current owner of this step. Last update ${formatTime(latestActiveRun.updatedAt)}.`
    : localOnlyActive
      ? 'The local daemon reports active work, but the hosted runtime snapshot is lagging behind. This view is falling back to local truth.'
    : localOnlyBlocked
      ? `The local daemon reports ${localBridge?.pausedRuns ?? 0} paused or retry-scheduled run(s). Organism is waiting on recovery or retry, not actively executing a task right now.`
    : primaryBlocker
      ? primaryBlocker.detail
      : 'No active run is visible right now. If the project is eligible, Organism should pick up the next safe step automatically.';
  const nextAutomaticStep = latestActiveRun
    ? latestActiveRun.workflowKind === 'review'
      ? 'When this review finishes, Organism should choose the next safe task automatically.'
      : latestActiveRun.workflowKind === 'implement' || latestActiveRun.workflowKind === 'recover'
        ? 'When this implementation finishes cleanly, Organism should validate it automatically.'
        : latestActiveRun.workflowKind === 'validate'
          ? 'When this validation finishes, Organism should either continue with the next safe task or stop with one clear blocker.'
          : 'When this step finishes, Organism should keep the cycle moving automatically.'
    : localOnlyActive
      ? 'The current work should keep moving automatically once the hosted snapshot catches up.'
    : localOnlyBlocked
      ? 'Organism is waiting for the next retry or recovery step in the local review lane.'
    : primaryBlocker
      ? primaryBlocker.kind === 'review_retry'
        ? 'Organism is waiting for the next automatic retry in the review lane.'
        : primaryBlocker.kind === 'awaiting_review'
          ? 'The next move is for the review lane to clear these completed tasks.'
          : 'Organism is paused behind this blocker until recovery or review clears it.'
      : selectedAutonomy?.rolloutReady
        ? 'The project is in a clean state. Organism should keep iterating on the next safe task.'
        : 'Organism should start the next review shortly once the current idle cooldown passes.';
  const projectState = latestActiveRun || localOnlyActive
    ? 'working'
    : primaryBlocker || localOnlyBlocked
      ? 'blocked'
      : 'ready';
  const projectStateTone = projectState === 'working'
    ? 'text-emerald-400'
    : projectState === 'blocked'
      ? 'text-amber-300'
      : 'text-sky-300';
  const projectStateSummary = projectState === 'working'
    ? currentStatusDetail
    : projectState === 'blocked'
      ? currentStatusDetail
      : selectedAutonomy?.rolloutReady
        ? 'The project is clean enough for Organism to keep choosing the next safe step automatically.'
        : 'No active task is visible right now. Organism is waiting for the next safe review or cooldown window.';
  const projectStateSource = preferLocalBridge ? 'local daemon truth' : 'synced hosted state';
  const suppressHostedHistory = preferLocalBridge && effectiveDaemonLooksStale;

  return (
    <>
      <Header title="Runtime" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6 space-y-5">
        <section className="bg-surface rounded-xl border border-edge p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Current project state</div>
              <div className={`mt-2 text-lg font-semibold capitalize ${projectStateTone}`}>{projectState}</div>
              <p className="mt-2 text-sm text-zinc-400">{projectStateSummary}</p>
            </div>
            <div className="text-xs text-zinc-500">
              Source: <span className="text-zinc-300">{projectStateSource}</span>
            </div>
          </div>
        </section>

        <section className="bg-surface rounded-xl border border-edge p-5">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="rounded-xl border border-edge bg-surface-alt/20 p-4 lg:col-span-2">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Doing now</div>
              <div className="mt-2 text-base font-semibold text-zinc-100">{currentStatusTitle}</div>
              <p className="mt-2 text-sm text-zinc-400">{currentStatusDetail}</p>
            </div>
            <div className="rounded-xl border border-edge bg-surface-alt/20 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Next automatic step</div>
              <p className="mt-2 text-sm text-zinc-300">{nextAutomaticStep}</p>
              {selectedAutonomy && (
                <div className="mt-3 text-xs text-zinc-500">
                  Rollout: <span className={rolloutTone(selectedAutonomy.rolloutStage)}>{selectedAutonomy.rolloutStage}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="bg-surface rounded-xl border border-edge p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Runtime Details</h3>
              <p className="text-xs text-zinc-500 mt-1">Backend, executor, freshness, and safety posture.</p>
            </div>
            {effectiveDaemonVersion && (
              <span className="text-xs text-zinc-500">v{effectiveDaemonVersion}</span>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Model backend: {effectiveRuntime?.modelBackend ?? 'unknown'}
            </div>
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Code executor: {effectiveRuntime?.codeExecutor ?? 'unknown'}
            </div>
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Web search: {effectiveRuntime?.webSearchAvailable ? 'available' : 'unavailable'}
            </div>
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Paused runs: {effectivePausedRunCount}
            </div>
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Pending interrupts: {snapshot?.interrupts.filter((item) => item.status === 'pending').length ?? 0}
            </div>
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Rate limit: {effectiveRateLimitStatus?.limited ? `yes (${(effectiveRateLimitStatus.usagePct ?? 0).toFixed(0)}%)` : 'clear'}
            </div>
            <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
              Daemon state: {daemonStateLabel}
            </div>
          </div>
          {preferLocalBridge && (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Local daemon truth is overriding stale hosted runtime state for this view.
            </div>
          )}
          {(effectiveDaemonUpdatedAt || effectiveDaemonSource || effectiveDaemonAgeMs != null) && (
            <div className="mt-3 text-xs text-zinc-500">
              Last daemon update: {effectiveDaemonUpdatedAt ?? 'unknown'}
              {effectiveDaemonSource ? ` · source ${effectiveDaemonSource}` : ''}
              {effectiveDaemonAgeMs != null ? ` · age ${formatDuration(effectiveDaemonAgeMs)}` : ''}
            </div>
          )}
          {effectiveDaemonLooksStale && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
              The dashboard snapshot is stale. The daemon has not reported fresh synced state for {formatDuration(effectiveDaemonAgeMs)}.
              {hasLiveSignals
                ? ' Live run activity still exists, so the daemon should be treated as active while sync catches up.'
                : ' The website may still show old in-progress cards until the next successful sync.'}
            </div>
          )}
          {effectiveBlockers.length ? (
            <div className="mt-4 space-y-2">
              {effectiveBlockers.map((blocker) => (
                <div
                  key={`${blocker.kind}-${blocker.taskIds.join('-')}`}
                  className={`rounded-lg border p-3 text-xs ${
                    blocker.severity === 'critical'
                      ? 'border-red-500/30 bg-red-500/10 text-red-200'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  }`}
                >
                  <div className="font-semibold">{blocker.title}</div>
                  <div className="mt-1 opacity-90">{blocker.detail}</div>
                </div>
              ))}
            </div>
          ) : null}
          {effectiveRateLimitStatus?.limited && effectiveRateLimitStatus.resetsAt && (
            <div className="mt-3 text-xs text-amber-400">
              Provider rate limit active until {effectiveRateLimitStatus.resetsAt}
            </div>
          )}
          {selectedReadiness && (
            <div className="mt-4 rounded-lg border border-edge bg-surface-alt/20 p-3 text-xs">
              <div className="text-zinc-200">
                Launch readiness for <span className="font-semibold">{selectedReadiness.projectId}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 lg:grid-cols-6 gap-3 text-zinc-300">
                <div>Worktree: {selectedReadiness.cleanWorktree ? 'clean' : 'dirty'}</div>
                <div>Workspace mode: {selectedReadiness.workspaceMode}</div>
                <div>Deploy gate: {selectedReadiness.deployUnlocked ? 'open' : 'PR-only'}</div>
                <div>PR auth: {selectedReadiness.prAuthReady ? selectedReadiness.prAuthMode : 'not ready'}</div>
                <div>Deploy auth: {selectedReadiness.vercelAuthReady ? selectedReadiness.vercelAuthMode : 'not ready'}</div>
                <div>MiniMax: {selectedReadiness.minimax.enabled ? (selectedReadiness.minimax.ready ? 'ready' : 'not ready') : 'off'}</div>
              </div>
              {selectedReadiness.initialWorkflowGuardActive && (
                <div className="mt-2 text-amber-400">
                  Early launch guard: only {selectedReadiness.initialAllowedWorkflows.join(', ')} are allowed for the first {selectedReadiness.initialWorkflowLimit} completed goals.
                  {' '}Completed goals so far: {selectedReadiness.completedRuns}.
                </div>
              )}
              {selectedReadiness.blockers.length > 0 && (
                <div className="mt-2 space-y-1">
                  {selectedReadiness.blockers.map((blocker) => (
                    <div key={blocker} className="text-amber-400">{blocker}</div>
                  ))}
                </div>
              )}
              {selectedReadiness.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  {selectedReadiness.warnings.map((warning) => (
                    <div key={warning} className="text-zinc-500">{warning}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="bg-surface rounded-xl border border-edge p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Recent Output</h3>
              <p className="text-xs text-zinc-500 mt-1">The latest patch, verification, report, or task output that actually moved the project forward.</p>
            </div>
            <span className="text-xs text-zinc-500">{snapshot?.usefulOutputs.length ?? 0} surfaced</span>
          </div>
          <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
            {suppressHostedHistory ? (
              <div className="rounded-lg border border-edge bg-surface-alt/20 p-4 text-sm text-zinc-500 xl:col-span-2">
                Hosted output history is hidden for now because local daemon truth is fresher than the synced website snapshot.
              </div>
            ) : snapshot?.usefulOutputs.length ? snapshot.usefulOutputs.map((item) => (
              <div key={item.id} className="rounded-lg border border-edge/60 bg-surface-alt/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm text-zinc-100">{item.title}</div>
                    <div className="text-xs text-zinc-500 mt-1">{item.meta}</div>
                  </div>
                  <span className="text-[11px] text-zinc-500">{formatTime(item.createdAt)}</span>
                </div>
                {item.summary && (
                  <pre className="mt-3 whitespace-pre-wrap text-xs text-zinc-400 font-mono">
                    {item.summary}
                  </pre>
                )}
              </div>
            )) : (
              <div className="rounded-lg border border-edge bg-surface-alt/20 p-4 text-sm text-zinc-500">
                No useful output has been captured for this project yet.
              </div>
            )}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <section className="bg-surface rounded-xl border border-edge p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Current Work</h3>
                <p className="text-xs text-zinc-500 mt-1">The active runs and their latest visible steps.</p>
              </div>
              <span className={`text-xs font-medium ${(preferLocalBridge || connected) ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {preferLocalBridge ? 'local live' : connected ? 'stream connected' : 'reconnecting'}
              </span>
            </div>

            <div className="space-y-3">
              {effectiveRuns.length === 0 && (
                <div className="rounded-lg border border-edge bg-surface-alt/30 p-4 text-sm text-zinc-500">
                  {effectiveBlockers.length
                    ? 'No active runs right now. Organism is blocked on the items surfaced above.'
                    : 'No active runs right now.'}
                </div>
              )}

              {effectiveRuns.map((run) => (
                <article key={run.id} className="rounded-xl border border-edge bg-surface-alt/20 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">{run.agent}</div>
                      <div className="text-xs text-zinc-500 mt-1">
                        {run.workflowKind} · updated {formatTime(run.updatedAt)}
                      </div>
                    </div>
                    <div className={`text-xs font-semibold uppercase tracking-wider ${statusTone(run.status)}`}>
                      {run.status}
                    </div>
                  </div>
                  <div className="mt-3">
                    <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-500">
                      <span>
                        {run.progressPct != null ? `${run.progressPct}% estimated` : 'estimating progress'}
                        {run.progressBasis !== 'none' ? ` · ${run.progressBasis}` : ''}
                      </span>
                      <span>
                        elapsed {formatDuration(run.elapsedMs)}
                        {run.estimatedDurationMs != null ? ` · ETA ${formatEta(run)}` : ''}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-900/80">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                        style={{ width: `${run.progressPct ?? 8}%` }}
                      />
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {run.steps.slice(-4).map((step) => (
                      <div key={step.id} className="rounded-lg border border-edge/60 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-zinc-200">{step.name}</span>
                          <span className={`text-[11px] uppercase tracking-wider ${statusTone(step.status)}`}>{step.status}</span>
                        </div>
                        {step.detail && (
                          <p className="text-xs text-zinc-500 mt-1">{step.detail}</p>
                        )}
                      </div>
                    ))}
                  </div>
                  {(run.retryClass !== 'none' || run.providerFailureKind !== 'none') && (
                    <div className="mt-3 text-xs text-amber-400">
                      {run.retryClass} · {run.providerFailureKind}
                      {run.retryAt ? ` · resumes ${formatTime(run.retryAt)}` : ''}
                    </div>
                  )}
                  {Date.now() - run.updatedAt > 120_000 && run.status === 'running' && (
                    <div className="mt-3 text-xs text-amber-400">
                      No heartbeat for {formatDuration(Date.now() - run.updatedAt)}. The executor may be stalled or waiting on a provider/tool response.
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="bg-surface rounded-xl border border-edge p-5">
            <h3 className="text-sm font-semibold text-zinc-100">Interrupt Queue</h3>
            <p className="text-xs text-zinc-500 mt-1 mb-4">Approval and information pauses surfaced directly from the controller.</p>
            <div className="space-y-3">
              {snapshot?.interrupts.length ? snapshot.interrupts.slice(0, 6).map((interrupt) => (
                <div key={interrupt.id} className="rounded-lg border border-edge bg-surface-alt/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-200">{interrupt.summary}</span>
                    <span className={`text-[11px] uppercase tracking-wider ${statusTone(interrupt.status)}`}>{interrupt.status}</span>
                  </div>
                  {interrupt.detail && <p className="text-xs text-zinc-500 mt-1">{interrupt.detail}</p>}
                </div>
              )) : (
                <div className="rounded-lg border border-edge bg-surface-alt/20 p-4 text-sm text-zinc-500">
                  No pending interrupts.
                </div>
              )}
            </div>

            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mt-6 mb-3">Pending approvals</h4>
            <div className="space-y-2">
              {snapshot?.approvals.length ? snapshot.approvals.slice(0, 6).map((approval) => (
                <div key={approval.id} className="rounded-lg border border-edge/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-200">{approval.action}</span>
                    <span className={`text-[11px] uppercase tracking-wider ${statusTone(approval.status)}`}>{approval.status}</span>
                  </div>
                  {approval.reason && <p className="text-xs text-zinc-500 mt-1">{approval.reason}</p>}
                </div>
              )) : (
                <div className="text-sm text-zinc-500">No pending approvals.</div>
              )}
            </div>
          </section>
        </div>

        {!suppressHostedHistory && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <section className="bg-surface rounded-xl border border-edge p-5">
              <h3 className="text-sm font-semibold text-zinc-100 mb-4">Goals</h3>
              <div className="space-y-3">
                {snapshot?.goals.length ? snapshot.goals.map((goal) => (
                  <div key={goal.id} className="rounded-lg border border-edge/60 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm text-zinc-100">{goal.title}</div>
                        <div className="text-xs text-zinc-500 mt-1">
                          {goal.projectId} · {goal.workflowKind} · {goal.sourceKind}
                        </div>
                      </div>
                      <span className={`text-[11px] uppercase tracking-wider ${statusTone(goal.status)}`}>{goal.status}</span>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm text-zinc-500">No goals recorded yet.</div>
                )}
              </div>
            </section>

            <section className="bg-surface rounded-xl border border-edge p-5">
              <h3 className="text-sm font-semibold text-zinc-100 mb-4">Fork Comparison Targets</h3>
              <div className="space-y-3">
                {snapshot?.compareTargets.length ? snapshot.compareTargets.map((target) => (
                  <div key={`${target.projectId}-${target.current.project}`} className="rounded-lg border border-edge/60 px-3 py-3">
                    <div className="text-sm text-zinc-100">{target.label}</div>
                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="rounded-lg bg-surface-alt/30 p-3">
                        <div className="text-zinc-500 uppercase tracking-wider mb-1">Current</div>
                        <div className="text-zinc-200">{target.current.project}</div>
                        {target.current.url && (
                          <a href={target.current.url} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300">
                            {target.current.url}
                          </a>
                        )}
                      </div>
                      <div className="rounded-lg bg-surface-alt/30 p-3">
                        <div className="text-zinc-500 uppercase tracking-wider mb-1">Fork / v2</div>
                        <div className="text-zinc-200">{target.forked.project}</div>
                        {target.forked.url && (
                          <a href={target.forked.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300">
                            {target.forked.url}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm text-zinc-500">No deploy targets available yet.</div>
                )}
              </div>
            </section>
          </div>
        )}

        <section className="bg-surface rounded-xl border border-edge p-5">
          <h3 className="text-sm font-semibold text-zinc-100 mb-4">Autonomy Rollout</h3>
          <div className="space-y-3">
            {snapshot?.autonomy.length ? snapshot.autonomy.map((projectHealth) => (
              <div key={projectHealth.projectId} className="rounded-lg border border-edge/60 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm text-zinc-100">{projectHealth.projectId}</div>
                      <div className="text-xs text-zinc-500 mt-1">
                        {projectHealth.autonomyMode} · {projectHealth.nextRolloutThreshold ?? projectHealth.requiredConsecutiveRuns} goal milestone
                      </div>
                    </div>
                  <span className={`text-[11px] uppercase tracking-wider ${projectHealth.rolloutReady ? 'text-emerald-400' : rolloutTone(projectHealth.rolloutStage)}`}>
                    {projectHealth.rolloutReady ? 'ready' : projectHealth.rolloutStage.replace('_', ' ')}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">
                    Healthy goals: {projectHealth.consecutiveHealthyRuns}/{projectHealth.nextRolloutThreshold ?? projectHealth.requiredConsecutiveRuns}
                  </div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Completed goals: {projectHealth.recentCompletedRuns}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Provider failures: {projectHealth.recentProviderFailures}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Active runs: {projectHealth.activeRuns}</div>
                </div>
                {projectHealth.nextRolloutLabel && (
                  <div className="mt-3 text-xs text-zinc-500">
                    Next milestone: {projectHealth.nextRolloutLabel}
                  </div>
                )}
                <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Pending approvals: {projectHealth.pendingApprovals}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Pending interrupts: {projectHealth.pendingInterrupts}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Core agents: {projectHealth.coreAgents.length}</div>
                </div>
                {projectHealth.blockers.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {projectHealth.blockers.map((blocker) => (
                      <div key={blocker} className="text-xs text-amber-400">{blocker}</div>
                    ))}
                  </div>
                )}
              </div>
            )) : (
              <div className="text-sm text-zinc-500">No autonomy rollout data yet.</div>
            )}
          </div>
        </section>

        {!suppressHostedHistory && (
          <section className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-zinc-100">Live Event Feed</h3>
              <span className="text-xs text-zinc-500">{snapshot?.recentEvents.length ?? 0} events loaded</span>
            </div>
            <div className="space-y-2 max-h-[28rem] overflow-y-auto">
              {snapshot?.recentEvents.length ? snapshot.recentEvents.slice().reverse().map((event) => (
                <div key={event.id} className="rounded-lg border border-edge/60 px-3 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-zinc-100">{event.eventType}</span>
                    <span className="text-xs text-zinc-500">{formatTime(event.ts)}</span>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-500 font-mono">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </div>
              )) : (
                <div className="text-sm text-zinc-500">No runtime events yet.</div>
              )}
            </div>
          </section>
        )}

        {!suppressHostedHistory && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <section className="bg-surface rounded-xl border border-edge p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-zinc-100">Recent Outputs</h3>
                <span className="text-xs text-zinc-500">{snapshot?.recentOutputs.length ?? 0} captured</span>
              </div>
              <div className="space-y-3">
                {snapshot?.recentOutputs.length ? snapshot.recentOutputs.map((output) => (
                  <div key={output.id} className="rounded-lg border border-edge/60 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm text-zinc-100">{output.agent}</div>
                        <div className="text-xs text-zinc-500 mt-1">
                          {output.description}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-[11px] uppercase tracking-wider ${statusTone(output.status)}`}>{output.status}</div>
                        <div className="text-[11px] text-zinc-500 mt-1">{formatTime(output.completedAt ?? output.createdAt)}</div>
                      </div>
                    </div>
                    {trimPreview(output.summary) && (
                      <pre className="mt-3 whitespace-pre-wrap text-xs text-zinc-400 font-mono">
                        {trimPreview(output.summary)}
                      </pre>
                    )}
                  </div>
                )) : (
                  <div className="text-sm text-zinc-500">No captured task outputs yet.</div>
                )}
              </div>
            </section>

            <section className="bg-surface rounded-xl border border-edge p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-zinc-100">Artifacts</h3>
                <span className="text-xs text-zinc-500">{snapshot?.artifacts.length ?? 0} recorded</span>
              </div>
              <div className="space-y-3">
                {snapshot?.artifacts.length ? snapshot.artifacts.map((artifact) => (
                  <div key={artifact.id} className="rounded-lg border border-edge/60 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm text-zinc-100">{artifact.title}</div>
                        <div className="text-xs text-zinc-500 mt-1">
                          {artifact.kind}{artifact.path ? ` · ${artifact.path}` : ''}
                        </div>
                      </div>
                      <span className="text-[11px] text-zinc-500">{formatTime(artifact.createdAt)}</span>
                    </div>
                    {trimPreview(artifact.content) && (
                      <pre className="mt-3 whitespace-pre-wrap text-xs text-zinc-400 font-mono">
                        {trimPreview(artifact.content)}
                      </pre>
                    )}
                  </div>
                )) : (
                  <div className="text-sm text-zinc-500">No controller artifacts yet.</div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
