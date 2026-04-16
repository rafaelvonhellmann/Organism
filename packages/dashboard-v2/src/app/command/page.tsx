'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/header';
import { cleanForDisplay } from '@/lib/markdown';
import { getInitialSelectedProject } from '@/lib/selected-project';
import { loadDashboardActions, submitDashboardAction } from '@/lib/dashboard-action-client';
import { loadLocalDaemonStatus, loadLocalStartDecision, type LocalDaemonStatusSnapshot, type LocalStartDecisionSnapshot } from '@/lib/runtime-bridge-client';

interface Action {
  id: number;
  action: string;
  payload: string;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
}

interface LaunchReadiness {
  projectId: string;
  workspaceMode: string;
  deployUnlocked: boolean;
  prAuthReady: boolean;
  prAuthMode: string;
  vercelAuthReady: boolean;
  vercelAuthMode: string;
  completedRuns: number;
  initialWorkflowLimit: number;
  initialAllowedWorkflows: string[];
  initialWorkflowGuardActive: boolean;
  warnings: string[];
  minimax: {
    enabled: boolean;
    ready: boolean;
  };
}

interface AutonomyHealth {
  projectId: string;
  consecutiveHealthyRuns: number;
  requiredConsecutiveRuns: number;
  rolloutReady: boolean;
}

interface RuntimeSnapshot {
  autonomy: AutonomyHealth[];
  daemon: {
    observedAt?: number | null;
    runtime?: {
      modelBackend?: string | null;
      codeExecutor?: string | null;
      webSearchAvailable?: boolean;
    };
    readiness: LaunchReadiness[];
  } | null;
}

