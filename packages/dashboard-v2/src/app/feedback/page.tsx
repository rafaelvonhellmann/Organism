'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/header';

// ── Types ──────────────────────────────────────────────────────

type FeedbackStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed' | 'converted';

interface FeedbackItem {
  id: string;
  source: string;
  sessionId: string | null;
  externalId: string;
  pageUrl: string | null;
  annotationKind: string | null;
  body: string;
  status: FeedbackStatus;
  severity: string | null;
  linkedTaskId: string | null;
  linkedActionItemId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface FeedbackSession {
  sessionId: string;
  count: number;
  pendingCount: number;
  latestPageUrl: string | null;
}

interface FeedbackResponse {
  items: FeedbackItem[];
  counts: Record<string, number>;
}

// ── Status/severity styles ────────────────────────────────────

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending:      { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Pending' },
  acknowledged: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Acknowledged' },
  resolved:     { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Resolved' },
  dismissed:    { bg: 'bg-zinc-500/15', text: 'text-zinc-400', label: 'Dismissed' },
  converted:    { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Converted' },
};

const SEVERITY_STYLES: Record<string, { bg: string; text: string }> = {
  critical: { bg: 'bg-red-500/15', text: 'text-red-400' },
  high:     { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  medium:   { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  low:      { bg: 'bg-green-500/15', text: 'text-green-400' },
  info:     { bg: 'bg-sky-500/15', text: 'text-sky-400' },
};

// ── Helpers ───────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Component ─────────────────────────────────────────────────

export default function FeedbackPage() {
  const [project, setProject] = useState('');
  const [data, setData] = useState<FeedbackResponse | null>(null);
  const [sessions, setSessions] = useState<FeedbackSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [sessionFilter, setSessionFilter] = useState<string>('');
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (sessionFilter) params.set('session_id', sessionFilter);
      const qs = params.toString();

      const [feedbackRes, sessionsRes] = await Promise.all([
        fetch(`/api/feedback${qs ? `?${qs}` : ''}`, { cache: 'no-store' }),
        fetch('/api/feedback/sessions', { cache: 'no-store' }),
      ]);

      if (feedbackRes.ok) {
        const json: FeedbackResponse = await feedbackRes.json();
        setData(json);
        setLastUpdated(new Date());
      }
      if (sessionsRes.ok) {
        const json = await sessionsRes.json();
        setSessions(json.sessions ?? []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [statusFilter, sessionFilter]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Actions ─────────────────────────────────────────────────

  async function updateStatus(id: string, newStatus: FeedbackStatus) {
    setUpdating(id);
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        setData(prev => {
          if (!prev) return prev;
          const items = prev.items.map(item =>
            item.id === id ? { ...item, status: newStatus } : item
          );
          const counts = { ...prev.counts };
          return { items, counts };
        });
        // Re-fetch to get accurate counts
        setTimeout(fetchData, 500);
      }
    } catch {
      // silent
    } finally {
      setUpdating(null);
    }
  }

  async function convertToTask(id: string) {
    const projectId = project || 'organism';
    setUpdating(id);
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'convert', projectId }),
      });
      if (res.ok) {
        const json = await res.json();
        setData(prev => {
          if (!prev) return prev;
          const items = prev.items.map(item =>
            item.id === id
              ? { ...item, status: 'converted' as FeedbackStatus, linkedActionItemId: json.actionItemId ?? null }
              : item
          );
          return { ...prev, items };
        });
        setTimeout(fetchData, 500);
      }
    } catch {
      // silent
    } finally {
      setUpdating(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────

  const items = data?.items ?? [];
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pendingCount = counts['pending'] ?? 0;

  return (
    <>
      <Header title="Feedback" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        {/* Loading */}
        {loading && (
          <div className="text-center py-16">
            <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
            <p className="text-sm text-zinc-500">Loading feedback...</p>
          </div>
        )}

        {data && (
          <>
            {/* ── Summary bar ─────────────────────────────── */}
            <div className="max-w-5xl mx-auto mb-6">
              <div className="bg-surface rounded-xl border border-edge p-4 md:p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-zinc-100">Agentation Feedback</h2>
                  {pendingCount > 0 && (
                    <span className="bg-amber-500/20 text-amber-400 text-xs font-semibold px-2 py-0.5 rounded-full">
                      {pendingCount} pending
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  {Object.entries(counts).map(([status, count]) => {
                    const style = STATUS_STYLES[status];
                    return (
                      <button
                        key={status}
                        onClick={() => setStatusFilter(statusFilter === status ? '' : status)}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          statusFilter === status
                            ? `${style?.bg ?? 'bg-zinc-800'} ${style?.text ?? 'text-zinc-400'} ring-1 ring-current`
                            : 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {style?.label ?? status}: {count}
                      </button>
                    );
                  })}
                  <span className="text-zinc-600 py-1">{total} total</span>
                </div>
              </div>
            </div>

            {/* ── Filters ─────────────────────────────────── */}
            <div className="max-w-5xl mx-auto mb-4 flex flex-wrap gap-2">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 min-h-[44px]"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="converted">Converted</option>
                <option value="resolved">Resolved</option>
                <option value="dismissed">Dismissed</option>
              </select>

              <select
                value={sessionFilter}
                onChange={e => setSessionFilter(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 min-h-[44px]"
              >
                <option value="">All sessions</option>
                {sessions.map(s => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.sessionId.slice(0, 8)}... ({s.count} items, {s.pendingCount} pending)
                  </option>
                ))}
              </select>

              {(statusFilter || sessionFilter) && (
                <button
                  onClick={() => { setStatusFilter(''); setSessionFilter(''); }}
                  className="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] flex items-center"
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* ── Feedback list ────────────────────────────── */}
            <div className="max-w-5xl mx-auto space-y-2">
              {items.map(item => (
                <FeedbackCard
                  key={item.id}
                  item={item}
                  onAcknowledge={() => updateStatus(item.id, 'acknowledged')}
                  onDismiss={() => updateStatus(item.id, 'dismissed')}
                  onResolve={() => updateStatus(item.id, 'resolved')}
                  onConvert={() => convertToTask(item.id)}
                  isUpdating={updating === item.id}
                />
              ))}

              {items.length === 0 && !loading && (
                <div className="text-center py-16">
                  <div className="text-4xl mb-3 opacity-40">?</div>
                  <h3 className="text-lg font-semibold text-zinc-300 mb-2">No feedback items</h3>
                  <p className="text-sm text-zinc-500">
                    {statusFilter || sessionFilter
                      ? 'No items match your filters. Try clearing them.'
                      : 'Run sync-agentation to import annotations from the Agentation server.'}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Feedback Card Component ─────────────────────────────────

function FeedbackCard({
  item,
  onAcknowledge,
  onDismiss,
  onResolve,
  onConvert,
  isUpdating,
}: {
  item: FeedbackItem;
  onAcknowledge: () => void;
  onDismiss: () => void;
  onResolve: () => void;
  onConvert: () => void;
  isUpdating: boolean;
}) {
  const statusStyle = STATUS_STYLES[item.status] ?? STATUS_STYLES.pending;
  const severityStyle = item.severity ? SEVERITY_STYLES[item.severity] : null;

  return (
    <div className="bg-surface rounded-xl border border-edge p-4 hover:bg-surface-alt/30 transition-colors">
      {/* Header row */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {/* Status badge */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${statusStyle.bg} ${statusStyle.text}`}>
          {statusStyle.label}
        </span>

        {/* Severity badge */}
        {severityStyle && item.severity && (
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${severityStyle.bg} ${severityStyle.text}`}>
            {item.severity}
          </span>
        )}

        {/* Kind badge */}
        {item.annotationKind && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400">
            {item.annotationKind}
          </span>
        )}

        {/* Source */}
        <span className="text-[10px] text-zinc-600 ml-auto">
          {item.source}
        </span>

        {/* Time */}
        <span className="text-[10px] text-zinc-600">
          {timeAgo(item.createdAt)}
        </span>
      </div>

      {/* Page URL */}
      {item.pageUrl && (
        <div className="mb-1.5">
          <span className="text-[10px] text-zinc-500 font-mono break-all">
            {item.pageUrl}
          </span>
        </div>
      )}

      {/* Body */}
      <p className="text-sm text-zinc-300 leading-relaxed mb-3 whitespace-pre-wrap">
        {item.body}
      </p>

      {/* Linked task */}
      {item.linkedActionItemId && (
        <div className="mb-2">
          <a
            href={`/plan`}
            className="text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Linked to action item {item.linkedActionItemId.slice(0, 8)}...
          </a>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {item.status === 'pending' && (
          <>
            <button
              onClick={onAcknowledge}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
            >
              {isUpdating ? '...' : 'Acknowledge'}
            </button>
            <button
              onClick={onDismiss}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-50"
            >
              {isUpdating ? '...' : 'Dismiss'}
            </button>
          </>
        )}
        {item.status === 'acknowledged' && (
          <>
            <button
              onClick={onConvert}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
            >
              {isUpdating ? '...' : 'Convert to Task'}
            </button>
            <button
              onClick={onResolve}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
            >
              {isUpdating ? '...' : 'Resolve'}
            </button>
            <button
              onClick={onDismiss}
              disabled={isUpdating}
              className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-50"
            >
              {isUpdating ? '...' : 'Dismiss'}
            </button>
          </>
        )}
        {item.status === 'converted' && (
          <button
            onClick={onResolve}
            disabled={isUpdating}
            className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
          >
            {isUpdating ? '...' : 'Resolve'}
          </button>
        )}

        {/* Session ID */}
        {item.sessionId && (
          <span className="ml-auto text-[10px] text-zinc-600 font-mono">
            session: {item.sessionId.slice(0, 8)}
          </span>
        )}
      </div>
    </div>
  );
}
