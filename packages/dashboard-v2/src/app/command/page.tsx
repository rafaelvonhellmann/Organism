'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/header';
import { cleanForDisplay } from '@/lib/markdown';
import { getInitialSelectedProject } from '@/lib/selected-project';
import { loadDashboardActions, submitDashboardAction } from '@/lib/dashboard-action-client';

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
    readiness: LaunchReadiness[];
  } | null;
}

export default function CommandPage() {
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [command, setCommand] = useState('');
  const [actions, setActions] = useState<Action[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [actions]);

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

  const sendCommand = async (cmd: string, options?: { workflowKind?: string; canaryPreset?: boolean }) => {
    if (!cmd.trim()) return;
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const payload = {
        command: cmd.trim(),
        project,
        workflowKind: options?.workflowKind,
        canaryPreset: options?.canaryPreset === true,
      };
      const result = await submitDashboardAction({
        action: 'command',
        payload,
      });
      setActions((current) => [
        ...current,
        {
          id: -Date.now(),
          action: 'command',
          payload: JSON.stringify(payload),
          status: 'pending',
          result: result.via === 'local' ? 'Queued via local daemon bridge' : null,
          created_at: Date.now(),
          completed_at: null,
        },
      ]);
      setCommand('');
      setTimeout(fetchActions, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit command');
    }
    finally { setSending(false); }
  };

  const sendReview = async () => {
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const payload = { project, canaryPreset: true };
      const result = await submitDashboardAction({
        action: 'review',
        payload,
      });
      setActions((current) => [
        ...current,
        {
          id: -Date.now(),
          action: 'review',
          payload: JSON.stringify(payload),
          status: 'pending',
          result: result.via === 'local' ? 'Queued via local daemon bridge' : null,
          created_at: Date.now(),
          completed_at: null,
        },
      ]);
      setTimeout(fetchActions, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setSending(false);
    }
  };

  const quickActions = [
    { label: 'Review Project', cmd: 'review project' },
    { label: 'Execute Tasks', cmd: 'execute' },
    { label: 'Status', cmd: 'status' },
    { label: 'Palate Stats', cmd: 'palate stats' },
    { label: 'Morning Brief', cmd: 'morning brief' },
  ];

  const selectedReadiness = project ? runtime?.daemon?.readiness.find((item) => item.projectId === project) ?? null : null;
  const selectedAutonomy = project ? runtime?.autonomy.find((item) => item.projectId === project) ?? null : null;
  const canLaunchCanaryReview = project === 'tokens-for-good';

  return (
    <>
      <Header
        title="Command"
        project={project}
        onProjectChange={(next) => {
          setProject(next);
          if (next) setError(null);
        }}
        lastUpdated={null}
        allowAllProjects={false}
        autoSelectProject={false}
      />

      <div className="flex flex-col h-[calc(100vh-3.5rem)] md:h-screen">
        {/* Command history */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="max-w-3xl mx-auto space-y-3">
            {actions.length === 0 && (
              <div className="text-center py-16">
                <h3 className="text-lg font-semibold text-zinc-300 mb-2">Command Center</h3>
                <p className="text-sm text-zinc-500">
                  {project
                    ? `No dashboard actions recorded for ${project} yet.`
                    : 'Type any Organism command below, or use the quick actions.'}
                </p>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </div>
            )}

            {[...actions].reverse().map(a => {
              const payload = (() => { try { return JSON.parse(a.payload); } catch { return {}; } })();
              const cmdText = payload.command ?? a.action;
              const statusColor = a.status === 'completed' ? 'text-green-400' : a.status === 'failed' ? 'text-red-400' : a.status === 'pending' ? 'text-amber-400' : 'text-blue-400';
              const statusDot = a.status === 'completed' ? 'bg-green-500' : a.status === 'failed' ? 'bg-red-500' : 'bg-amber-500 animate-pulse';

              return (
                <div key={a.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2 h-2 rounded-full ${statusDot}`} />
                    <code className="text-sm text-emerald-400 font-mono flex-1">{cmdText}</code>
                    <span className={`text-[10px] ${statusColor} uppercase font-semibold`}>{a.status}</span>
                    <span className="text-[10px] text-zinc-600">
                      {new Date(a.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {a.result && (
                    <div className="mt-2 pt-2 border-t border-zinc-800/50">
                      <p className="text-xs text-zinc-300 whitespace-pre-wrap">{cleanForDisplay(a.result)}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Input area */}
        <div className="border-t border-zinc-800 bg-zinc-950 p-4">
          <div className="max-w-3xl mx-auto">
            {selectedReadiness && (
              <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-zinc-100">Launch posture for {project}</div>
                    <p className="mt-1 text-xs text-zinc-500">
                      Workspace, auth, and canary state before you launch anything.
                    </p>
                  </div>
                  {canLaunchCanaryReview && (
                    <button
                      onClick={sendReview}
                      disabled={sending}
                      className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      Launch Canary Repo Review
                    </button>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-3 text-xs text-zinc-300">
                  <div className="rounded-lg bg-zinc-950/70 p-3">Workspace: {selectedReadiness.workspaceMode}</div>
                  <div className="rounded-lg bg-zinc-950/70 p-3">PR path: {selectedReadiness.prAuthReady ? selectedReadiness.prAuthMode : 'not ready'}</div>
                  <div className="rounded-lg bg-zinc-950/70 p-3">Deploy path: {selectedReadiness.deployUnlocked ? 'open' : 'PR-only'}</div>
                  <div className="rounded-lg bg-zinc-950/70 p-3">Vercel auth: {selectedReadiness.vercelAuthReady ? selectedReadiness.vercelAuthMode : 'not ready'}</div>
                  <div className="rounded-lg bg-zinc-950/70 p-3">Healthy runs: {selectedAutonomy ? `${selectedAutonomy.consecutiveHealthyRuns}/${selectedAutonomy.requiredConsecutiveRuns}` : 'n/a'}</div>
                  <div className="rounded-lg bg-zinc-950/70 p-3">MiniMax: {selectedReadiness.minimax.enabled ? (selectedReadiness.minimax.ready ? 'ready' : 'not ready') : 'off'}</div>
                </div>

                {selectedReadiness.initialWorkflowGuardActive && (
                  <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
                    Early canary guard is active. For the first {selectedReadiness.initialWorkflowLimit} completed runs, only these workflows are allowed:
                    {' '}
                    {selectedReadiness.initialAllowedWorkflows.join(', ')}.
                    {' '}
                    Completed runs so far: {selectedReadiness.completedRuns}.
                  </div>
                )}

                {selectedReadiness.warnings.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {selectedReadiness.warnings.map((warning) => (
                      <div key={warning} className="text-xs text-zinc-500">
                        {warning}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Quick actions */}
            <div className="flex items-center gap-2 mb-3 overflow-x-auto">
              {quickActions.map(qa => (
                <button
                  key={qa.cmd}
                  onClick={() => sendCommand(qa.cmd)}
                  disabled={sending || !project}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 border border-zinc-700 transition-colors disabled:opacity-50"
                >
                  {qa.label}
                </button>
              ))}
              {project === 'tokens-for-good' && (
                <button
                  onClick={sendReview}
                  disabled={sending}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30 transition-colors disabled:opacity-50"
                >
                  Canary Repo Review
                </button>
              )}
            </div>

            {!project && (
              <p className="mb-3 text-xs text-amber-300">
                Select a project first. The dashboard no longer defaults to Synapse for safety.
              </p>
            )}

            {/* Command input */}
            <div className="flex items-center gap-2">
              <span className="text-emerald-500 font-mono text-sm shrink-0">organism $</span>
              <input
                type="text"
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !sending) sendCommand(command); }}
                placeholder={project ? `Type a command for ${project}...` : 'Select a project to unlock command launch'}
                className="flex-1 bg-transparent text-sm text-zinc-200 font-mono placeholder-zinc-600 focus:outline-none"
                disabled={sending || !project}
              />
              <button
                onClick={() => sendCommand(command)}
                disabled={sending || !command.trim() || !project}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Run'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
