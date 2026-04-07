'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { AgentCard } from '@/components/agent-card';
import { usePolling } from '@/hooks/use-polling';

interface AgentInfo {
  name: string;
  status: 'active' | 'shadow' | 'suspended';
  model: string;
  description: string;
  capabilities: string[];
  frequencyTier: string;
  spent: number;
  cap: number;
  pct: number;
  budgetStatus: 'ok' | 'warn' | 'crit' | 'idle';
  pendingTasks: number;
  completedToday: number;
  currentTask: { id: string; description: string; lane: string } | null;
}

export default function AgentsPage() {
  const [project, setProject] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'shadow' | 'suspended'>('all');
  const { data: agents, lastUpdated } = usePolling<AgentInfo[]>(
    project ? `/api/agents?project=${project}` : '/api/agents',


  );

  const filtered = agents?.filter(a => filter === 'all' || a.status === filter) ?? [];
  const counts = {
    all: agents?.length ?? 0,
    active: agents?.filter(a => a.status === 'active').length ?? 0,
    shadow: agents?.filter(a => a.status === 'shadow').length ?? 0,
    suspended: agents?.filter(a => a.status === 'suspended').length ?? 0,
  };

  return (
    <>
      <Header title="Agents" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-6 space-y-6">
        {/* Filter tabs */}
        <div className="flex gap-1 bg-zinc-800/50 rounded-lg p-1 w-fit">
          {(['all', 'active', 'shadow', 'suspended'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                filter === f
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-300'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="ml-1.5 text-zinc-500">{counts[f]}</span>
            </button>
          ))}
        </div>

        {/* Agent grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(agent => (
            <AgentCard key={agent.name} {...agent} />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-zinc-600">
            No agents match the filter
          </div>
        )}
      </div>
    </>
  );
}
