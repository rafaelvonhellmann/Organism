'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from '@/components/header';
import { SpendBar } from '@/components/spend-bar';
import { SparkChart } from '@/components/spark-chart';
import { TimeRangeSelector, RANGES } from '@/components/time-range';
import { getInitialSelectedProject } from '@/lib/selected-project';
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

interface UpstreamSource {
  id: string;
  label: string;
  kind: string;
  repo: string | null;
  localTargets: string[];
  lastReviewedAt: string | null;
  lastAdoptedVersion: string | null;
  notes: string | null;
  checkedAt: string;
  upstreamPushedAt: string | null;
  latestReleaseTag: string | null;
  latestReleasePublishedAt: string | null;
  stars: number | null;
  openIssues: number | null;
  homepage: string | null;
  status: 'manual_only' | 'unavailable' | 'needs_review' | 'recent_activity' | 'up_to_date';
}

interface HistoryTask {
  id: string;
  agent: string;
  description: string;
  completedAt: number | null;
  gate: { decision: string; decidedAt: number | null };
}

interface CostHistoryData {
  costByDay: Array<{ date: string; cost: number; agents: number }>;
  tasksByDay: Array<{ date: string; total: number; completed: number }>;
}

interface LogEntry {
  id: number;
  ts: number;
  agent: string;
  taskId: string;
  action: string;
  outcome: string;
  errorCode: string | null;
}

interface HealthData {
  daemonAlive: boolean;
  todaySpend: number;
  minutesSinceActivity: number;
}

interface Alert {
  level: 'red' | 'amber';
  message: string;
}

// ── Helpers ────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-500/15 text-green-400',
  shadow: 'bg-amber-500/15 text-amber-400',
  suspended: 'bg-red-500/15 text-red-400',
};

function fitnessColor(f: number): string {
  if (f >= 0.6) return 'text-green-400';
  if (f >= 0.3) return 'text-yellow-400';
  return 'text-red-400';
}

function formatLogTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-AU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

const OUTCOME_STYLE: Record<string, { cls: string; icon: string }> = {
  success:  { cls: 'text-green-400', icon: '\u2713' },
  ok:       { cls: 'text-green-400', icon: '\u2713' },
  failure:  { cls: 'text-red-400',   icon: '\u2717' },
  error:    { cls: 'text-red-400',   icon: '\u2717' },
  blocked:  { cls: 'text-amber-400', icon: '\u25CB' },
  skipped:  { cls: 'text-amber-400', icon: '\u25CB' },
};

function outcomeBadge(outcome: string): { cls: string; icon: string } {
  return OUTCOME_STYLE[outcome] ?? { cls: 'text-zinc-400', icon: '\u2022' };
}

function projectLabel(project: string | null): string {
  if (!project || project === 'all') return 'System';
  return project
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function upstreamTone(status: UpstreamSource['status']): string {
  switch (status) {
    case 'needs_review':
      return 'bg-amber-500/15 text-amber-300';
    case 'recent_activity':
      return 'bg-sky-500/15 text-sky-300';
    case 'up_to_date':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'manual_only':
      return 'bg-zinc-700/40 text-zinc-300';
    default:
      return 'bg-red-500/15 text-red-300';
  }
}

// ── Hook: live logs polling at 5s ──────────────────────────────

function useLiveLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [polling, setPolling] = useState(true);
  const knownIdsRef = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);
  const initialFetchDone = useRef(false);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/logs?limit=50', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      const entries: LogEntry[] = json.logs ?? [];
      if (!mountedRef.current) return;

      // Detect new entries since last fetch
      const fresh = new Set<number>();
      for (const e of entries) {
        if (!knownIdsRef.current.has(e.id)) fresh.add(e.id);
      }

      // Update known IDs
      for (const e of entries) knownIdsRef.current.add(e.id);

      setLogs(entries);
      if (fresh.size > 0 && initialFetchDone.current) {
        // Only highlight after the first fetch
        setNewIds(fresh);
        setTimeout(() => { if (mountedRef.current) setNewIds(new Set()); }, 2000);
      }
      initialFetchDone.current = true;
    } catch { /* silently retry next interval */ }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchLogs();
    const id = setInterval(fetchLogs, 5_000);
    setPolling(true);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
      setPolling(false);
    };
  }, [fetchLogs]);

  return { logs, newIds, polling };
}

// ── Compute alerts ─────────────────────────────────────────────

