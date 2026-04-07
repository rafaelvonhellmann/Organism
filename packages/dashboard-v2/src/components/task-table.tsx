'use client';

import Link from 'next/link';
import { StatusBadge } from './status-badge';

interface Task {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  costUsd: number | null;
  projectId: string;
  createdAt: number;
  completedAt: number | null;
}

interface TaskTableProps {
  tasks: Task[];
  total: number;
  page: number;
  onPageChange: (p: number) => void;
  pageSize?: number;
}

/** Agent name → human-readable role */
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
  'quality-agent': 'Quality',
  'grill-me': 'Grill-Me',
  'codex-review': 'Codex',
  'marketing-strategist': 'Marketing',
  'marketing-executor': 'Mktg Exec',
  'seo': 'SEO',
  'community-manager': 'Community',
  'pr-comms': 'PR',
  'legal': 'Legal',
  'sales': 'Sales',
  'customer-success': 'Success',
  'hr': 'HR',
  'medical-content-reviewer': 'Research',
  'design': 'Design',
};

/** Shorten a raw task description into a brief human-readable label */
function briefLabel(desc: string): string {
  let d = desc
    .replace(/^(Strategic review|Technology strategy|Financial analysis|Product gap analysis|Architecture review|Infrastructure audit|Security audit|Marketing strategy|Marketing execution|SEO analysis|Community strategy|PR plan|Australian legal review|Sales strategy|Customer success|Team plan|Competitive intelligence|Metrics framework|Research workflow review|\[QUALITY AUDIT\])\s*(of|for|:)?\s*/i, '')
    .replace(/^(Quality review|Codex review):?\s*[""]?/i, '')
    .replace(/[""]$/, '');

  // Take first meaningful chunk
  const first = d.split(/[.\n]/)[0].trim();
  if (first.length > 90) return first.slice(0, 87) + '...';
  return first || desc.slice(0, 70);
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function TaskTable({ tasks, total, page, onPageChange, pageSize = 50 }: TaskTableProps) {
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      {tasks.length === 0 && (
        <div className="text-center py-12 text-zinc-600">No tasks found</div>
      )}

      <div className="divide-y divide-edge/50">
        {tasks.map(t => (
          <Link
            key={t.id}
            href={`/tasks/${t.id}`}
            className="flex items-center gap-3 px-4 py-3 hover:bg-surface-alt/50 transition-colors group"
          >
            <StatusBadge status={t.status} variant="task" />
            <span className="text-xs text-zinc-500 w-16 shrink-0 font-medium">
              {AGENT_ROLES[t.agent] ?? t.agent}
            </span>
            <span className="text-sm text-zinc-300 group-hover:text-emerald-400 transition-colors flex-1 min-w-0 truncate">
              {briefLabel(t.description)}
            </span>
            <StatusBadge status={t.lane} variant="lane" />
            {t.costUsd != null && t.costUsd > 0 && (
              <span className="text-xs text-zinc-600 font-mono w-14 text-right shrink-0">
                ${t.costUsd.toFixed(2)}
              </span>
            )}
            <span className="text-xs text-zinc-600 w-16 text-right shrink-0">
              {timeAgo(t.completedAt ?? t.createdAt)}
            </span>
          </Link>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-edge">
          <span className="text-xs text-zinc-500">{total} total</span>
          <div className="flex gap-1">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
              className="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <span className="px-2.5 py-1 text-xs text-zinc-500">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="px-2.5 py-1 text-xs rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
