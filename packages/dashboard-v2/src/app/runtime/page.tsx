'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/header';

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
  goals: RuntimeGoal[];
  runs: RuntimeRun[];
  interrupts: RuntimeInterrupt[];
  approvals: RuntimeApproval[];
  recentEvents: RuntimeEvent[];
  compareTargets: CompareTarget[];
  autonomy: AutonomyHealth[];
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

export default function RuntimePage() {
  const [project, setProject] = useState('');
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
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

  useEffect(() => {
    fetchSnapshot().catch(() => {});
  }, [fetchSnapshot]);

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

  return (
    <>
      <Header title="Runtime" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6 space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <section className="bg-surface rounded-xl border border-edge p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Live Runs</h3>
                <p className="text-xs text-zinc-500 mt-1">AG-UI style live state: goals, agents, steps, interrupts, and approvals.</p>
              </div>
              <span className={`text-xs font-medium ${connected ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {connected ? 'stream connected' : 'reconnecting'}
              </span>
            </div>

            <div className="space-y-3">
              {activeRuns.length === 0 && (
                <div className="rounded-lg border border-edge bg-surface-alt/30 p-4 text-sm text-zinc-500">
                  No active runs right now.
                </div>
              )}

              {activeRuns.map((run) => (
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

        <section className="bg-surface rounded-xl border border-edge p-5">
          <h3 className="text-sm font-semibold text-zinc-100 mb-4">Autonomy Rollout</h3>
          <div className="space-y-3">
            {snapshot?.autonomy.length ? snapshot.autonomy.map((projectHealth) => (
              <div key={projectHealth.projectId} className="rounded-lg border border-edge/60 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm text-zinc-100">{projectHealth.projectId}</div>
                    <div className="text-xs text-zinc-500 mt-1">
                      {projectHealth.autonomyMode} · {projectHealth.consecutiveHealthyRuns}/{projectHealth.requiredConsecutiveRuns} healthy runs
                    </div>
                  </div>
                  <span className={`text-[11px] uppercase tracking-wider ${projectHealth.rolloutReady ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {projectHealth.rolloutReady ? 'ready' : 'stabilizing'}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Completed runs: {projectHealth.recentCompletedRuns}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Provider failures: {projectHealth.recentProviderFailures}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Active runs: {projectHealth.activeRuns}</div>
                  <div className="rounded-lg bg-surface-alt/30 p-3 text-zinc-300">Pending approvals: {projectHealth.pendingApprovals}</div>
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
      </div>
    </>
  );
}
