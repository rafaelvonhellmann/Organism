'use client';

import { useState, useMemo } from 'react';
import { Header } from '@/components/header';
import { TaskTable } from '@/components/task-table';
import { usePolling } from '@/hooks/use-polling';

const STATUSES = ['', 'pending', 'in_progress', 'completed', 'failed', 'dead_letter', 'rolled_back'];
const LANES = ['', 'LOW', 'MEDIUM', 'HIGH'];

export default function TasksPage() {
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [lane, setLane] = useState('');
  const [agent, setAgent] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (project) sp.set('project', project);
    if (status) sp.set('status', status);
    if (lane) sp.set('lane', lane);
    if (agent) sp.set('agent', agent);
    sp.set('limit', String(pageSize));
    sp.set('offset', String(page * pageSize));
    return sp.toString();
  }, [project, status, lane, agent, page]);

  const { data, lastUpdated } = usePolling<{
    tasks: Array<{
      id: string; agent: string; status: string; lane: string;
      description: string; costUsd: number | null; projectId: string;
      createdAt: number; completedAt: number | null;
    }>;
    total: number;
  }>(`/api/tasks?${params}`);

  // Read initial agent filter from URL search params (for cross-linking from agent cards)
  if (typeof window !== 'undefined' && !agent) {
    const urlAgent = new URLSearchParams(window.location.search).get('agent');
    if (urlAgent) setAgent(urlAgent);
  }

  return (
    <>
      <Header title="Tasks" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(0); }}
            className="bg-zinc-800 border border-edge rounded-md px-2.5 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500"
          >
            <option value="">All Statuses</option>
            {STATUSES.filter(Boolean).map(s => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>

          <select
            value={lane}
            onChange={e => { setLane(e.target.value); setPage(0); }}
            className="bg-zinc-800 border border-edge rounded-md px-2.5 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500"
          >
            <option value="">All Lanes</option>
            {LANES.filter(Boolean).map(l => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>

          <input
            type="text"
            value={agent}
            onChange={e => { setAgent(e.target.value); setPage(0); }}
            placeholder="Filter by agent..."
            className="bg-zinc-800 border border-edge rounded-md px-2.5 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500 w-44"
          />

          {(status || lane || agent) && (
            <button
              onClick={() => { setStatus(''); setLane(''); setAgent(''); setPage(0); }}
              className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Table */}
        <div className="bg-surface rounded-xl border border-edge overflow-hidden">
          <TaskTable
            tasks={data?.tasks ?? []}
            total={data?.total ?? 0}
            page={page}
            onPageChange={setPage}
            pageSize={pageSize}
          />
        </div>
      </div>
    </>
  );
}
