'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Header } from '@/components/header';

// ── Types ──────────────────────────────────────────────────────

interface ActionItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'todo' | 'in_progress' | 'done';
  sourceTaskId: string | null;
  sourceAgent: string | null;
  dueDate: string | null;
  createdAt: number;
  updatedAt: number | null;
  rafaelNotes: string | null;
}

interface ActionItemsResponse {
  items: ActionItem[];
  counts: { todo: number; in_progress: number; done: number; total: number };
}

// ── Agent role mapping ─────────────────────────────────────────

const AGENT_ROLES: Record<string, string> = {
  'ceo': 'CEO', 'cto': 'CTO', 'cfo': 'CFO', 'product-manager': 'Product',
  'data-analyst': 'Data', 'engineering': 'Engineering', 'devops': 'DevOps',
  'security-audit': 'Security', 'quality-guardian': 'Guardian',
  'marketing-strategist': 'Marketing', 'marketing-executor': 'Marketing Exec',
  'seo': 'SEO', 'legal': 'Legal', 'sales': 'Sales',
  'medical-content-reviewer': 'Research', 'community-manager': 'Community',
  'pr-comms': 'PR', 'customer-success': 'Success', 'hr': 'HR', 'design': 'Design',
};

function agentRole(agent: string): string {
  return AGENT_ROLES[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Priority styles ────────────────────────────────────────────

const PRIORITY_STYLES = {
  HIGH: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'HIGH' },
  MEDIUM: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'MED' },
  LOW: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'LOW' },
} as const;

const STATUS_STYLES = {
  todo: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Todo' },
  in_progress: { bg: 'bg-indigo-500/15', text: 'text-indigo-400', label: 'In Progress' },
  done: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Done' },
} as const;

// ── Time horizon helpers ──────────────────────────────────────

interface TimeHorizon {
  key: string;
  title: string;
  subtitle: string;
  accentColor: string;
  filter: (item: ActionItem) => boolean;
}

function getHorizons(): TimeHorizon[] {
  const now = new Date();
  const inDays = (d: number) => new Date(now.getTime() + d * 86400000).toISOString().slice(0, 10);
  const weekEnd = inDays(7);
  const monthEnd = inDays(30);
  const quarterEnd = inDays(90);

  return [
    {
      key: 'this-week',
      title: 'This Week',
      subtitle: 'HIGH priority - due within 7 days',
      accentColor: 'text-red-400',
      filter: (item) => {
        if (item.status === 'done') return false;
        if (!item.dueDate) return item.priority === 'HIGH';
        return item.dueDate <= weekEnd;
      },
    },
    {
      key: 'this-month',
      title: 'This Month',
      subtitle: 'MEDIUM priority - due within 30 days',
      accentColor: 'text-amber-400',
      filter: (item) => {
        if (item.status === 'done') return false;
        if (!item.dueDate) return item.priority === 'MEDIUM';
        return item.dueDate > weekEnd && item.dueDate <= monthEnd;
      },
    },
    {
      key: 'next-quarter',
      title: 'Next 3 Months',
      subtitle: 'Longer-term items due within 90 days',
      accentColor: 'text-blue-400',
      filter: (item) => {
        if (item.status === 'done') return false;
        if (!item.dueDate) return item.priority === 'LOW';
        return item.dueDate > monthEnd && item.dueDate <= quarterEnd;
      },
    },
    {
      key: 'strategic',
      title: '6-12 Months',
      subtitle: 'Strategic and aspirational items',
      accentColor: 'text-purple-400',
      filter: (item) => {
        if (item.status === 'done') return false;
        if (!item.dueDate) return false;
        return item.dueDate > quarterEnd;
      },
    },
  ];
}

// ── Component ──────────────────────────────────────────────────

