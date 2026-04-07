'use client';

const RANGES = [
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '14d', ms: 14 * 24 * 60 * 60 * 1000 },
  { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

export function TimeRangeSelector({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {RANGES.map(r => (
        <button
          key={r.label}
          onClick={() => onChange(r.ms)}
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            value === r.ms ? 'bg-emerald-600/20 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export { RANGES };
