import { StatusBadge } from './status-badge';

interface AuditEntry {
  id: number;
  ts: number;
  agent: string;
  taskId: string;
  action: string;
  payload: unknown;
  outcome: string;
  errorCode: string | null;
}

interface GateEntry {
  id: string;
  gate: string;
  decision: string;
  decidedBy: string | null;
  reason: string | null;
  decidedAt: number | null;
}

interface AuditTrailProps {
  entries: AuditEntry[];
  gates: GateEntry[];
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-AU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

const ACTION_LABELS: Record<string, string> = {
  task_created: 'Created',
  task_checkout: 'Checked out',
  task_completed: 'Completed',
  task_failed: 'Failed',
  gate_eval: 'Gate evaluated',
  budget_check: 'Budget check',
  mcp_call: 'MCP call',
  shadow_run: 'Shadow run',
  error: 'Error',
};

const OUTCOME_DOT: Record<string, string> = {
  success: 'bg-green-500',
  failure: 'bg-red-500',
  blocked: 'bg-amber-500',
};

export function AuditTrail({ entries, gates }: AuditTrailProps) {
  // Merge audit entries and gate decisions into a single timeline
  type TimelineItem = { ts: number; type: 'audit'; data: AuditEntry } | { ts: number; type: 'gate'; data: GateEntry };
  const items: TimelineItem[] = [
    ...entries.map(e => ({ ts: e.ts, type: 'audit' as const, data: e })),
    ...gates.filter(g => g.decidedAt).map(g => ({ ts: g.decidedAt!, type: 'gate' as const, data: g })),
  ].sort((a, b) => a.ts - b.ts);

  if (items.length === 0) {
    return <p className="text-sm text-zinc-600 py-4">No audit entries</p>;
  }

  return (
    <div className="relative pl-6">
      {/* Vertical line */}
      <div className="absolute left-2.5 top-2 bottom-2 w-px bg-edge" />

      {items.map((item, i) => (
        <div key={i} className="relative mb-4 last:mb-0">
          {/* Dot */}
          <div className={`absolute -left-3.5 top-1.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${
            item.type === 'audit'
              ? OUTCOME_DOT[item.data.outcome] ?? 'bg-zinc-600'
              : item.data.decision === 'approved' ? 'bg-green-500'
              : item.data.decision === 'rejected' ? 'bg-red-500'
              : 'bg-amber-500'
          }`} />

          {item.type === 'audit' ? (
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-zinc-200">
                  {ACTION_LABELS[item.data.action] ?? item.data.action}
                </span>
                <span className="text-xs text-zinc-500">{item.data.agent}</span>
                {item.data.errorCode && (
                  <span className="text-xs font-mono text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                    {item.data.errorCode}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-zinc-600">
                  {formatDate(item.ts)} {formatTime(item.ts)}
                </span>
                <StatusBadge status={item.data.outcome} variant="gate" />
              </div>
              {item.data.payload != null && typeof item.data.payload === 'object' && (
                <details className="mt-1.5">
                  <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                    payload
                  </summary>
                  <pre className="mt-1 text-xs text-zinc-500 bg-zinc-900 rounded p-2 overflow-auto max-h-32 font-mono">
                    {JSON.stringify(item.data.payload, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">
                  Gate {item.data.gate}
                </span>
                <StatusBadge status={item.data.decision} variant="gate" />
                {item.data.decidedBy && (
                  <span className="text-xs text-zinc-500">by {item.data.decidedBy}</span>
                )}
              </div>
              {item.data.reason && (
                <p className="text-xs text-zinc-400 mt-0.5">{item.data.reason}</p>
              )}
              {item.data.decidedAt && (
                <span className="text-xs text-zinc-600">
                  {formatDate(item.data.decidedAt)} {formatTime(item.data.decidedAt)}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