export default function RoadmapPage() {
  const [project, setProject] = useState('');
  const [data, setData] = useState<ActionItemsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const pf = project ? `?project=${project}` : '';
      const res = await fetch(`/api/action-items${pf}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json: ActionItemsResponse = await res.json();
      setData(json);
      setLastUpdated(new Date());
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const items = data?.items ?? [];
  const horizons = getHorizons();

  // Calculate progress per horizon
  const allActive = items.filter(i => i.status !== 'done');
  const allDone = items.filter(i => i.status === 'done');

  return (
    <>
      <Header title="Roadmap" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        {/* Loading */}
        {loading && (
          <div className="text-center py-16">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
            <p className="text-sm text-zinc-500">Loading roadmap...</p>
          </div>
        )}

        {data && (
          <div className="max-w-4xl mx-auto space-y-6">

            {/* ── Overall summary ────────────────────────────── */}
            <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-zinc-100">Roadmap Overview</h2>
                <div className="text-xs text-zinc-500">
                  {allDone.length} of {items.length} completed
                </div>
              </div>
              <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden mb-3">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${items.length > 0 ? Math.round((allDone.length / items.length) * 100) : 0}%` }}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {horizons.map(h => {
                  const hItems = items.filter(h.filter);
                  const hDone = hItems.filter(i => i.status === 'done').length;
                  const hTotal = hItems.length;
                  return (
                    <div key={h.key} className="text-center">
                      <div className={`text-lg font-bold font-mono ${h.accentColor}`}>
                        {hTotal}
                      </div>
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">
                        {h.title}
                      </div>
                      {hTotal > 0 && hDone > 0 && (
                        <div className="text-[10px] text-zinc-600">{hDone} done</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Completed items summary ───────────────────── */}
            {allDone.length > 0 && (
              <div className="bg-green-500/5 rounded-xl border border-green-500/20 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-green-400">
                    Completed
                  </h3>
                  <span className="text-xs text-zinc-600 font-mono">{allDone.length}</span>
                </div>
                <div className="space-y-1">
                  {allDone.slice(0, 5).map(item => (
                    <div key={item.id} className="flex items-center gap-2 py-1">
                      <span className="text-green-500 text-xs">&#10003;</span>
                      <span className="text-xs text-zinc-400 line-through">{item.title}</span>
                      {item.sourceAgent && (
                        <span className="text-[10px] text-zinc-600">{agentRole(item.sourceAgent)}</span>
                      )}
                    </div>
                  ))}
                  {allDone.length > 5 && (
                    <Link href="/plan" className="text-xs text-emerald-400 hover:text-emerald-300">
                      + {allDone.length - 5} more completed items
                    </Link>
                  )}
                </div>
              </div>
            )}

            {/* ── Time horizons ─────────────────────────────── */}
            {horizons.map(horizon => {
              const hItems = items.filter(horizon.filter);
              if (hItems.length === 0 && allActive.length > 0) return null;

              const hInProgress = hItems.filter(i => i.status === 'in_progress').length;
              const hTodo = hItems.filter(i => i.status === 'todo').length;
              const hPct = hItems.length > 0
                ? Math.round((hItems.filter(i => i.status === 'done').length / hItems.length) * 100)
                : 0;

              return (
                <div key={horizon.key} className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
                  {/* Horizon header */}
                  <div className="p-4 border-b border-zinc-800/50">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className={`text-sm font-semibold ${horizon.accentColor}`}>{horizon.title}</h3>
                        <p className="text-[10px] text-zinc-500 mt-0.5">{horizon.subtitle}</p>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-zinc-400">
                          {hTodo > 0 && <span className="text-blue-400">{hTodo} todo</span>}
                          {hTodo > 0 && hInProgress > 0 && <span className="text-zinc-600"> / </span>}
                          {hInProgress > 0 && <span className="text-indigo-400">{hInProgress} in progress</span>}
                        </div>
                        {hItems.length > 0 && (
                          <div className="w-20 h-1 bg-zinc-800 rounded-full overflow-hidden mt-1 ml-auto">
                            <div
                              className="h-full bg-emerald-500 rounded-full"
                              style={{ width: `${hPct}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Items */}
                  <div className="divide-y divide-zinc-800/30">
                    {hItems.length === 0 && (
                      <p className="text-xs text-zinc-600 text-center py-6">No items in this time horizon</p>
                    )}
                    {hItems.map(item => (
                      <RoadmapCard key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Empty state */}
            {items.length === 0 && !loading && (
              <div className="text-center py-16">
                <div className="text-4xl mb-3 opacity-40">~</div>
                <h3 className="text-lg font-semibold text-zinc-300 mb-2">No roadmap items</h3>
                <p className="text-sm text-zinc-500 mb-4">
                  Approve findings in the review queue to build your roadmap.
                </p>
                <Link href="/" className="text-sm text-emerald-400 hover:text-emerald-300">
                  Go to review queue
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Roadmap Card Component ───────────────────────────────────

function RoadmapCard({ item }: { item: ActionItem }) {
  const pStyle = PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.MEDIUM;
  const sStyle = STATUS_STYLES[item.status] ?? STATUS_STYLES.todo;

  const overdue = item.dueDate && item.status !== 'done' && new Date(item.dueDate + 'T23:59:59').getTime() < Date.now();

  return (
    <div className="flex items-center gap-3 p-3 hover:bg-zinc-800/30 transition-colors group">
      {/* Status indicator */}
      <span className={`w-2 h-2 rounded-full shrink-0 ${
        item.status === 'done' ? 'bg-green-500'
        : item.status === 'in_progress' ? 'bg-indigo-500 animate-pulse'
        : 'bg-zinc-600'
      }`} />

      {/* Title + agent */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs leading-relaxed ${item.status === 'done' ? 'text-zinc-500 line-through' : 'text-zinc-300'} truncate`}>
          {item.title}
        </p>
        {item.sourceAgent && (
          <span className="text-[10px] text-zinc-600">{agentRole(item.sourceAgent)}</span>
        )}
      </div>

      {/* Priority badge */}
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${pStyle.bg} ${pStyle.text}`}>
        {pStyle.label}
      </span>

      {/* Status badge */}
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${sStyle.bg} ${sStyle.text}`}>
        {sStyle.label}
      </span>

      {/* Due date */}
      {item.dueDate && (
        <span className={`text-[10px] shrink-0 ${overdue ? 'text-red-400 font-medium' : 'text-zinc-600'}`}>
          {new Date(item.dueDate + 'T00:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}
        </span>
      )}

      {/* Link to source */}
      {item.sourceTaskId && (
        <a
          href={`/tasks/${item.sourceTaskId}`}
          className="text-[10px] text-zinc-700 hover:text-emerald-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
        >
          &#8594;
        </a>
      )}
    </div>
  );
}
