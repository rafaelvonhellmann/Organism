'use client';

import { use } from 'react';
import { usePolling } from '@/hooks/use-polling';
import { MetricCard } from '@/components/metric-card';
import { StatusBadge } from '@/components/status-badge';

// ── Types ──────────────────────────────────────────────────────

interface ProjectMetrics {
  reviewCount: number;
  totalSpend: number;
  activeAgents: number;
  findingCount: number;
  approvalRate: number;
  avgReviewCost: number;
}

interface AgentRow {
  agent: string;
  tasks: number;
  cost: number;
}

interface RecentTask {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  cost_usd: number | null;
  created_at: number;
  completed_at: number | null;
}

interface ProjectData {
  project: string;
  metrics: ProjectMetrics;
  byStatus: Record<string, number>;
  byAgent: AgentRow[];
  recentTasks: RecentTask[];
}

// ── Display names ──────────────────────────────────────────────

const PROJECT_NAMES: Record<string, string> = {
  synapse: 'Synapse',
  'tokens-for-good': 'Tokens for Good',
  organism: 'Organism',
};

function displayName(id: string): string {
  return PROJECT_NAMES[id] ?? id;
}

// ── Status bar colors ──────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-500',
  in_progress: 'bg-indigo-500',
  pending: 'bg-blue-500',
  failed: 'bg-red-500',
  dead_letter: 'bg-red-800',
  rolled_back: 'bg-orange-500',
};

// ── Time formatting ────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Component ──────────────────────────────────────────────────

export default function ProjectDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, loading, lastUpdated } = usePolling<ProjectData>(`/api/project/${id}`, 60_000);

  const m = data?.metrics;
  const totalTasks = data ? Object.values(data.byStatus).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="h-14 border-b border-edge bg-gradient-to-r from-surface/90 via-surface/80 to-surface/90 backdrop-blur-md flex items-center justify-between px-4 md:px-6 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-zinc-100">
            {displayName(id)}
          </h2>
          <span className="text-xs text-zinc-500 font-mono">project</span>
        </div>
        {lastUpdated && (
          <span className="text-xs text-zinc-500 flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-dot" />
            {timeAgo(lastUpdated.getTime())}
          </span>
        )}
      </header>

      <div className="p-4 md:p-6">
        <div className="max-w-4xl mx-auto space-y-6">

          {/* ── Loading ───────────────────────────────────────── */}
          {loading && !data && (
            <div className="text-center py-16">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
              <p className="text-sm text-zinc-500">Loading project data...</p>
            </div>
          )}

          {/* ── Empty state ────────────────────────────────────── */}
          {!loading && data && m && m.reviewCount === 0 && m.totalSpend === 0 && (
            <div className="text-center py-16">
              <h3 className="text-lg font-semibold text-zinc-300 mb-2">No data yet</h3>
              <p className="text-sm text-zinc-500">Run Organism against {displayName(id)} to populate this dashboard.</p>
            </div>
          )}

          {/* ── Stat cards ─────────────────────────────────────── */}
          {data && m && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <MetricCard label="Total Reviews" value={m.reviewCount} color="default" />
                <MetricCard label="Total Spend" value={`$${m.totalSpend.toFixed(2)}`} color="amber" />
                <MetricCard label="Active Agents" value={m.activeAgents} color="emerald" />
                <MetricCard label="Findings" value={m.findingCount} color={m.findingCount > 0 ? 'red' : 'default'} />
                <MetricCard label="Approval Rate" value={`${m.approvalRate}%`} color={m.approvalRate >= 80 ? 'green' : 'amber'} sub="completed / total" />
                <MetricCard label="Avg Cost" value={`$${m.avgReviewCost.toFixed(3)}`} color="blue" sub="per review" />
              </div>

              {/* ── Tasks by status bar ─────────────────────────── */}
              {totalTasks > 0 && (
                <div className="bg-surface rounded-xl border border-edge p-4">
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Tasks by Status</h3>

                  {/* Proportional bar */}
                  <div className="flex h-4 rounded-full overflow-hidden bg-zinc-800 mb-3">
                    {Object.entries(data.byStatus).map(([status, count]) => {
                      const pct = (count / totalTasks) * 100;
                      if (pct === 0) return null;
                      return (
                        <div
                          key={status}
                          className={`${STATUS_COLORS[status] ?? 'bg-zinc-600'} transition-all`}
                          style={{ width: `${pct}%` }}
                          title={`${status}: ${count}`}
                        />
                      );
                    })}
                  </div>

                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {Object.entries(data.byStatus).map(([status, count]) => (
                      <div key={status} className="flex items-center gap-1.5 text-xs">
                        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? 'bg-zinc-600'}`} />
                        <span className="text-zinc-400">{status.replace(/_/g, ' ')}</span>
                        <span className="text-zinc-600 font-mono">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Agent performance table ────────────────────── */}
              {data.byAgent.length > 0 && (
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-4 py-3 border-b border-edge">
                    <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Agent Performance</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-zinc-500 border-b border-edge">
                          <th className="px-4 py-2 font-medium">Agent</th>
                          <th className="px-4 py-2 font-medium text-right">Tasks</th>
                          <th className="px-4 py-2 font-medium text-right">Cost</th>
                          <th className="px-4 py-2 font-medium text-right">Avg/Task</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.byAgent.map((row) => (
                          <tr key={row.agent} className="border-b border-edge last:border-0 hover:bg-zinc-800/30 transition-colors">
                            <td className="px-4 py-2.5 text-zinc-200 font-medium">{row.agent}</td>
                            <td className="px-4 py-2.5 text-zinc-400 text-right font-mono">{row.tasks}</td>
                            <td className="px-4 py-2.5 text-amber-400 text-right font-mono">${row.cost.toFixed(3)}</td>
                            <td className="px-4 py-2.5 text-zinc-500 text-right font-mono">
                              ${row.tasks > 0 ? (row.cost / row.tasks).toFixed(3) : '0.000'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Recent tasks ────────────────────────────────── */}
              {data.recentTasks.length > 0 && (
                <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                  <div className="px-4 py-3 border-b border-edge">
                    <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Recent Tasks</h3>
                  </div>
                  <div className="divide-y divide-edge">
                    {data.recentTasks.map((task) => (
                      <div key={task.id} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                        <div className="flex items-center gap-3 mb-1">
                          <span className="text-sm text-zinc-200 font-medium">{task.agent}</span>
                          <StatusBadge status={task.status} />
                          {task.lane && <StatusBadge status={task.lane} variant="lane" />}
                          <span className="ml-auto text-xs text-zinc-600 font-mono">
                            {task.cost_usd != null ? `$${Number(task.cost_usd).toFixed(3)}` : '--'}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <p className="text-xs text-zinc-500 truncate flex-1">
                            {task.description ? task.description.slice(0, 120) : task.id}
                          </p>
                          <span className="text-[10px] text-zinc-600 shrink-0">
                            {task.created_at ? timeAgo(task.created_at) : ''}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
