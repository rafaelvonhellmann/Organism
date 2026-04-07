'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/header';
import { cleanForDisplay, renderMarkdown } from '@/lib/markdown';

// ── Types ──────────────────────────────────────────────────────

interface ReviewRun {
  id: string;
  date: string;
  hour: number;
  projectId: string;
  projectName: string;
  agentCount: number;
  agents: string[];
  taskCount: number;
  totalCost: number;
  synthesisSummary: string | null;
  statuses: { approved: number; rejected: number; dismissed: number; changes_requested: number; pending: number };
  topFindings: { agent: string; description: string; severity: string }[];
  earliestTaskId: string | null;
}

// ── Agent role mapping ─────────────────────────────────────────

const AGENT_ROLES: Record<string, string> = {
  'ceo': 'CEO', 'cto': 'CTO', 'cfo': 'CFO', 'product-manager': 'Product',
  'data-analyst': 'Data', 'engineering': 'Engineering', 'devops': 'DevOps',
  'security-audit': 'Security', 'quality-guardian': 'Guardian',
  'marketing-strategist': 'Marketing', 'marketing-executor': 'Marketing Exec',
  'seo': 'SEO', 'legal': 'Legal', 'sales': 'Sales',
  'medical-content-reviewer': 'Research', 'community-manager': 'Community',
  'pr-comms': 'PR', 'customer-success': 'Success', 'hr': 'HR', 'design': 'Design',
  'synthesis': 'Synthesis',
};

