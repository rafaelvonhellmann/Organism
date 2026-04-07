'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { SpendBar } from '@/components/spend-bar';
import { usePolling } from '@/hooks/use-polling';

interface BudgetData {
  date: string;
  systemSpend: number;
  systemCap: number;
  systemPct: number;
  agents: Array<{
    name: string;
    spent: number;
    cap: number;
    pct: number;
    status: 'ok' | 'warn' | 'crit' | 'idle';
  }>;
}

export default function BudgetPage() {
  const [project, setProject] = useState('');
  const { data, lastUpdated } = usePolling<BudgetData>('/api/budget');

  const activeAgents = data?.agents.filter(a => a.spent > 0) ?? [];
  const idleAgents = data?.agents.filter(a => a.spent === 0) ?? [];

  return (
    <>
      <Header title="Budget" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-6 space-y-6">
        {/* System overview */}
        {data && (
          <div className="bg-surface rounded-xl border border-edge p-5">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-base font-semibold text-zinc-100">
                System Budget — {data.date}
              </h3>
              <span className={`text-lg font-semibold font-mono ${
                data.systemPct >= 90 ? 'text-red-400'
                : data.systemPct >= 80 ? 'text-amber-400'
                : 'text-green-400'
              }`}>
                ${data.systemSpend.toFixed(2)}
                <span className="text-zinc-600 text-sm font-normal"> / ${data.systemCap.toFixed(2)}</span>
              </span>
            </div>
            <SpendBar
              spent={data.systemSpend}
              cap={data.systemCap}
              pct={data.systemPct}
              status={data.systemPct >= 90 ? 'crit' : data.systemPct >= 80 ? 'warn' : 'ok'}
              showLabels={false}
            />
          </div>
        )}

        {/* Active agents table */}
        {activeAgents.length > 0 && (
          <div className="bg-surface rounded-xl border border-edge overflow-hidden">
            <div className="px-5 py-3 border-b border-edge">
              <h3 className="text-sm font-semibold text-zinc-200">
                Active Spend ({activeAgents.length})
              </h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="text-left py-2.5 px-5 font-medium">Agent</th>
                  <th className="text-left py-2.5 px-5 font-medium w-1/3">Usage</th>
                  <th className="text-right py-2.5 px-5 font-medium">Spent</th>
                  <th className="text-right py-2.5 px-5 font-medium">Cap</th>
                  <th className="text-right py-2.5 px-5 font-medium">%</th>
                </tr>
              </thead>
              <tbody>
                {activeAgents.map(agent => (
                  <tr key={agent.name} className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors">
                    <td className="py-3 px-5 font-medium text-zinc-200">{agent.name}</td>
                    <td className="py-3 px-5">
                      <SpendBar {...agent} showLabels={false} />
                    </td>
                    <td className="py-3 px-5 text-right font-mono text-zinc-300">
                      ${agent.spent.toFixed(4)}
                    </td>
                    <td className="py-3 px-5 text-right font-mono text-zinc-500">
                      ${agent.cap.toFixed(2)}
                    </td>
                    <td className={`py-3 px-5 text-right font-mono font-medium ${
                      agent.status === 'crit' ? 'text-red-400'
                      : agent.status === 'warn' ? 'text-amber-400'
                      : 'text-green-400'
                    }`}>
                      {agent.pct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Idle agents */}
        {idleAgents.length > 0 && (
          <div className="bg-surface rounded-xl border border-edge p-5">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">
              Idle Agents ({idleAgents.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {idleAgents.map(agent => (
                <span
                  key={agent.name}
                  className="px-2.5 py-1 rounded-md bg-zinc-800/50 text-xs text-zinc-500 border border-edge/50"
                >
                  {agent.name}
                  <span className="text-zinc-600 ml-1">${agent.cap.toFixed(2)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {!data && (
          <div className="text-center py-12 text-zinc-600">Loading budget data...</div>
        )}
      </div>
    </>
  );
}
