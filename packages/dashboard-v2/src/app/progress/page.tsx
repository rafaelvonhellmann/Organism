'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Header } from '@/components/header';
import { StatusBadge } from '@/components/status-badge';
import { getInitialSelectedProject } from '@/lib/selected-project';

// ── Types ──────────────────────────────────────────────────────

interface TaskSummary {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  costUsd: number | null;
  completedAt: number | null;
  createdAt: number;
  error: string | null;
  duplicateCount?: number;
  mergedTaskIds?: string[];
}

interface ProgressData {
  completed: TaskSummary[];
  inProgress: TaskSummary[];
  pending: TaskSummary[];
  awaitingReview: TaskSummary[];
  failed: TaskSummary[];
}

// ── Agent role mapping ─────────────────────────────────────────

const AGENT_ROLES: Record<string, string> = {
  'ceo': 'CEO',
  'cto': 'CTO',
  'cfo': 'CFO',
  'product-manager': 'Product',
  'data-analyst': 'Data',
  'engineering': 'Engineering',
  'devops': 'DevOps',
  'security-audit': 'Security',
  'quality-guardian': 'Guardian',
  'marketing-strategist': 'Marketing',
  'marketing-executor': 'Marketing Exec',
  'seo': 'SEO',
  'legal': 'Legal',
  'sales': 'Sales',
  'medical-content-reviewer': 'Research',
  'community-manager': 'Community',
  'pr-comms': 'PR',
  'customer-success': 'Success',
  'hr': 'HR',
  'design': 'Design',
};

function agentRole(agent: string): string {
  return AGENT_ROLES[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function briefTitle(desc: string): string {
  let d = desc
    .replace(/^(Strategic review|Technology strategy|Financial analysis|Product gap analysis|Architecture review|Infrastructure audit|Security audit|Marketing strategy|Marketing execution|SEO analysis|Community strategy|PR plan|Australian legal review|Sales strategy|Customer success|Team plan|Competitive intelligence|Metrics framework|Research workflow review|\[QUALITY AUDIT\]|Quality review|Codex review):?\s*/i, '')
    .replace(/^[""\u201C]/, '')
    .replace(/[""\u201D]$/, '')
    .replace(/\s+using codeEvidence.*$/i, '');
  const first = d.split(/[.!?\n]/)[0].trim();
  if (first.length > 60) return first.slice(0, 57) + '...';
  return first || desc.slice(0, 50);
}

function normalizeTaskKey(task: TaskSummary): string {
  return [
    task.agent,
    task.status,
    task.lane,
    briefTitle(task.description).toLowerCase(),
  ].join('::');
}

function mergeEquivalentTasks(tasks: TaskSummary[]): TaskSummary[] {
  const grouped = new Map<string, TaskSummary>();

  for (const task of tasks) {
    const key = normalizeTaskKey(task);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...task, duplicateCount: 1, mergedTaskIds: [task.id] });
      continue;
    }

    const existingTs = existing.completedAt ?? existing.createdAt;
    const taskTs = task.completedAt ?? task.createdAt;
    const winner = taskTs > existingTs ? task : existing;
    grouped.set(key, {
      ...winner,
      duplicateCount: (existing.duplicateCount ?? 1) + 1,
      mergedTaskIds: [...(existing.mergedTaskIds ?? [existing.id]), task.id],
    });
  }

  return [...grouped.values()].sort(
    (a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt),
  );
}

// ── Kanban column config ──────────────────────────────────────

interface KanbanColumn {
  key: keyof ProgressData;
  title: string;
  accentColor: string;
  dotColor: string;
  emptyText: string;
  animate?: boolean;
}