function agentRole(agent: string): string {
  return AGENT_ROLES[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Helpers ────────────────────────────────────────────────────

function formatRunDate(date: string): string {
  const d = new Date(date + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function formatRunTime(hour: number): string {
  const h = hour.toString().padStart(2, '0');
  return `${h}:00`;
}

function briefFinding(desc: string): string {
  let d = desc
    .replace(/^(Strategic review|Technology strategy|Financial analysis|Product gap analysis|Architecture review|Infrastructure audit|Security audit|Marketing strategy|Marketing execution|SEO analysis|Community strategy|PR plan|Australian legal review|Sales strategy|Customer success|Team plan|Competitive intelligence|Metrics framework|Research workflow review|\[QUALITY AUDIT\]|Quality review|Codex review):?\s*/i, '')
    .replace(/^[""\u201C]/, '')
    .replace(/[""\u201D]$/, '')
    .replace(/\s+using codeEvidence.*$/i, '');
  const first = d.split(/[.!?\n]/)[0].trim();
  if (first.length > 80) return first.slice(0, 77) + '...';
  return first || desc.slice(0, 70);
}

const SEVERITY_STYLES: Record<string, { bg: string; text: string }> = {
  HIGH: { bg: 'bg-red-500/15', text: 'text-red-400' },
  MEDIUM: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  LOW: { bg: 'bg-green-500/15', text: 'text-green-400' },
};

function severityStyle(sev: string) {
  return SEVERITY_STYLES[sev] ?? { bg: 'bg-zinc-700/50', text: 'text-zinc-400' };
}

// ── Component ──────────────────────────────────────────────────

export default function InsightsPage() {
  const [project, setProject] = useState('');
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const pf = project ? `?project=${project}` : '';
      const res = await fetch(`/api/assessments${pf}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
      setLastUpdated(new Date());
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // Group runs by date
  const groupedByDate = runs.reduce<Record<string, ReviewRun[]>>((acc, run) => {
    if (!acc[run.date]) acc[run.date] = [];
    acc[run.date].push(run);
    return acc;
  }, {});

  const dates = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));

  // Aggregate stats
  const totalRuns = runs.length;
  const totalCost = runs.reduce((s, r) => s + r.totalCost, 0);
  const totalFindings = runs.reduce((s, r) => s + r.topFindings.length, 0);

  return (
    <>
      <Header title="Insights" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        <div className="max-w-4xl mx-auto space-y-5">

          {/* Summary stats */}
          {runs.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Total Runs" value={String(totalRuns)} accent="text-emerald-400" />
              <StatCard label="Total Cost" value={`$${totalCost.toFixed(2)}`} accent="text-amber-400" />
              <StatCard label="Total Findings" value={String(totalFindings)} accent="text-blue-400" />
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="text-center py-16">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
              <p className="text-sm text-zinc-500">Loading insights...</p>
            </div>
          )}

          {/* Runs grouped by date */}
          {!loading && dates.length > 0 && dates.map(date => (
            <div key={date}>
              {/* Date header */}
              <div className="flex items-center gap-3 mb-3">
                <h3 className="text-sm font-semibold text-zinc-300">{formatRunDate(date)}</h3>
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-xs text-zinc-600 font-mono">{groupedByDate[date].length} run{groupedByDate[date].length !== 1 ? 's' : ''}</span>
              </div>

              <div className="space-y-3">
                {groupedByDate[date].map(run => (
                  <InsightCard
                    key={run.id}
                    run={run}
                    expanded={expandedRun === run.id}
                    onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Empty state */}
          {!loading && runs.length === 0 && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3 opacity-40">&amp;</div>
              <h3 className="text-lg font-semibold text-zinc-300 mb-2">No insights yet</h3>
              <p className="text-sm text-zinc-500">
                Insights appear here once the Organism runs reviews against your projects.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Stat Card ──────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 md:p-4">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{label}</p>
      <p className={`text-lg md:text-xl font-bold font-mono ${accent}`}>{value}</p>
    </div>
  );
}

// ── Insight Card ───────────────────────────────────────────────

function InsightCard({ run, expanded, onToggle }: { run: ReviewRun; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden hover:border-zinc-700 transition-colors">
      {/* Card header - clickable */}
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex items-start md:items-center gap-3 md:gap-4"
      >
        {/* Time badge */}
        <div className="shrink-0 text-center">
          <span className="text-xs font-mono text-zinc-500">{formatRunTime(run.hour)}</span>
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-semibold text-zinc-200">{cleanForDisplay(run.projectName)}</span>
            <span className="text-[10px] text-zinc-600 font-mono">{run.agentCount} agents</span>
            {run.totalCost > 0 && (
              <span className="text-[10px] text-amber-500/80 font-mono">${run.totalCost.toFixed(3)}</span>
            )}
            {run.topFindings.length > 0 && (
              <span className="text-[10px] text-blue-400/80 font-mono">{run.topFindings.length} finding{run.topFindings.length !== 1 ? 's' : ''}</span>
            )}
          </div>

          {/* Severity summary pills */}
          <div className="flex items-center gap-2 flex-wrap">
            {(() => {
              const high = run.topFindings.filter(f => f.severity === 'HIGH').length;
              const medium = run.topFindings.filter(f => f.severity === 'MEDIUM').length;
              const low = run.topFindings.filter(f => f.severity === 'LOW').length;
              return (
                <>
                  {high > 0 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/15 text-red-400">
                      {high} high
                    </span>
                  )}
                  {medium > 0 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400">
                      {medium} medium
                    </span>
                  )}
                  {low > 0 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-400">
                      {low} low
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* Expand chevron */}
        <span className={`text-zinc-600 text-sm transition-transform ${expanded ? 'rotate-180' : ''}`}>
          &#9660;
        </span>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-zinc-800 px-4 pb-4 pt-3 space-y-3">
          {/* Synthesis summary — rendered as markdown */}
          {run.synthesisSummary && (
            <div className="bg-zinc-800/40 rounded-lg p-3">
              <p className="text-[10px] uppercase tracking-wider text-emerald-500/70 mb-1.5">Synthesis Summary</p>
              <div
                className="text-xs text-zinc-300 leading-relaxed prose-sm prose-invert max-w-none
                  [&_.md-h1]:text-sm [&_.md-h1]:font-bold [&_.md-h1]:text-zinc-200 [&_.md-h1]:mt-3 [&_.md-h1]:mb-1
                  [&_.md-h2]:text-sm [&_.md-h2]:font-bold [&_.md-h2]:text-zinc-200 [&_.md-h2]:mt-3 [&_.md-h2]:mb-1
                  [&_.md-h3]:text-xs [&_.md-h3]:font-semibold [&_.md-h3]:text-zinc-300 [&_.md-h3]:mt-2 [&_.md-h3]:mb-1
                  [&_.md-h4]:text-xs [&_.md-h4]:font-semibold [&_.md-h4]:text-zinc-400 [&_.md-h4]:mt-2 [&_.md-h4]:mb-1
                  [&_.md-p]:mb-1.5
                  [&_.md-ul]:list-disc [&_.md-ul]:pl-4 [&_.md-ul]:mb-1.5
                  [&_.md-ol]:list-decimal [&_.md-ol]:pl-4 [&_.md-ol]:mb-1.5
                  [&_.md-li]:mb-0.5
                  [&_.md-pre]:bg-zinc-900 [&_.md-pre]:rounded [&_.md-pre]:p-2 [&_.md-pre]:my-1.5 [&_.md-pre]:overflow-x-auto
                  [&_.md-code]:bg-zinc-800 [&_.md-code]:px-1 [&_.md-code]:rounded [&_.md-code]:text-emerald-400
                  [&_.md-hr]:border-zinc-700 [&_.md-hr]:my-2
                  [&_.md-table-wrap]:overflow-x-auto [&_.md-table-wrap]:my-1.5
                  [&_.md-table]:w-full [&_.md-table]:text-xs
                  [&_.md-th]:text-left [&_.md-th]:px-2 [&_.md-th]:py-1 [&_.md-th]:border-b [&_.md-th]:border-zinc-700 [&_.md-th]:text-zinc-400
                  [&_.md-td]:px-2 [&_.md-td]:py-1 [&_.md-td]:border-b [&_.md-td]:border-zinc-800
                  [&_.md-link]:text-emerald-400 [&_.md-link]:underline"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(cleanForDisplay(run.synthesisSummary)) }}
              />
            </div>
          )}

          {/* Top findings */}
          {run.topFindings.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Key Findings</p>
              <div className="space-y-1.5">
                {run.topFindings.map((f, i) => {
                  const style = severityStyle(f.severity);
                  return (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${style.bg} ${style.text}`}>
                        {f.severity}
                      </span>
                      <span className="text-zinc-500 shrink-0 w-16 text-[10px] uppercase font-semibold tracking-wider pt-0.5">
                        {agentRole(f.agent)}
                      </span>
                      <span className="text-zinc-300 leading-relaxed">
                        {briefFinding(cleanForDisplay(f.description))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Participating agents */}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Agents</p>
            <div className="flex flex-wrap gap-1.5">
              {run.agents.map(a => (
                <span key={a} className="inline-flex items-center px-2 py-0.5 rounded bg-zinc-800/60 text-[10px] font-medium text-zinc-400">
                  {agentRole(a)}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
