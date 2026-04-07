'use client';

import { useState, useMemo } from 'react';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';

// ── Types ──────────────────────────────────────────────────────

interface Task {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  createdAt: number;
  completedAt: number | null;
  costUsd: number | null;
}

interface TasksResponse {
  tasks: Task[];
  total: number;
}

// ── Time filters ──────────────────────────────────────────────

const TIME_FILTERS = [
  { label: 'Today', ms: 24 * 60 * 60 * 1000 },
  { label: 'This Week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '15 Days', ms: 15 * 24 * 60 * 60 * 1000 },
  { label: 'This Month', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: 'Quarter', ms: 90 * 24 * 60 * 60 * 1000 },
  { label: '6 Months', ms: 180 * 24 * 60 * 60 * 1000 },
] as const;

// ── Agent role mapping ────────────────────────────────────────

const AGENT_ROLES: Record<string, string> = {
  'ceo': 'CEO', 'cto': 'CTO', 'cfo': 'CFO', 'product-manager': 'Product',
  'data-analyst': 'Data', 'engineering': 'Engineering', 'devops': 'DevOps',
  'security-audit': 'Security', 'quality-guardian': 'Guardian',
  'quality-agent': 'Quality', 'marketing-strategist': 'Marketing',
  'marketing-executor': 'Marketing Exec', 'seo': 'SEO', 'legal': 'Legal',
  'sales': 'Sales', 'medical-content-reviewer': 'Research',
  'community-manager': 'Community', 'pr-comms': 'PR',
  'customer-success': 'Success', 'hr': 'HR', 'design': 'Design',
  'synthesis': 'Synthesis',
};

function agentRole(agent: string): string {
  return AGENT_ROLES[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Lane to priority mapping ──────────────────────────────────

function laneToPriority(lane: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (lane === 'HIGH') return 'HIGH';
  if (lane === 'LOW') return 'LOW';
  return 'MEDIUM';
}

const PRIORITY_STYLES = {
  HIGH: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'HIGH' },
  MEDIUM: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'MED' },
  LOW: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'LOW' },
} as const;

// ── Helpers ───────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '...';
}

function formatCost(costUsd: number | null): string {
  if (costUsd == null || costUsd === 0) return '';
  return `$${costUsd.toFixed(3)}`;
}

// ── Component ─────────────────────────────────────────────────

