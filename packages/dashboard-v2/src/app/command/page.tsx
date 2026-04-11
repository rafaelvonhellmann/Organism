'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '@/components/header';
import { cleanForDisplay } from '@/lib/markdown';

interface Action {
  id: number;
  action: string;
  payload: string;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
}

export default function CommandPage() {
  const [project, setProject] = useState('');
  const [command, setCommand] = useState('');
  const [actions, setActions] = useState<Action[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchActions = useCallback(async () => {
    try {
      const res = await fetch('/api/actions', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setActions(data.actions ?? []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchActions();
    const id = setInterval(fetchActions, 5000);
    return () => clearInterval(id);
  }, [fetchActions]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [actions]);

  const sendCommand = async (cmd: string) => {
    if (!cmd.trim()) return;
    if (!project) {
      setError('Select a project before launching work from the dashboard.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'command', payload: { command: cmd.trim(), project } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed to create action' }));
        throw new Error(body.error ?? 'Failed to create action');
      }
      setCommand('');
      setTimeout(fetchActions, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit command');
    }
    finally { setSending(false); }
  };

  const quickActions = [
    { label: 'Review Project', cmd: 'review project' },
    { label: 'Execute Tasks', cmd: 'execute' },
    { label: 'Status', cmd: 'status' },
    { label: 'Palate Stats', cmd: 'palate stats' },
    { label: 'Morning Brief', cmd: 'morning brief' },
  ];

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
                <p className="text-sm text-zinc-500">Type any Organism command below, or use the quick actions.</p>
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
