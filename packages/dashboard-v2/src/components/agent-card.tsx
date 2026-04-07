import Link from 'next/link';
import { StatusBadge } from './status-badge';
import { SpendBar } from './spend-bar';

interface AgentCardProps {
  name: string;
  status: 'active' | 'shadow' | 'suspended';
  model: string;
  description: string;
  spent: number;
  cap: number;
  pct: number;
  budgetStatus: 'ok' | 'warn' | 'crit' | 'idle';
  pendingTasks: number;
  completedToday: number;
  currentTask: { id: string; description: string; lane: string } | null;
}

export function AgentCard({
  name, status, model, description, spent, cap, pct, budgetStatus,
  pendingTasks, completedToday, currentTask,
}: AgentCardProps) {
  return (
    <div className="bg-surface rounded-xl border border-edge p-4 hover:border-edge-light transition-colors group">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-zinc-100 text-sm">{name}</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{model}</p>
        </div>
        <StatusBadge status={status} variant="agent" />
      </div>

      {/* Description */}
      <p className="text-xs text-zinc-400 mb-3 line-clamp-2">{description}</p>

      {/* Current task */}
      {currentTask ? (
        <Link
          href={`/tasks/${currentTask.id}`}
          className="block mb-3 p-2 rounded-lg bg-emerald-500/8 border border-emerald-500/20 hover:border-emerald-500/40 transition-colors"
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-dot" />
            <span className="text-xs font-medium text-emerald-400">Working on</span>
          </div>
          <p className="text-xs text-zinc-300 line-clamp-1">{currentTask.description}</p>
        </Link>
      ) : (
        <div className="mb-3 p-2 rounded-lg bg-zinc-800/30">
          <span className="text-xs text-zinc-600">Idle</span>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-3 mb-3 text-xs">
        <span className="text-zinc-500">
          <span className="text-blue-400 font-medium">{pendingTasks}</span> pending
        </span>
        <span className="text-zinc-500">
          <span className="text-green-400 font-medium">{completedToday}</span> done today
        </span>
      </div>

      {/* Budget bar */}
      <SpendBar spent={spent} cap={cap} pct={pct} status={budgetStatus} />
    </div>
  );
}
