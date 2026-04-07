'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';

interface EvolutionRow {
  id: string;
  domain: string;
  status: string;
  model: string;
  fitnessScore: number | null;
  invocations: number;
  avgRating: number;
  totalCost: number;
}

function fitnessColor(score: number | null): string {
  if (score == null) return 'text-zinc-600';
  if (score > 0.7) return 'text-green-400';
  if (score >= 0.4) return 'text-amber-400';
  return 'text-red-400';
}

function fitnessBg(score: number | null): string {
  if (score == null) return 'bg-zinc-500/10';
  if (score > 0.7) return 'bg-green-500/10';
  if (score >= 0.4) return 'bg-amber-500/10';
  return 'bg-red-500/10';
}

function statusLabel(s: string): string {
  if (s === 'shadow') return 'Dormant';
  if (s === 'suspended') return 'Candidate';
  if (s === 'active') return 'Active';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusDot(s: string): string {
  if (s === 'active') return 'bg-green-500';
  if (s === 'shadow') return 'bg-amber-500';
  if (s === 'suspended') return 'bg-zinc-500';
  return 'bg-zinc-600';
}

export default function EvolutionPage() {
  const [project, setProject] = useState('');
  const { data: rows, lastUpdated } = usePolling<EvolutionRow[]>(
    project ? `/api/evolution?project=${project}` : '/api/evolution',
  );

  const data = rows ?? [];

  // Stats
  const withFitness = data.filter(r => r.fitnessScore != null);
  const avgFitness = withFitness.length > 0
    ? withFitness.reduce((sum, r) => sum + (r.fitnessScore ?? 0), 0) / withFitness.length
    : null;
  const totalInvocations = data.reduce((sum, r) => sum + r.invocations, 0);
  const totalCost = data.reduce((sum, r) => sum + r.totalCost, 0);

  return (
    <>
      <Header title="Evolution" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-6 space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-surface rounded-xl border border-edge p-4">
            <div className="text-xs text-zinc-500 mb-1">Perspectives</div>
            <div className="text-2xl font-semibold text-zinc-100">{data.length}</div>
          </div>
          <div className="bg-surface rounded-xl border border-edge p-4">
            <div className="text-xs text-zinc-500 mb-1">Avg Fitness</div>
            <div className={`text-2xl font-semibold font-mono ${fitnessColor(avgFitness)}`}>
              {avgFitness != null ? avgFitness.toFixed(2) : '---'}
            </div>
          </div>
          <div className="bg-surface rounded-xl border border-edge p-4">
            <div className="text-xs text-zinc-500 mb-1">Total Invocations</div>
            <div className="text-2xl font-semibold text-zinc-100">{totalInvocations}</div>
          </div>
          <div className="bg-surface rounded-xl border border-edge p-4">
            <div className="text-xs text-zinc-500 mb-1">Total Cost</div>
            <div className="text-2xl font-semibold text-zinc-100 font-mono">${totalCost.toFixed(2)}</div>
          </div>
        </div>

        {/* Fitness table */}
        <div className="bg-surface rounded-xl border border-edge overflow-hidden">
          <div className="px-4 py-3 border-b border-edge">
            <h3 className="text-sm font-semibold text-zinc-200">Darwinian Fitness</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Perspectives sorted by fitness score. High-fitness perspectives get prioritised; low-fitness go dormant.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge/50 text-xs text-zinc-500">
                  <th className="text-left px-4 py-3 font-medium">Perspective</th>
                  <th className="text-left px-4 py-3 font-medium">Domain</th>
                  <th className="text-right px-4 py-3 font-medium">Fitness</th>
                  <th className="text-right px-4 py-3 font-medium">Invocations</th>
                  <th className="text-right px-4 py-3 font-medium">Avg Rating</th>
                  <th className="text-right px-4 py-3 font-medium">Total Cost</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/30">
                {data.map(row => (
                  <tr key={row.id} className="hover:bg-surface-alt/30 transition-colors">
                    <td className="px-4 py-3">
                      <span className="text-zinc-200 font-medium">{row.id}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{row.domain}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono text-xs font-medium ${fitnessBg(row.fitnessScore)} ${fitnessColor(row.fitnessScore)}`}>
                        {row.fitnessScore != null ? row.fitnessScore.toFixed(2) : '---'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400 font-mono">
                      {row.invocations}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400 font-mono">
                      {row.avgRating > 0 ? row.avgRating.toFixed(1) : '---'}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400 font-mono">
                      ${row.totalCost.toFixed(4)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${statusDot(row.status)}`} />
                        <span className="text-xs text-zinc-400">{statusLabel(row.status)}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">🧬</div>
              <h3 className="text-lg font-semibold text-zinc-300 mb-2">No evolution data yet</h3>
              <p className="text-sm text-zinc-500 max-w-md mx-auto">
                Run a perspective review to start collecting fitness data.
                Organism will learn which perspectives produce value for each project.
              </p>
              <p className="text-xs text-zinc-600 mt-3 font-mono">
                npm run organism &quot;perspectives synapse&quot;
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
