interface StatusBadgeProps {
  status: string;
  variant?: 'task' | 'agent' | 'lane' | 'gate';
}

const TASK_COLORS: Record<string, string> = {
  pending: 'bg-blue-500/15 text-blue-400',
  in_progress: 'bg-indigo-500/15 text-indigo-400',
  completed: 'bg-green-500/15 text-green-400',
  failed: 'bg-red-500/15 text-red-400',
  dead_letter: 'bg-red-900/30 text-red-300',
  rolled_back: 'bg-orange-500/15 text-orange-400',
};

const AGENT_COLORS: Record<string, string> = {
  active: 'bg-green-500/15 text-green-400',
  shadow: 'bg-amber-500/15 text-amber-400',
  suspended: 'bg-red-500/15 text-red-400',
};

const LANE_COLORS: Record<string, string> = {
  LOW: 'bg-green-500/15 text-green-400',
  MEDIUM: 'bg-amber-500/15 text-amber-400',
  HIGH: 'bg-red-500/15 text-red-400',
};

const GATE_COLORS: Record<string, string> = {
  approved: 'bg-green-500/15 text-green-400',
  rejected: 'bg-red-500/15 text-red-400',
  pending: 'bg-amber-500/15 text-amber-400',
};

export function StatusBadge({ status, variant = 'task' }: StatusBadgeProps) {
  const colorMap = variant === 'agent' ? AGENT_COLORS
    : variant === 'lane' ? LANE_COLORS
    : variant === 'gate' ? GATE_COLORS
    : TASK_COLORS;
  const classes = colorMap[status] ?? 'bg-zinc-700/50 text-zinc-400';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${classes}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
