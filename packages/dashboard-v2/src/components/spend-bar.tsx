interface SpendBarProps {
  spent: number;
  cap: number;
  pct: number;
  status: 'ok' | 'warn' | 'crit' | 'idle';
  showLabels?: boolean;
}

const BAR_COLORS = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  crit: 'bg-red-500',
  idle: 'bg-zinc-600',
};

export function SpendBar({ spent, cap, pct, status, showLabels = true }: SpendBarProps) {
  return (
    <div className="w-full">
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${BAR_COLORS[status]}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      {showLabels && (
        <div className="flex justify-between mt-1">
          <span className="text-xs text-zinc-500">${spent.toFixed(4)}</span>
          <span className="text-xs text-zinc-600">${cap.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}
