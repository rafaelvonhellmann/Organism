interface MetricCardProps {
  label: string;
  value: string | number;
  sub?: string;
  color?: 'default' | 'green' | 'amber' | 'red' | 'blue' | 'indigo' | 'emerald';
}

const colorMap = {
  default: 'text-zinc-100',
  green: 'text-green-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
  blue: 'text-blue-400',
  indigo: 'text-emerald-400',
  emerald: 'text-emerald-400',
};

export function MetricCard({ label, value, sub, color = 'default' }: MetricCardProps) {
  return (
    <div className="bg-surface rounded-xl border border-edge p-3 md:p-4 hover:border-edge-light transition-colors overflow-hidden">
      <p className="text-[10px] md:text-xs font-medium text-zinc-500 uppercase tracking-wider truncate">{label}</p>
      <p className={`text-xl md:text-2xl font-semibold mt-1 truncate ${colorMap[color]}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] md:text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  );
}
