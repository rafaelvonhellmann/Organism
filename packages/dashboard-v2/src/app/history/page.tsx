'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Header } from '@/components/header';
import { loadLocalHistoryBridge } from '@/lib/local-bridge-client';

// ── Types ──────────────────────────────────────────────────────

interface HistoryTask {
  id: string;
  agent: string;
  description: string;
  lane: string;
  costUsd: number | null;
  completedAt: number | null;
  createdAt: number;
  gate: {
    decision: string;
    reason: string | null;
    decidedAt: number | null;
  };
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
  'competitive-intel': 'Innovation Radar',
};

function agentRole(agent: string): string {
  return AGENT_ROLES[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Helpers ────────────────────────────────────────────────────

function briefTitle(desc: string): string {
  let d = desc
    .replace(/^(Strategic review|Technology strategy|Financial analysis|Product gap analysis|Architecture review|Infrastructure audit|Security audit|Marketing strategy|Marketing execution|SEO analysis|Community strategy|PR plan|Australian legal review|Sales strategy|Customer success|Team plan|Competitive intelligence|Metrics framework|Research workflow review|\[QUALITY AUDIT\]|Quality review|Codex review):?\s*/i, '')
    .replace(/^[""\u201C]/, '')
    .replace(/[""\u201D]$/, '')
    .replace(/\s+using codeEvidence.*$/i, '');
  const first = d.split(/[.!?\n]/)[0].trim();
  if (first.length > 70) return first.slice(0, 67) + '...';
  return first || desc.slice(0, 60);
}

function formatDate(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

const DECISION_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  approved: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Approved' },
  changes_requested: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Changes' },
  rejected: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Rejected' },
};

function decisionStyle(decision: string) {
  return DECISION_STYLES[decision] ?? { bg: 'bg-zinc-700/50', text: 'text-zinc-400', label: decision };
}

// ── Component ──────────────────────────────────────────────────

export default function HistoryPage() {
  const [project, setProject] = useState('');
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Filters
  const [decisionFilter, setDecisionFilter] = useState<string>('');
  const [agentFilter, setAgentFilter] = useState<string>('');

  const fetchHistory = useCallback(async () => {
    try {
      const local = await loadLocalHistoryBridge(project || undefined);
      if (local) {
        setTasks(local.tasks);
        setLastUpdated(new Date(local.generatedAt));
        return;
      }

      const url = project
        ? `/api/history?project=${project}`
        : '/api/history';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        // Fallback: fetch from tasks API and merge with gate decisions
        await fetchHistoryFallback();
        return;
      }
      const data = await res.json();
      setTasks(data.tasks ?? []);
      setLastUpdated(new Date());
    } catch {
      await fetchHistoryFallback();
    } finally {
      setLoading(false);
    }
  }, [project]);

  // Fallback: construct history from review-queue reviewed count + tasks API
  const fetchHistoryFallback = useCallback(async () => {
    try {
      const pf = project ? `&project=${project}` : '';
      const res = await fetch(`/api/tasks?status=completed&limit=100${pf}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();

      // For each task, check if there's a gate decision
      const historyTasks: HistoryTask[] = [];
      for (const task of data.tasks ?? []) {
        try {
          const detailRes = await fetch(`/api/tasks/${task.id}`, { cache: 'no-store' });
          if (!detailRes.ok) continue;
          const detail = await detailRes.json();
          const gates = detail.gates ?? [];
          const humanGate = gates.find((g: { gate: string; decision: string }) =>
            g.gate === 'G4' && g.decision !== 'pending'
          );
          if (humanGate) {
            historyTasks.push({
              id: task.id,
              agent: task.agent,
              description: task.description,
              lane: task.lane,
              costUsd: task.costUsd,
              completedAt: task.completedAt,
              createdAt: task.createdAt,
              gate: {
                decision: humanGate.decision,
                reason: humanGate.reason,
                decidedAt: humanGate.decidedAt,
              },
            });
          }
        } catch {
          // Skip this task
        }
      }
      setTasks(historyTasks);
      setLastUpdated(new Date());
    } catch {
      // Silent fail
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    fetchHistory();
    const id = setInterval(fetchHistory, 60_000);
    return () => clearInterval(id);
  }, [fetchHistory]);

  // Apply filters
  const filtered = tasks.filter(t => {
    if (decisionFilter && t.gate.decision !== decisionFilter) return false;
    if (agentFilter && t.agent !== agentFilter) return false;
    return true;
  });

  // Get unique agents for filter dropdown
  const uniqueAgents = [...new Set(tasks.map(t => t.agent))].sort();

  // Stats
  const approvedCount = tasks.filter(t => t.gate.decision === 'approved').length;
  const changesCount = tasks.filter(t => t.gate.decision === 'changes_requested').length;
  const rejectedCount = tasks.filter(t => t.gate.decision === 'rejected').length;

  return (
    <>
      <Header title="History" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        <div className="max-w-3xl mx-auto space-y-4">

          {/* Stats bar */}
          {tasks.length > 0 && (
            <div className="flex items-center gap-4 text-xs text-zinc-500">
              <span>{tasks.length} decisions</span>
              {approvedCount > 0 && <span className="text-green-400">{approvedCount} approved</span>}
              {changesCount > 0 && <span className="text-amber-400">{changesCount} changes</span>}
              {rejectedCount > 0 && <span className="text-red-400">{rejectedCount} rejected</span>}
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            <select
              value={decisionFilter}
              onChange={e => setDecisionFilter(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 min-h-[44px]"
            >
              <option value="">All decisions</option>
              <option value="approved">Approved</option>
              <option value="changes_requested">Changes requested</option>
              <option value="rejected">Rejected</option>
            </select>

            <select
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 min-h-[44px]"
            >
              <option value="">All agents</option>
              {uniqueAgents.map(a => (
                <option key={a} value={a}>{agentRole(a)}</option>
              ))}
            </select>

            {(decisionFilter || agentFilter) && (
              <button
                onClick={() => { setDecisionFilter(''); setAgentFilter(''); }}
                className="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] flex items-center"
              >
                Clear
              </button>
            )}
          </div>

          {/* Loading */}
          {loading && (
            <div className="text-center py-16">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
              <p className="text-sm text-zinc-500">Loading history...</p>
            </div>
          )}

          {/* Task list */}
          {!loading && filtered.length > 0 && (
            <div className="space-y-1.5">
              {filtered.map(task => {
                const style = decisionStyle(task.gate.decision);
                return (
                  <Link
                    key={task.id}
                    href={`/tasks/${task.id}`}
                    className="flex items-center gap-3 p-3 md:p-4 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors group"
                  >
                    {/* Agent role */}
                    <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider w-16 md:w-20 shrink-0">
                      {agentRole(task.agent)}
                    </span>

                    {/* Title */}
                    <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors flex-1 min-w-0 truncate">
                      {briefTitle(task.description)}
                    </span>

                    {/* Decision badge */}
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0 ${style.bg} ${style.text}`}>
                      {style.label}
                    </span>

                    {/* Timestamp */}
                    <span className="text-[10px] text-zinc-600 shrink-0 hidden md:block">
                      {formatDate(task.gate.decidedAt ?? task.completedAt)}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {!loading && filtered.length === 0 && tasks.length > 0 && (
            <div className="text-center py-16">
              <p className="text-sm text-zinc-500">No decisions match your filters.</p>
              <button
                onClick={() => { setDecisionFilter(''); setAgentFilter(''); }}
                className="mt-3 text-xs text-emerald-400 hover:text-emerald-300"
              >
                Clear filters
              </button>
            </div>
          )}

          {!loading && tasks.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3 opacity-40">#</div>
              <h3 className="text-lg font-semibold text-zinc-300 mb-2">No decisions yet</h3>
              <p className="text-sm text-zinc-500">Decisions you make in the review queue will appear here.</p>
              <Link
                href="/"
                className="inline-block mt-4 text-sm text-emerald-400 hover:text-emerald-300"
              >
                Go to review queue
              </Link>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