interface WorkflowAction {
  label: string;
  workflowKind: 'review' | 'implement' | 'validate';
  command: string;
  summary: string;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function canLaunchWorkflow(readiness: LaunchReadiness | null, workflow: string): boolean {
  if (!readiness) return false;
  if (!readiness.initialWorkflowGuardActive) return true;
  return readiness.initialAllowedWorkflows.includes(workflow);
}

function buildFallbackStartDecision(project: string | null, readiness: LaunchReadiness | null): LocalStartDecisionSnapshot | null {
  if (!project) return null;
  if (!readiness || readiness.initialWorkflowGuardActive) {
    return {
      projectId: project,
      mode: 'review',
      workflowKind: 'review',
      label: 'Start safe review',
      summary: 'Inspect the project and let Organism choose the next safe work.',
      reason: readiness?.initialWorkflowGuardActive
        ? `The early launch guard still allows only ${readiness.initialAllowedWorkflows.join(', ')}.`
        : 'No fresh local controller decision is available yet.',
      command: 'review project',
      state: {
        activeTasks: 0,
        activeRuns: 0,
        blockedTasks: 0,
        awaitingReview: 0,
        latestCompletedWorkflow: null,
        initialWorkflowGuardActive: readiness?.initialWorkflowGuardActive ?? false,
      },
    };
  }

  return {
    projectId: project,
    mode: 'implement',
    workflowKind: 'implement',
    label: 'Continue with the next task',
    summary: 'Let Organism choose the next bounded task and keep the project moving.',
    reason: 'No fresh local controller decision is available yet.',
    command: `implement the next safest useful task for ${project}`,
    state: {
      activeTasks: 0,
      activeRuns: 0,
      blockedTasks: 0,
      awaitingReview: 0,
      latestCompletedWorkflow: null,
      initialWorkflowGuardActive: readiness.initialWorkflowGuardActive,
    },
  };
}

function normalizeReadiness(item: LocalDaemonStatusSnapshot['readiness'][number]): LaunchReadiness {
  return {
    projectId: item.projectId ?? '',
    workspaceMode: item.workspaceMode ?? 'direct',
    deployUnlocked: item.deployUnlocked ?? false,
    prAuthReady: item.prAuthReady ?? false,
    prAuthMode: item.prAuthMode ?? 'none',
    vercelAuthReady: item.vercelAuthReady ?? false,
    vercelAuthMode: item.vercelAuthMode ?? 'none',
    completedRuns: item.completedRuns ?? 0,
    initialWorkflowLimit: item.initialWorkflowLimit ?? 0,
    initialAllowedWorkflows: Array.isArray(item.initialAllowedWorkflows) ? item.initialAllowedWorkflows : [],
    initialWorkflowGuardActive: item.initialWorkflowGuardActive ?? false,
    warnings: Array.isArray(item.warnings) ? item.warnings : [],
    minimax: {
      enabled: item.minimax?.enabled ?? false,
      ready: item.minimax?.ready ?? false,
    },
  };
}

function normalizeAutonomy(item: LocalDaemonStatusSnapshot['autonomy'][number]): AutonomyHealth {
  return {
    projectId: item.projectId ?? '',
    consecutiveHealthyRuns: item.consecutiveHealthyRuns ?? 0,
    requiredConsecutiveRuns: item.requiredConsecutiveRuns ?? 3,
    rolloutReady: item.rolloutReady ?? false,
  };
}

export default function CommandPage() {
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [command, setCommand] = useState('');
  const [actions, setActions] = useState<Action[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [localDaemonStatus, setLocalDaemonStatus] = useState<LocalDaemonStatusSnapshot | null>(null);
  const [startDecision, setStartDecision] = useState<LocalStartDecisionSnapshot | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchActions = useCallback(async () => {
    try {
      const data = await loadDashboardActions(project || undefined);
      setActions(data);
    } catch {}
  }, [project]);

  useEffect(() => {
    fetchActions();
    const id = setInterval(fetchActions, 5000);
    return () => clearInterval(id);
  }, [fetchActions]);

  useEffect(() => {
    if (!project) {
      setRuntime(null);
      return;
    }
    fetch(`/api/runtime?project=${project}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => setRuntime(data))
      .catch(() => setRuntime(null));
  }, [project]);

  const fetchLocalDaemonStatus = useCallback(async () => {
    const data = await loadLocalDaemonStatus();
    setLocalDaemonStatus(data);
  }, []);

  useEffect(() => {
    fetchLocalDaemonStatus().catch(() => {});
    const id = setInterval(() => {
      fetchLocalDaemonStatus().catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [fetchLocalDaemonStatus]);

  useEffect(() => {
    let mounted = true;
    const fetchDecision = async () => {
      const decision = await loadLocalStartDecision(project || undefined);
      if (mounted) setStartDecision(decision);
    };
    fetchDecision().catch(() => {});
    const id = setInterval(() => { fetchDecision().catch(() => {}); }, 10_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [project]);

  const submitAction = useCallback(async (action: 'review' | 'command' | 'start', payload: Record<string, unknown>) => {
    const result = await submitDashboardAction({ action, payload });
    setActions((current) => [
      {
        id: -Date.now(),
        action,
        payload: JSON.stringify(payload),
        status: 'pending',
        result: result.via === 'local' ? 'Queued via local daemon bridge' : null,
        created_at: Date.now(),
        completed_at: null,
      },
      ...current,
    ]);
    setTimeout(fetchActions, 1500);
    return result;
  }, [fetchActions]);

  const sendReview = useCallback(async () => {
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await submitAction('review', { project });
      setNotice('Review submitted. Organism is picking it up now.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setSending(false);
    }
  }, [project, submitAction]);

  const sendStartContinue = useCallback(async () => {
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await submitAction('start', { project });
      setNotice('Start / Continue submitted. Organism is choosing the next safe step now.');
      setTimeout(() => fetchActions(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit start request');
    } finally {
      setSending(false);
    }
  }, [fetchActions, project, submitAction]);

  const sendWorkflow = useCallback(async (workflowKind: 'review' | 'implement' | 'validate', cmd: string) => {
    if (!cmd.trim()) return;
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await submitAction('command', {
        command: cmd.trim(),
        project,
        workflowKind,
      });
      setCommand('');
      setNotice(`${workflowKind[0].toUpperCase()}${workflowKind.slice(1)} submitted. Organism is picking it up now.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit command');
    } finally {
      setSending(false);
    }
  }, [project, submitAction]);

  const sendAdvancedCommand = useCallback(async () => {
    if (!command.trim()) return;
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await submitAction('command', {
        command: command.trim(),
        project,
      });
      setCommand('');
      setNotice('Command submitted. Organism is picking it up now.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit command');
    } finally {
      setSending(false);
    }
  }, [command, project, submitAction]);

  const remoteObservedAt = runtime?.daemon?.observedAt ?? null;
  const localObservedAt = localDaemonStatus?.observedAt ?? null;
  const remoteLooksStale = remoteObservedAt != null && (Date.now() - remoteObservedAt) > 90_000;
  const preferLocalDaemonStatus = !!localDaemonStatus && (
    remoteObservedAt == null
    || remoteLooksStale
    || (localObservedAt ?? 0) > (remoteObservedAt ?? 0)
  );
  const selectedReadiness = project
    ? preferLocalDaemonStatus
      ? (() => {
          const localItem = localDaemonStatus?.readiness.find((item) => item.projectId === project);
          return localItem ? normalizeReadiness(localItem) : null;
        })()
      : runtime?.daemon?.readiness.find((item) => item.projectId === project) ?? null
    : null;
  const selectedAutonomy = project
    ? preferLocalDaemonStatus
      ? (() => {
          const localItem = localDaemonStatus?.autonomy.find((item) => item.projectId === project);
          return localItem ? normalizeAutonomy(localItem) : null;
        })()
      : runtime?.autonomy.find((item) => item.projectId === project) ?? null
    : null;
  const primaryDecision = useMemo(
    () => startDecision ?? buildFallbackStartDecision(project, selectedReadiness),
    [project, selectedReadiness, startDecision],
  );

  const workflowActions: WorkflowAction[] = useMemo(() => [
    {
      label: 'Review',
      workflowKind: 'review',
      command: 'review project',
      summary: 'Understand the current state and choose the next safe work.',
    },
    {
      label: 'Implement',
      workflowKind: 'implement',
      command: project ? `implement the next safest useful task for ${project}` : 'implement the next safest useful task',
      summary: 'Move the project forward with one bounded change.',
    },
    {
      label: 'Validate',
      workflowKind: 'validate',
      command: project ? `validate ${project} current state` : 'validate current state',
      summary: 'Check whether the latest work is clean, safe, and complete.',
    },
  ], [project]);

  const recentActions = actions.slice(0, 6);

  return (
    <>
      <Header
        title="Launch"
        project={project}
        onProjectChange={(next) => {
          setProject(next);
          if (next) setError(null);
        }}
        lastUpdated={null}
        allowAllProjects={false}
        autoSelectProject={false}
      />

      <div className="p-4 md:p-6 space-y-5">
        {!project && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
            Select a project first. Organism no longer auto-picks one for safety.
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {notice && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            {notice}
          </div>
        )}

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Start / Continue</h2>
              <p className="mt-1 text-sm text-zinc-500">
                One clear action to keep the project moving safely.
              </p>
            </div>
            {selectedAutonomy && (
              <div className="rounded-lg bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300">
                Healthy goals: {selectedAutonomy.consecutiveHealthyRuns}/{selectedAutonomy.requiredConsecutiveRuns}
              </div>
            )}
          </div>

          {primaryDecision && (
            <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-emerald-300">
                Next step: {primaryDecision.workflowKind}
              </div>
              <div className="mt-2 text-sm font-semibold text-zinc-100">
                {primaryDecision.summary}
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                {primaryDecision.reason}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-400">
                <span className="rounded-full border border-zinc-800 bg-zinc-950/70 px-2.5 py-1">
                  {selectedReadiness?.workspaceMode ?? 'workspace n/a'}
                </span>
                <span className="rounded-full border border-zinc-800 bg-zinc-950/70 px-2.5 py-1">
                  {selectedReadiness?.deployUnlocked ? 'deploy unlocked' : 'deploy gated'}
                </span>
                <span className="rounded-full border border-zinc-800 bg-zinc-950/70 px-2.5 py-1">
                  {selectedReadiness?.prAuthReady ? `PR ready via ${selectedReadiness.prAuthMode}` : 'PR auth not ready'}
                </span>
                {preferLocalDaemonStatus && (
                  <span className="rounded-full border border-amber-500/20 bg-amber-500/5 px-2.5 py-1 text-amber-300">
                    local daemon truth
                  </span>
                )}
              </div>
              <button
                onClick={sendStartContinue}
                disabled={sending || !project}
                className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {sending ? 'Starting...' : 'Start / Continue'}
              </button>
            </div>
          )}

          {selectedReadiness?.initialWorkflowGuardActive && (
            <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
              Early launch guard: only {selectedReadiness.initialAllowedWorkflows.join(', ')} are allowed until the first {selectedReadiness.initialWorkflowLimit} completed goals.
            </div>
          )}

          {selectedReadiness?.warnings.length ? (
            <div className="mt-3 space-y-1">
              {selectedReadiness.warnings.slice(0, 2).map((warning) => (
                <div key={warning} className="text-xs text-zinc-500">{warning}</div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <button
            onClick={() => setShowManual((current) => !current)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Manual Override</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Review, implement, or validate directly when you want to override the default next step.
              </p>
            </div>
            <span className="text-xs text-zinc-500">{showManual ? 'Hide' : 'Show'}</span>
          </button>

          {showManual && (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {workflowActions.map((item) => {
                const allowed = canLaunchWorkflow(selectedReadiness, item.workflowKind);
                return (
                  <div key={item.workflowKind} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-zinc-100">{item.label}</div>
                      <span className={`text-[11px] uppercase tracking-wider ${allowed ? 'text-emerald-400' : 'text-zinc-500'}`}>
                        {allowed ? 'allowed' : 'guarded'}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-zinc-500">{item.summary}</p>
                    <button
                      onClick={() => item.workflowKind === 'review'
                        ? sendReview()
                        : sendWorkflow(item.workflowKind, item.command)}
                      disabled={sending || !project || !allowed}
                      className="mt-4 w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Run {item.label}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <button
            onClick={() => setShowAdvanced((current) => !current)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Advanced</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Free-text commands are still here, but hidden by default.
              </p>
            </div>
            <span className="text-xs text-zinc-500">{showAdvanced ? 'Hide' : 'Show'}</span>
          </button>

          {showAdvanced && (
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-3">
                <span className="shrink-0 font-mono text-sm text-emerald-500">organism $</span>
                <input
                  type="text"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !sending) {
                      sendAdvancedCommand();
                    }
                  }}
                  placeholder={project ? `Type an advanced command for ${project}` : 'Select a project first'}
                  className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none"
                  disabled={sending || !project}
                />
                <button
                  onClick={sendAdvancedCommand}
                  disabled={sending || !project || !command.trim()}
                  className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                >
                  Run
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-100">Recent Launches</h2>
              <p className="mt-1 text-sm text-zinc-500">
                Only the latest few actions, so the page stays readable.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {recentActions.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-500">
                {project ? `No launches recorded for ${project} yet.` : 'Select a project to start.'}
              </div>
            ) : recentActions.map((action) => {
              const payload = parsePayload(action.payload);
              const label = typeof payload.command === 'string'
                ? payload.command
                : action.action === 'start'
                  ? 'start / continue'
                : action.action === 'review'
                  ? 'review project'
                  : action.action;
              const statusTone = action.status === 'completed'
                ? 'text-emerald-400'
                : action.status === 'failed'
                  ? 'text-red-400'
                  : action.status === 'pending'
                    ? 'text-amber-400'
                    : 'text-blue-400';

              return (
                <div key={action.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <code className="text-sm text-emerald-400">{label}</code>
                    <span className={`text-[11px] font-semibold uppercase ${statusTone}`}>{action.status}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-600">
                    {new Date(action.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  {action.result && (
                    <p className="mt-3 whitespace-pre-wrap text-xs text-zinc-300">
                      {cleanForDisplay(action.result)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}