function computeAlerts(
  budget: BudgetData | null,
  health: HealthData | null,
  history: { tasks: HistoryTask[] } | null,
): Alert[] {
  const alerts: Alert[] = [];

  // Daily spend near or above cap
  if (budget && budget.systemPct >= 100) {
    alerts.push({ level: 'red', message: `Daily spend cap exceeded (${budget.systemPct.toFixed(0)}%)` });
  } else if (budget && budget.systemPct >= 80) {
    alerts.push({ level: 'amber', message: `Daily spend is at ${budget.systemPct.toFixed(0)}% of cap` });
  }

  // Daemon inactive
  if (health && !health.daemonAlive) {
    alerts.push({ level: 'red', message: 'Daemon not running' });
  }

  // Agent with 3+ failures
  if (history?.tasks) {
    const failCounts = new Map<string, number>();
    for (const t of history.tasks) {
      if (t.gate.decision === 'rejected') {
        failCounts.set(t.agent, (failCounts.get(t.agent) ?? 0) + 1);
      }
    }
    for (const [agent, count] of failCounts) {
      if (count >= 3) {
        alerts.push({ level: 'amber', message: `Agent ${agent} has ${count} failures` });
      }
    }
  }

  return alerts;
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
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [tab, setTab] = useState<Tab>('budget');
  const [rangeMs, setRangeMs] = useState(RANGES[2].ms); // default 14d

  const rangeDays = Math.round(rangeMs / (24 * 60 * 60 * 1000));
  const costHistoryUrl = project
    ? `/api/cost-history?days=${rangeDays}&project=${encodeURIComponent(project)}`
    : `/api/cost-history?days=${rangeDays}`;
  const budgetUrl = project
    ? `/api/budget?project=${encodeURIComponent(project)}`
    : '/api/budget';
  const { data: costHistory } = usePolling<CostHistoryData>(costHistoryUrl);

  const { data: budget, lastUpdated: budgetUpdated } = usePolling<BudgetData>(budgetUrl);
  const { data: agents, lastUpdated: agentsUpdated } = usePolling<AgentInfo[]>(
    project ? `/api/agents?project=${project}` : '/api/agents',
  );
  const { data: palate, lastUpdated: palateUpdated } = usePolling<PalateData>('/api/palate');
  const { data: upstreamSources, lastUpdated: upstreamUpdated } = usePolling<{ sources: UpstreamSource[] }>('/api/upstream-sources');
  const { data: history, lastUpdated: historyUpdated } = usePolling<{ tasks: HistoryTask[] }>('/api/history');
  const { data: health } = usePolling<HealthData>('/api/health');
  const { logs, newIds, polling: logsPolling } = useLiveLogs();

  const alerts = computeAlerts(budget, health, history);
  const logsUpdated = logs.length > 0 ? new Date(logs[0].ts) : null;
  const lastUpdated = { budget: budgetUpdated, agents: agentsUpdated, knowledge: upstreamUpdated ?? palateUpdated, logs: logsUpdated ?? historyUpdated }[tab];

  return (
    <>
      <Header title="System" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      {/* ── Alerts ──────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div className="px-4 md:px-6 pt-4 space-y-2">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm font-medium ${
                a.level === 'red'
                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              }`}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${
                a.level === 'red' ? 'bg-red-500' : 'bg-amber-500'
              }`} />
              {a.message}
            </div>
          ))}
        </div>
      )}

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
                  <span className="text-sm font-semibold text-zinc-200">{projectLabel(project)} -- {budget.date}</span>
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
            {/* Cost & Task Trend Charts */}
            {costHistory && (costHistory.costByDay.length > 1 || costHistory.tasksByDay.length > 1) && (
              <div className="bg-surface rounded-xl border border-edge p-5">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-sm font-semibold text-zinc-200">Spend &amp; Activity Trend</span>
                  <TimeRangeSelector value={rangeMs} onChange={setRangeMs} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {costHistory.costByDay.length > 1 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-zinc-500 uppercase tracking-wide">Daily Cost (USD)</span>
                        <span className="text-xs font-mono text-emerald-400">
                          ${costHistory.costByDay.reduce((s, d) => s + d.cost, 0).toFixed(2)} total
                        </span>
                      </div>
                      <SparkChart
                        data={costHistory.costByDay.map(d => d.cost)}
                        width={400}
                        height={48}
                        color="#10b981"
                      />
                      <div className="flex justify-between mt-1">
                        <span className="text-[10px] text-zinc-600">{costHistory.costByDay[0]?.date}</span>
                        <span className="text-[10px] text-zinc-600">{costHistory.costByDay[costHistory.costByDay.length - 1]?.date}</span>
                      </div>
                    </div>
                  )}
                  {costHistory.tasksByDay.length > 1 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-zinc-500 uppercase tracking-wide">Daily Tasks</span>
                        <span className="text-xs font-mono text-sky-400">
                          {costHistory.tasksByDay.reduce((s, d) => s + d.completed, 0)} completed
                        </span>
                      </div>
                      <SparkChart
                        data={costHistory.tasksByDay.map(d => d.total)}
                        width={400}
                        height={48}
                        color="#38bdf8"
                      />
                      <div className="flex justify-between mt-1">
                        <span className="text-[10px] text-zinc-600">{costHistory.tasksByDay[0]?.date}</span>
                        <span className="text-[10px] text-zinc-600">{costHistory.tasksByDay[costHistory.tasksByDay.length - 1]?.date}</span>
                      </div>
                    </div>
                  )}
                </div>
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
            <div className="bg-surface rounded-xl border border-edge overflow-hidden">
              <div className="border-b border-edge px-5 py-4">
                <div className="text-sm font-semibold text-zinc-200">Upstream Source Watch</div>
                <div className="mt-1 text-xs text-zinc-500">
                  Registered borrowed agent packs, tools, and external repos. Organism can watch them for changes, but it does not auto-apply upstream updates.
                </div>
              </div>
              {upstreamSources?.sources && upstreamSources.sources.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-edge text-xs text-zinc-500 uppercase tracking-wider">
                      <th className="text-left py-2.5 px-5 font-medium">Source</th>
                      <th className="text-left py-2.5 px-5 font-medium">Status</th>
                      <th className="text-left py-2.5 px-5 font-medium">Upstream</th>
                      <th className="text-left py-2.5 px-5 font-medium">Local targets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upstreamSources.sources.map((source) => (
                      <tr key={source.id} className="border-b border-edge/50 hover:bg-surface-alt/30 transition-colors align-top">
                        <td className="px-5 py-3">
                          <div className="font-medium text-zinc-200">{source.label}</div>
                          <div className="mt-1 text-xs text-zinc-500">{source.kind}</div>
                          {source.notes && <div className="mt-2 text-xs text-zinc-400">{source.notes}</div>}
                        </td>
                        <td className="px-5 py-3">
                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${upstreamTone(source.status)}`}>
                            {source.status.replace(/_/g, ' ')}
                          </span>
                          <div className="mt-2 text-xs text-zinc-500">
                            reviewed {source.lastReviewedAt ?? 'never'}
                          </div>
                          {source.lastAdoptedVersion && (
                            <div className="mt-1 text-xs text-zinc-500">adopted {source.lastAdoptedVersion}</div>
                          )}
                        </td>
                        <td className="px-5 py-3 text-xs text-zinc-400">
                          <div>{source.repo ?? 'manual registration needed'}</div>
                          {source.latestReleaseTag && <div className="mt-1">release {source.latestReleaseTag}</div>}
                          {source.upstreamPushedAt && <div className="mt-1">push {source.upstreamPushedAt}</div>}
                          {source.stars != null && <div className="mt-1">{source.stars} stars</div>}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {source.localTargets.length > 0 ? source.localTargets.map((target) => (
                              <span key={target} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                                {target}
                              </span>
                            )) : (
                              <span className="text-xs text-zinc-500">No local targets recorded</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="px-5 py-8 text-sm text-zinc-500">No upstream sources registered yet.</div>
              )}
            </div>
            {!palate && <div className="text-center py-12 text-zinc-600">Loading knowledge data...</div>}
          </>
        )}

        {/* ── Logs (live) ────────────────────────────────── */}
        {tab === 'logs' && (
          <>
            {/* Live indicator */}
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-block h-2 w-2 rounded-full ${logsPolling ? 'bg-green-500 animate-pulse' : 'bg-zinc-600'}`} />
              <span className="text-xs text-zinc-500">{logsPolling ? 'Live -- polling every 5s' : 'Paused'}</span>
            </div>

            {logs.length > 0 ? (
              <div className="bg-surface rounded-xl border border-edge overflow-hidden">
                <div className="max-h-[600px] overflow-y-auto">
                  <table className="w-full text-sm font-mono">
                    <thead className="sticky top-0 bg-surface z-10">
                      <tr className="border-b border-edge text-xs text-zinc-500 uppercase tracking-wider">
                        <th className="text-left py-2.5 px-5 font-medium">Time</th>
                        <th className="text-left py-2.5 px-5 font-medium">Agent</th>
                        <th className="text-left py-2.5 px-5 font-medium">Action</th>
                        <th className="text-left py-2.5 px-5 font-medium">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map(entry => {
                        const badge = outcomeBadge(entry.outcome);
                        const isNew = newIds.has(entry.id);
                        return (
                          <tr
                            key={entry.id}
                            className={`border-b border-edge/50 transition-colors duration-700 ${
                              isNew ? 'bg-emerald-500/10' : 'hover:bg-surface-alt/30'
                            }`}
                          >
                            <td className="py-2 px-5 text-xs text-zinc-500 whitespace-nowrap">
                              {formatLogTime(entry.ts)}
                            </td>
                            <td className="py-2 px-5 text-xs text-zinc-300 whitespace-nowrap">
                              {entry.agent}
                            </td>
                            <td className="py-2 px-5 text-xs text-zinc-400 whitespace-nowrap">
                              {entry.action}
                            </td>
                            <td className="py-2 px-5 whitespace-nowrap">
                              <span className={`text-xs font-medium ${badge.cls}`}>
                                {badge.icon} {entry.outcome}
                              </span>
                              {entry.errorCode && (
                                <span className="ml-2 text-xs text-red-500/70">[{entry.errorCode}]</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-zinc-600">No audit entries yet</div>
            )}
          </>
        )}
      </div>
    </>
  );
}
