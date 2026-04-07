'use client';

import { useState, useEffect, useCallback } from 'react';
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

// ── Helpers ────────────────────────────────────────────────────

function formatDueDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}

function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const due = new Date(dateStr + 'T23:59:59');
  return due.getTime() < Date.now();
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const due = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - now.getTime()) / 86400000);
}

// ── Kanban column config ──────────────────────────────────────

interface KanbanColumnDef {
  key: 'todo' | 'in_progress' | 'done';
  title: string;
  accentColor: string;
  dotColor: string;
  emptyText: string;
  animate?: boolean;
}

const COLUMNS: KanbanColumnDef[] = [
  { key: 'todo', title: 'Todo', accentColor: 'text-blue-400', dotColor: 'bg-blue-500', emptyText: 'No items in todo' },
  { key: 'in_progress', title: 'In Progress', accentColor: 'text-indigo-400', dotColor: 'bg-indigo-500', emptyText: 'Nothing in progress', animate: true },
  { key: 'done', title: 'Done', accentColor: 'text-green-400', dotColor: 'bg-green-500', emptyText: 'No completed items yet' },
];

// ── Component ──────────────────────────────────────────────────

export default function ActionPlanPage() {
  const [project, setProject] = useState('');
  const [data, setData] = useState<ActionItemsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<'due_date' | 'priority' | 'created'>('due_date');
  const [updating, setUpdating] = useState<string | null>(null);

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

  async function updateStatus(itemId: string, newStatus: string) {
    setUpdating(itemId);
    try {
      const res = await fetch(`/api/action-items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        // Optimistic update
        setData(prev => {
          if (!prev) return prev;
          const items = prev.items.map(item =>
            item.id === itemId ? { ...item, status: newStatus as ActionItem['status'] } : item
          );
          const counts = {
            todo: items.filter(i => i.status === 'todo').length,
            in_progress: items.filter(i => i.status === 'in_progress').length,
            done: items.filter(i => i.status === 'done').length,
            total: items.length,
          };
          return { items, counts };
        });
      }
    } catch {
      // Silent fail
    } finally {
      setUpdating(null);
    }
  }

  // Filter and sort items
  const items = data?.items ?? [];
  const filtered = items.filter(item => {
    if (priorityFilter && item.priority !== priorityFilter) return false;
    return true;
  });

  const sortedItems = [...filtered].sort((a, b) => {
    if (sortBy === 'due_date') {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (sortBy === 'priority') {
      const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (order[a.priority] ?? 3) - (order[b.priority] ?? 3);
    }
    return b.createdAt - a.createdAt;
  });

  // Group by status
  const grouped = {
    todo: sortedItems.filter(i => i.status === 'todo'),
    in_progress: sortedItems.filter(i => i.status === 'in_progress'),
    done: sortedItems.filter(i => i.status === 'done'),
  };

  const counts = data?.counts ?? { todo: 0, in_progress: 0, done: 0, total: 0 };
  const completionPct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

  return (
    <>
      <Header title="Action Plan" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        {/* Loading */}
        {loading && (
          <div className="text-center py-16">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
            <p className="text-sm text-zinc-500">Loading action plan...</p>
          </div>
        )}

        {data && (
          <>
            {/* ── Progress bar ──────────────────────────────── */}
            <div className="max-w-6xl mx-auto mb-6">
              <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 md:p-5">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold text-zinc-100">Action Items Progress</h2>
                  <span className="text-xl font-bold text-emerald-400 font-mono">{completionPct}%</span>
                </div>
                <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${completionPct}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-4 text-xs">
                  <span className="text-blue-400">{counts.todo} todo</span>
                  <span className="text-indigo-400">{counts.in_progress} in progress</span>
                  <span className="text-green-400">{counts.done} done</span>
                  <span className="text-zinc-500">{counts.total} total</span>
                </div>
              </div>
            </div>

            {/* ── Filters ──────────────────────────────────── */}
            <div className="max-w-6xl mx-auto mb-4 flex flex-wrap gap-2">
              <select
                value={priorityFilter}
                onChange={e => setPriorityFilter(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 min-h-[44px]"
              >
                <option value="">All priorities</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>

              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as typeof sortBy)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 min-h-[44px]"
              >
                <option value="due_date">Sort by due date</option>
                <option value="priority">Sort by priority</option>
                <option value="created">Sort by newest</option>
              </select>

              {priorityFilter && (
                <button
                  onClick={() => setPriorityFilter('')}
                  className="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] flex items-center"
                >
                  Clear filter
                </button>
              )}
            </div>

            {/* ── Kanban board ─────────────────────────────── */}
            <div className="max-w-6xl mx-auto overflow-x-auto pb-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 min-w-0">
                {COLUMNS.map(col => {
                  const colItems = grouped[col.key];
                  return (
                    <div key={col.key} className="flex flex-col min-w-0">
                      {/* Column header */}
                      <div className="flex items-center gap-2 mb-3 px-1">
                        <span className={`w-2 h-2 rounded-full ${col.dotColor} ${col.animate ? 'animate-pulse' : ''}`} />
                        <h3 className={`text-xs font-semibold uppercase tracking-wider ${col.accentColor}`}>
                          {col.title}
                        </h3>
                        <span className="text-xs text-zinc-600 font-mono">{colItems.length}</span>
                      </div>

                      {/* Column body */}
                      <div className="flex-1 space-y-2 bg-zinc-950/50 rounded-xl border border-zinc-800/50 p-2 min-h-[120px] max-h-[calc(100vh-20rem)] overflow-y-auto">
                        {colItems.length === 0 && (
                          <p className="text-xs text-zinc-600 text-center py-6">{col.emptyText}</p>
                        )}
                        {colItems.map(item => (
                          <ActionCard
                            key={item.id}
                            item={item}
                            currentStatus={col.key}
                            onStatusChange={updateStatus}
                            updating={updating === item.id}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Empty state */}
            {items.length === 0 && (
              <div className="text-center py-16">
                <div className="text-4xl mb-3 opacity-40">!</div>
                <h3 className="text-lg font-semibold text-zinc-300 mb-2">No action items yet</h3>
                <p className="text-sm text-zinc-500">Approve findings in the review queue to create action items.</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── Action Card Component ────────────────────────────────────

function ActionCard({
  item,
  currentStatus,
  onStatusChange,
  updating,
}: {
  item: ActionItem;
  currentStatus: string;
  onStatusChange: (id: string, status: string) => void;
  updating: boolean;
}) {
  const pStyle = PRIORITY_STYLES[item.priority] ?? PRIORITY_STYLES.MEDIUM;
  const overdue = isOverdue(item.dueDate) && item.status !== 'done';
  const days = daysUntil(item.dueDate);

  const nextStatuses: { label: string; value: string; color: string }[] = [];
  if (currentStatus === 'todo') {
    nextStatuses.push({ label: 'Start', value: 'in_progress', color: 'bg-indigo-600 hover:bg-indigo-500 text-white' });
    nextStatuses.push({ label: 'Done', value: 'done', color: 'bg-green-600 hover:bg-green-500 text-white' });
  } else if (currentStatus === 'in_progress') {
    nextStatuses.push({ label: 'Done', value: 'done', color: 'bg-green-600 hover:bg-green-500 text-white' });
    nextStatuses.push({ label: 'Back to todo', value: 'todo', color: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' });
  } else if (currentStatus === 'done') {
    nextStatuses.push({ label: 'Reopen', value: 'todo', color: 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300' });
  }

  return (
    <div className={`p-3 rounded-lg bg-zinc-900 border ${overdue ? 'border-red-500/40' : 'border-zinc-800/60'} hover:bg-zinc-800/60 transition-colors`}>
      {/* Header: priority + agent */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${pStyle.bg} ${pStyle.text}`}>
          {pStyle.label}
        </span>
        {item.sourceAgent && (
          <span className="text-[10px] font-medium text-zinc-500">
            {agentRole(item.sourceAgent)}
          </span>
        )}
        {item.dueDate && (
          <span className={`text-[10px] ml-auto ${overdue ? 'text-red-400 font-medium' : 'text-zinc-500'}`}>
            {overdue ? 'Overdue' : days !== null && days <= 3 ? `${days}d left` : formatDueDate(item.dueDate)}
          </span>
        )}
      </div>

      {/* Title */}
      <p className="text-xs text-zinc-300 leading-relaxed line-clamp-2 mb-2">
        {item.title}
      </p>

      {/* Status change buttons */}
      <div className="flex items-center gap-1.5">
        {nextStatuses.map(ns => (
          <button
            key={ns.value}
            onClick={() => onStatusChange(item.id, ns.value)}
            disabled={updating}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors disabled:opacity-50 ${ns.color}`}
          >
            {updating ? '...' : ns.label}
          </button>
        ))}
        {item.sourceTaskId && (
          <a
            href={`/tasks/${item.sourceTaskId}`}
            className="ml-auto text-[10px] text-zinc-600 hover:text-emerald-400 transition-colors"
          >
            Source
          </a>
        )}
      </div>
    </div>
  );
}