export default function PlanPage() {
  const [project, setProject] = useState('');
  const [filterIdx, setFilterIdx] = useState(1); // Default: "This Week"
  const [completedOpen, setCompletedOpen] = useState(false);

  const url = project
    ? `/api/tasks?project=${project}&limit=500`
    : '/api/tasks?limit=500';

  const { data, loading, lastUpdated } = usePolling<TasksResponse>(url, 60_000);

  const allTasks = data?.tasks ?? [];

  // Filter by time
  const selectedFilter = TIME_FILTERS[filterIdx];
  const filtered = useMemo(() => {
    const cutoff = Date.now() - selectedFilter.ms;
    return allTasks.filter(t => t.createdAt > cutoff);
  }, [allTasks, selectedFilter.ms]);

  // Group by status
  const groups = useMemo(() => {
    const inProgress: Task[] = [];
    const needsDecision: Task[] = [];
    const completed: Task[] = [];

    for (const t of filtered) {
      if (t.status === 'awaiting_review') {
        needsDecision.push(t);
      } else if (t.status === 'completed') {
        completed.push(t);
      } else {
        // in_progress, pending, or any other active status
        inProgress.push(t);
      }
    }

    return { inProgress, needsDecision, completed };
  }, [filtered]);

  // Summary stats
  const totalCost = useMemo(
    () => filtered.reduce((sum, t) => sum + (t.costUsd ?? 0), 0),
    [filtered],
  );

  return (
    <>
      <Header title="Plan" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6 max-w-4xl mx-auto">
        {/* ── Time filter tabs ──────────────────────────── */}
        <div className="flex flex-wrap gap-1 mb-6">
          {TIME_FILTERS.map((f, i) => (
            <button
              key={f.label}
              onClick={() => setFilterIdx(i)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                i === filterIdx
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* ── Loading ──────────────────────────────────── */}
        {loading && !data && (
          <div className="text-center py-16">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
            <p className="text-sm text-zinc-500">Loading tasks...</p>
          </div>
        )}

        {data && (
          <>
            {/* ── Summary stats ─────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
              <StatBox label="Total" value={filtered.length} color="text-zinc-100" />
              <StatBox label="In Progress" value={groups.inProgress.length} color="text-amber-400" />
              <StatBox label="Needs Decision" value={groups.needsDecision.length} color="text-red-400" />
              <StatBox label="Completed" value={groups.completed.length} color="text-green-400" />
              <StatBox label="Cost" value={`$${totalCost.toFixed(2)}`} color="text-zinc-300" />
            </div>

            {/* ── Empty state ──────────────────────────── */}
            {filtered.length === 0 && (
              <div className="text-center py-16">
                <p className="text-sm text-zinc-500">No tasks in this period.</p>
              </div>
            )}

            {/* ── Needs Decision (red) ─────────────────── */}
            {groups.needsDecision.length > 0 && (
              <TaskSection
                title="Needs Decision"
                count={groups.needsDecision.length}
                dotColor="bg-red-500"
                accentColor="text-red-400"
                borderColor="border-red-500/20"
                tasks={groups.needsDecision}
                defaultOpen
              />
            )}

            {/* ── In Progress (amber) ──────────────────── */}
            {groups.inProgress.length > 0 && (
              <TaskSection
                title="In Progress"
                count={groups.inProgress.length}
                dotColor="bg-amber-500"
                accentColor="text-amber-400"
                borderColor="border-amber-500/20"
                tasks={groups.inProgress}
                defaultOpen
              />
            )}

            {/* ── Completed (green, collapsed) ─────────── */}
            {groups.completed.length > 0 && (
              <TaskSection
                title="Completed"
                count={groups.completed.length}
                dotColor="bg-green-500"
                accentColor="text-green-400"
                borderColor="border-green-500/20"
                tasks={groups.completed}
                defaultOpen={completedOpen}
                onToggle={() => setCompletedOpen(o => !o)}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

// ── Stat Box ──────────────────────────────────────────────────

function StatBox({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">{label}</p>
      <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}

// ── Task Section ──────────────────────────────────────────────

function TaskSection({
  title,
  count,
  dotColor,
  accentColor,
  borderColor,
  tasks,
  defaultOpen,
  onToggle,
}: {
  title: string;
  count: number;
  dotColor: string;
  accentColor: string;
  borderColor: string;
  tasks: Task[];
  defaultOpen: boolean;
  onToggle?: () => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = onToggle ? defaultOpen : internalOpen;
  const toggle = onToggle ?? (() => setInternalOpen(o => !o));

  return (
    <div className={`mb-6 border-l-2 ${borderColor} pl-4`}>
      <button
        onClick={toggle}
        className="flex items-center gap-2 mb-2 group w-full text-left"
      >
        <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
        <h3 className={`text-xs font-semibold uppercase tracking-wider ${accentColor}`}>
          {title}
        </h3>
        <span className="text-xs text-zinc-600 font-mono">{count}</span>
        <span className="ml-auto text-zinc-600 text-xs group-hover:text-zinc-400 transition-colors">
          {isOpen ? '\u25B4' : '\u25BE'}
        </span>
      </button>

      {isOpen && (
        <div className="space-y-0">
          {tasks.map(task => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Task Row ──────────────────────────────────────────────────

function TaskRow({ task }: { task: Task }) {
  const priority = laneToPriority(task.lane);
  const pStyle = PRIORITY_STYLES[priority];
  const cost = formatCost(task.costUsd);

  return (
    <a
      href={`/tasks/${task.id}`}
      className="flex items-center gap-3 py-2 px-1 border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors group"
    >
      {/* Agent */}
      <span className="text-xs text-zinc-500 w-20 shrink-0 truncate" title={task.agent}>
        {agentRole(task.agent)}
      </span>

      {/* Priority badge */}
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${pStyle.bg} ${pStyle.text}`}>
        {pStyle.label}
      </span>

      {/* Description */}
      <span className="text-xs text-zinc-300 flex-1 min-w-0 truncate group-hover:text-zinc-100 transition-colors">
        {truncate(task.description, 60)}
      </span>

      {/* Cost */}
      {cost && (
        <span className="text-[10px] text-zinc-500 font-mono shrink-0">{cost}</span>
      )}

      {/* Time ago */}
      <span className="text-[10px] text-zinc-600 shrink-0 w-14 text-right">
        {timeAgo(task.createdAt)}
      </span>
    </a>
  );
}