const COLUMNS: KanbanColumn[] = [
  {
    key: 'awaitingReview',
    title: 'To Review',
    accentColor: 'text-amber-400',
    dotColor: 'bg-amber-500',
    emptyText: 'No items awaiting review',
  },
  {
    key: 'inProgress',
    title: 'In Progress',
    accentColor: 'text-indigo-400',
    dotColor: 'bg-indigo-500',
    emptyText: 'Nothing running right now',
    animate: true,
  },
  {
    key: 'pending',
    title: 'Queued',
    accentColor: 'text-zinc-400',
    dotColor: 'bg-zinc-500',
    emptyText: 'Queue is empty',
  },
  {
    key: 'completed',
    title: 'Done',
    accentColor: 'text-green-400',
    dotColor: 'bg-green-500',
    emptyText: 'No completed tasks yet',
  },
];

// ── Component ──────────────────────────────────────────────────

export default function ProgressPage() {
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const requestSeq = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const pf = project ? `&project=${project}` : '';
      const [completedRes, inProgressRes, pendingRes, reviewRes, failedRes] = await Promise.all([
        fetch(`/api/tasks?status=completed&limit=200${pf}`, { cache: 'no-store' }),
        fetch(`/api/tasks?status=in_progress&limit=50${pf}`, { cache: 'no-store' }),
        fetch(`/api/tasks?status=pending&limit=50${pf}`, { cache: 'no-store' }),
        fetch(`/api/review-queue${project ? `?project=${project}` : ''}`, { cache: 'no-store' }),
        fetch(`/api/tasks?status=failed&limit=50${pf}`, { cache: 'no-store' }),
      ]);

      const [completed, inProgress, pending, review, failed] = await Promise.all([
        completedRes.json(),
        inProgressRes.json(),
        pendingRes.json(),
        reviewRes.json(),
        failedRes.json(),
      ]);

      if (seq !== requestSeq.current) {
        return;
      }

      const shouldShowPipelineTasks = Boolean(project);
      const normalizeVisibleTasks = (tasks: TaskSummary[]) =>
        shouldShowPipelineTasks
          ? tasks
          : tasks.filter(t => !['grill-me', 'codex-review', 'quality-agent', 'risk-classifier'].includes(t.agent));
      const groupedTasks = (tasks: TaskSummary[]) => mergeEquivalentTasks(normalizeVisibleTasks(tasks));

      setData({
        completed: groupedTasks(completed.tasks ?? []),
        inProgress: groupedTasks(inProgress.tasks ?? []),
        pending: groupedTasks(pending.tasks ?? []),
        awaitingReview: groupedTasks(review.tasks ?? []),
        failed: groupedTasks(failed.tasks ?? []),
      });
      setLastUpdated(new Date());
    } catch {
      // Silent fail
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const realFailedCount = data
    ? data.failed.filter(t => !t.error?.match(/(Dismissed|Rejected) by/i)).length
    : 0;
  const dismissedCount = data ? data.failed.length - realFailedCount : 0;
  const totalTasks = data
    ? data.completed.length + data.inProgress.length + data.pending.length + data.awaitingReview.length + realFailedCount
    : 0;
  const doneCount = data ? data.completed.length + dismissedCount : 0;
  const completionPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  return (
    <>
      <Header title="Progress" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        {/* Loading */}
        {loading && (
          <div className="text-center py-16">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
            <p className="text-sm text-zinc-500">Loading progress...</p>
          </div>
        )}

        {data && (
          <>
            {/* ── Overall progress bar ──────────────────────── */}
            <div className="max-w-6xl mx-auto mb-6">
              <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 md:p-5">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold text-zinc-100">Overall completion</h2>
                  <span className="text-xl font-bold text-emerald-400 font-mono">{completionPct}%</span>
                </div>
                <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${completionPct}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-4 text-xs">
                  <span className="text-green-400">{data.completed.length} done</span>
                  <span className="text-indigo-400">{data.inProgress.length} in progress</span>
                  <span className="text-amber-400">{data.awaitingReview.length} to review</span>
                  <span className="text-zinc-500">{data.pending.length} queued</span>
                  {realFailedCount > 0 && (
                    <span className="text-red-400">{realFailedCount} failed</span>
                  )}
                  {dismissedCount > 0 && (
                    <span className="text-zinc-500">{dismissedCount} dismissed</span>
                  )}
                </div>
              </div>
            </div>

            {/* ── Kanban board ─────────────────────────────── */}
            <div className="max-w-6xl mx-auto overflow-x-auto pb-4">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 min-w-0">
                {COLUMNS.map(col => {
                  const tasks = data[col.key];
                  const displayTasks = col.key === 'completed' ? tasks.slice(0, 20) : tasks;
                  const hasMore = col.key === 'completed' && tasks.length > 20;

                  return (
                    <div key={col.key} className="flex flex-col min-w-0">
                      {/* Column header */}
                      <div className="flex items-center gap-2 mb-3 px-1">
                        <span className={`w-2 h-2 rounded-full ${col.dotColor} ${col.animate ? 'animate-pulse' : ''}`} />
                        <h3 className={`text-xs font-semibold uppercase tracking-wider ${col.accentColor}`}>
                          {col.title}
                        </h3>
                        <span className="text-xs text-zinc-600 font-mono">
                          {tasks.length}
                        </span>
                      </div>

                      {/* Column body */}
                      <div className="flex-1 space-y-2 bg-zinc-950/50 rounded-xl border border-zinc-800/50 p-2 min-h-[120px] max-h-[calc(100vh-16rem)] overflow-y-auto">
                        {displayTasks.length === 0 && (
                          <p className="text-xs text-zinc-600 text-center py-6">{col.emptyText}</p>
                        )}
                        {displayTasks.map(task => (
                          <KanbanCard key={task.id} task={task} />
                        ))}
                        {hasMore && (
                          <Link
                            href="/history"
                            className="block text-xs text-emerald-400 hover:text-emerald-300 text-center py-2"
                          >
                            + {tasks.length - 20} more in history
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Failed tasks (collapsed, excludes dismissed) ───── */}
            {(() => {
              const realFailures = data.failed.filter(t =>
                !t.error?.match(/(Dismissed|Rejected) by/i)
              );
              if (realFailures.length === 0) return null;
              return (
                <div className="max-w-6xl mx-auto mt-6">
                  <details>
                    <summary className="flex items-center gap-2 mb-3 px-1 cursor-pointer list-none">
                      <span className="w-2 h-2 rounded-full bg-red-500" />
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-red-400">
                        Failed
                      </h3>
                      <span className="text-xs text-zinc-600 font-mono">
                        {realFailures.length}
                      </span>
                      <span className="text-xs text-zinc-600 ml-auto">click to expand</span>
                    </summary>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                      {realFailures.slice(0, 8).map(task => (
                        <KanbanCard key={task.id} task={task} />
                      ))}
                    </div>
                  </details>
                </div>
              );
            })()}

            {/* Empty state */}
            {totalTasks === 0 && (
              <div className="text-center py-16">
                <div className="text-4xl mb-3 opacity-40">%</div>
                <h3 className="text-lg font-semibold text-zinc-300 mb-2">No tasks yet</h3>
                <p className="text-sm text-zinc-500">Run some perspectives to see progress here.</p>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── Kanban card component ─────────────────────────────────────

function KanbanCard({ task }: { task: TaskSummary }) {
  return (
    <Link
      href={task.status === 'awaiting_review' ? '/' : `/tasks/${task.id}`}
      className="block p-3 rounded-lg bg-zinc-900 border border-zinc-800/60 hover:bg-zinc-800/60 hover:border-zinc-700 transition-colors group"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-bold text-emerald-400">
          {agentRole(task.agent)}
        </span>
        <StatusBadge status={task.lane} variant="lane" />
        {(task.duplicateCount ?? 1) > 1 && (
          <span className="text-[10px] rounded-full bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
            x{task.duplicateCount}
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-400 group-hover:text-zinc-300 transition-colors leading-relaxed line-clamp-2">
        {briefTitle(task.description)}
      </p>
    </Link>
  );
}
