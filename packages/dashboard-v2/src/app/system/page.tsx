'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { SpendBar } from '@/components/spend-bar';
import { usePolling } from '@/hooks/use-polling';

// ── Types ──────────────────────────────────────────────────────

type Tab = 'budget' | 'agents' | 'knowledge' | 'logs';

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

interface AgentInfo {
  name: string;
  status: 'active' | 'shadow' | 'suspended';
  model: string;
  description: string;
  spent: number;
  cap: number;
  pct: number;
}

interface PalateSource {
  id: string;
  fitness: number;
  approved: boolean;
  totalInjections: number;
  tags: string[];
}

interface PalateData {
  sources: PalateSource[];
  stats: {
    totalInjections: number;
    totalSavings: number;
    savingsPercent: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

interface HistoryTask {
  id: string;
  agent: string;
  description: string;
  completedAt: number | null;
  gate: { decision: string; decidedAt: number | null };
}

// ── Helpers ────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-500/15 text-green-400',
  shadow: 'bg-amber-500/15 text-amber-400',
  suspended: 'bg-red-500/15 text-red-400',
};

const DECISION_BADGE: Record<string, { cls: string; label: string }> = {
  approved: { cls: 'bg-green-500/15 text-green-400', label: 'Approved' },
  changes_requested: { cls: 'bg-amber-500/15 text-amber-400', label: 'Changes' },
  rejected: { cls: 'bg-red-500/15 text-red-400', label: 'Rejected' },
};

function fitnessColor(f: number): string {
  if (f >= 0.6) return 'text-green-400';
  if (f >= 0.3) return 'text-yellow-400';
  return 'text-red-400';
}

function formatTime(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function briefTitle(desc: string): string {
  const first = desc.replace(/^[^:]*:\s*/, '').split(/[.!?\n]/)[0].trim();
  return first.length > 60 ? first.slice(0, 57) + '...' : first || desc.slice(0, 60);
}

// ── Tabs ───────────────────────────────────────────────────────

const TABS: { key: Tab; label: string }[] = [
  { key: 'budget', label: 'Budget' },
  { key: 'agents', label: 'Agents' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'logs', label: 'Logs' },
];

// ── Component ──────────────────────────────────────────────────

export default function SystemPage() {
  const [project, setProject] = useState('');
  const [tab, setTab] = useState<Tab>('budget');

  const { data: budget, lastUpdated: budgetUpdated } = usePolling<BudgetData>('/api/budget');
  const { data: agents, lastUpdated: agentsUpdated } = usePolling<AgentInfo[]>(
    project ? `/api/agents?project=${project}` : '/api/agents',
  );
  const { data: palate, lastUpdated: palateUpdated } = usePolling<PalateData>('/api/palate');
  const { data: history, lastUpdated: historyUpdated } = usePolling<{ tasks: HistoryTask[] }>('/api/history');

  const lastUpdated = { budget: budgetUpdated, agents: agentsUpdated, knowledge: palateUpdated, logs: historyUpdated }[tab];

  return (
    <>
      <Header title="System" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      {/* Tab bar */}
      <div className="border-b border-edge bg-surface/50 px-4 md:px-6">
        <div className="flex gap-1 -mb-px">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-emerald-500 text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-4">
        {/* ── Budget ──────────────────────────────────────── */}
        {tab === 'budget' && (
          <>
            {budget && (
              <div className="bg-surface rounded-xl border border-edge p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-zinc-200">System -- {budget.date}</span>
                  <span className={`text-lg font-mono font-semibold ${
                    budget.systemPct >= 90 ? 'text-red-400' : budget.systemPct >= 80 ? 'text-amber-400' : 'text-green-400'
                  }`}>
                    ${budget.systemSpend.toFixed(2)}
                    <span className="text-zinc-600 text-sm font-normal"> / ${budget.systemCap.toFixed(2)}</span>
                  </span>
                </div>
                <SpendBar spent={budget.systemSpend} cap={budget.systemCap} pct={budget.systemPct}
                  status={budget.systemPct >= 90 ? 'crit' : budget.systemPct >= 80 ? 'warn' : 'ok'} showLabels={false} />
              </div>
            )}
            {budget && budget.agents.filter(a => a.spent > 0).length > 0 && (
              <div className="bg-surface rounded-xl border border-edge overflow-hidden">
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
                    {budget.agents.filter(a => a.spent > 0).map(a => (
                      <tr key={a.name} className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors">
                        <td className="py-3 px-5 font-medium text-zinc-200">{a.name}</td>
                        <td className="py-3 px-5"><SpendBar {...a} showLabels={false} /></td>
                        <td className="py-3 px-5 text-right font-mono text-zinc-300">${a.spent.toFixed(4)}</td>
                        <td className="py-3 px-5 text-right font-mono text-zinc-500">${a.cap.toFixed(2)}</td>
                        <td className={`py-3 px-5 text-right font-mono font-medium ${
                          a.status === 'crit' ? 'text-red-400' : a.status === 'warn' ? 'text-amber-400' : 'text-green-400'
                        }`}>{a.pct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!budget && <div className="text-center py-12 text-zinc-600">Loading budget data...</div>}
          </>
        )}

        {/* ── Agents ──────────────────────────────────────── */}
        {tab === 'agents' && (
          <>
            {agents && agents.length > 0 ? (
              <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-edge text-xs text-zinc-500 uppercase tracking-wider">
                      <th className="text-left py-2.5 px-5 font-medium">Agent</th>
                      <th className="text-left py-2.5 px-5 font-medium">Status</th>
                      <th className="text-left py-2.5 px-5 font-medium">Model</th>
                      <th className="text-right py-2.5 px-5 font-medium">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map(a => (
                      <tr key={a.name} className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors">
                        <td className="py-3 px-5">
                          <div className="font-medium text-zinc-200">{a.name}</div>
                          <div className="text-xs text-zinc-500 mt-0.5">{a.description}</div>
                        </td>
                        <td className="py-3 px-5">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_BADGE[a.status] ?? 'bg-zinc-700 text-zinc-400'}`}>
                            {a.status}
                          </span>
                        </td>
                        <td className="py-3 px-5 font-mono text-xs text-zinc-400">{a.model}</td>
                        <td className="py-3 px-5 text-right font-mono text-zinc-400">${a.spent.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : agents ? (
              <div className="text-center py-12 text-zinc-600">No agents found</div>
            ) : (
              <div className="text-center py-12 text-zinc-600">Loading agents...</div>
            )}
          </>
        )}

        {/* ── Knowledge ───────────────────────────────────── */}
        {tab === 'knowledge' && (
          <>
            {palate?.stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-surface rounded-xl border border-edge p-4">
                  <div className="text-xs text-zinc-500 uppercase tracking-wide">Injections</div>
                  <div className="text-2xl font-bold mt-1">{palate.stats.totalInjections}</div>
                </div>
                <div className="bg-surface rounded-xl border border-edge p-4">
                  <div className="text-xs text-zinc-500 uppercase tracking-wide">Token Savings</div>
                  <div className="text-2xl font-bold mt-1 text-green-400">{palate.stats.savingsPercent}%</div>
                </div>
                <div className="bg-surface rounded-xl border border-edge p-4">
                  <div className="text-xs text-zinc-500 uppercase tracking-wide">Cache Hits</div>
                  <div className="text-2xl font-bold mt-1">{palate.stats.cacheHits}</div>
                </div>
                <div className="bg-surface rounded-xl border border-edge p-4">
                  <div className="text-xs text-zinc-500 uppercase tracking-wide">Sources</div>
                  <div className="text-2xl font-bold mt-1">{palate.sources.length}</div>
                </div>
              </div>
            )}
            {palate?.sources && palate.sources.length > 0 && (
              <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-edge text-xs text-zinc-500 uppercase tracking-wider">
                      <th className="text-left py-2.5 px-5 font-medium">Source</th>
                      <th className="text-left py-2.5 px-5 font-medium">Status</th>
                      <th className="text-left py-2.5 px-5 font-medium">Fitness</th>
                      <th className="text-right py-2.5 px-5 font-medium">Injections</th>
                      <th className="text-left py-2.5 px-5 font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {palate.sources.map(s => (
                      <tr key={s.id} className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors">
                        <td className="py-3 px-5 font-medium text-zinc-200">{s.id}</td>
                        <td className="py-3 px-5">
                          <span className={`text-xs px-2 py-0.5 rounded ${s.approved ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}`}>
                            {s.approved ? 'APPROVED' : 'PENDING'}
                          </span>
                        </td>
                        <td className={`py-3 px-5 font-mono text-xs ${fitnessColor(s.fitness)}`}>
                          {s.fitness.toFixed(2)}
                        </td>
                        <td className="py-3 px-5 text-right text-zinc-400">{s.totalInjections}</td>
                        <td className="py-3 px-5">
                          <div className="flex gap-1 flex-wrap">
                            {s.tags.map(t => (
                              <span key={t} className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">{t}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!palate && <div className="text-center py-12 text-zinc-600">Loading knowledge data...</div>}
          </>
        )}

        {/* ── Logs ─────────────────────────────────────────── */}
        {tab === 'logs' && (
          <>
            {history?.tasks && history.tasks.length > 0 ? (
              <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-edge text-xs text-zinc-500 uppercase tracking-wider">
                      <th className="text-left py-2.5 px-5 font-medium">Time</th>
                      <th className="text-left py-2.5 px-5 font-medium">Agent</th>
                      <th className="text-left py-2.5 px-5 font-medium">Action</th>
                      <th className="text-left py-2.5 px-5 font-medium">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.tasks.map(t => {
                      const d = DECISION_BADGE[t.gate.decision] ?? { cls: 'bg-zinc-700/50 text-zinc-400', label: t.gate.decision };
                      return (
                        <tr key={t.id} className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors">
                          <td className="py-3 px-5 text-xs text-zinc-500 font-mono whitespace-nowrap">
                            {formatTime(t.gate.decidedAt ?? t.completedAt)}
                          </td>
                          <td className="py-3 px-5 font-medium text-zinc-300 whitespace-nowrap">{t.agent}</td>
                          <td className="py-3 px-5 text-zinc-400">{briefTitle(t.description)}</td>
                          <td className="py-3 px-5">
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${d.cls}`}>{d.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : history ? (
              <div className="text-center py-12 text-zinc-600">No audit entries yet</div>
            ) : (
              <div className="text-center py-12 text-zinc-600">Loading logs...</div>
            )}
          </>
        )}
      </div>
    </>
  );
}
