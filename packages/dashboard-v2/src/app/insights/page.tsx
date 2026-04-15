'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from '@/components/header';
import { cleanForDisplay, renderMarkdown } from '@/lib/markdown';
import { getInitialSelectedProject } from '@/lib/selected-project';

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

interface ReviewCycle {
  id: string;
  project_id: string;
  started_at: number;
  completed_at: number | null;
  task_count: number;
  completed_count: number;
  failed_count: number;
  total_cost: number;
  agents_used: number;
  carry_over: number;
  status: string;
}

// ── Domain grouping ──────────────────────────────────────────

const DOMAIN_MAP: Record<string, string> = {
  'ceo': 'Strategy', 'cto': 'Technology', 'cfo': 'Finance',
  'product-manager': 'Product', 'engineering': 'Engineering',
  'security-audit': 'Security', 'legal': 'Legal',
  'marketing-strategist': 'Marketing', 'marketing-executor': 'Marketing',
  'seo': 'Marketing', 'sales': 'Commercial', 'design': 'Design',
  'devops': 'Infrastructure', 'data-analyst': 'Data',
  'medical-content-reviewer': 'Medical Content',
  'quality-guardian': 'Quality', 'synthesis': 'Synthesis',
};

function domainFor(agent: string): string {
  return DOMAIN_MAP[agent] ?? 'Other';
}

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function normalizeFinding(description: string): string {
  return cleanForDisplay(description)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Component ──────────────────────────────────────────────────

export default function InsightsPage() {
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [cycles, setCycles] = useState<ReviewCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const requestSeq = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const pf = project ? `?project=${project}` : '';
      const [assessRes, cyclesRes] = await Promise.all([
        fetch(`/api/assessments${pf}`, { cache: 'no-store' }),
        fetch(`/api/cycles${pf}`, { cache: 'no-store' }),
      ]);
      if (seq !== requestSeq.current) return;
      if (assessRes.ok) {
        const data = await assessRes.json();
        if (seq !== requestSeq.current) return;
        setRuns(data.runs ?? []);
      }
      if (cyclesRes.ok) {
        const data = await cyclesRes.json();
        if (seq !== requestSeq.current) return;
        setCycles(data.cycles ?? []);
      }
      setLastUpdated(new Date());
    } catch { /* silent */ }
    finally {
      if (seq === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    setRuns([]);
    setCycles([]);
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const latestRun = runs[0] ?? null;

  // Current-state findings come from the latest review run so old polluted history
  // does not masquerade as the current project state.
  const allFindings = useMemo(() => {
    const findings = (latestRun ? latestRun.topFindings : [])
      .map(f => ({ ...f, runDate: latestRun?.date ?? '', project: latestRun?.projectName ?? '' }))
      .filter((finding, index, list) => list.findIndex((item) => normalizeFinding(item.description) === normalizeFinding(finding.description)) === index);
    findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
    return findings;
  }, [latestRun]);

  // Group findings by domain
  const byDomain = useMemo(() => {
    const map = new Map<string, typeof allFindings>();
    for (const f of allFindings) {
      const domain = domainFor(f.agent);
      if (!map.has(domain)) map.set(domain, []);
      map.get(domain)!.push(f);
    }
    return [...map.entries()].sort((a, b) => {
      const aMax = Math.min(...a[1].map(f => SEVERITY_ORDER[f.severity] ?? 3));
      const bMax = Math.min(...b[1].map(f => SEVERITY_ORDER[f.severity] ?? 3));
      return aMax - bMax;
    });
  }, [allFindings]);

  // Latest synthesis
  const latestSynthesis = latestRun?.synthesisSummary ?? null;

  // Stats
  const totalCost = runs.reduce((s, r) => s + r.totalCost, 0);
  const highCount = allFindings.filter(f => f.severity === 'HIGH').length;
  const mediumCount = allFindings.filter(f => f.severity === 'MEDIUM').length;

  return (
    <>
      <Header title="Insights" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        <div className="max-w-3xl mx-auto space-y-6">

          {loading && (
            <div className="text-center py-16">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
              <p className="text-sm text-zinc-500">Loading insights...</p>
            </div>
          )}

          {!loading && runs.length === 0 && (
            <div className="text-center py-16">
              <h3 className="text-lg font-semibold text-zinc-300 mb-2">No insights yet</h3>
              <p className="text-sm text-zinc-500">Run a review to generate insights.</p>
            </div>
          )}

          {!loading && runs.length > 0 && (
            <>
              {/* ── The Letter ───────────────────────────────────── */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 md:p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-zinc-100">State of the Project</h2>
                  <span className="text-xs text-zinc-600">
                    {runs.length} review{runs.length !== 1 ? 's' : ''} overall | latest run drives current state
                  </span>
                </div>

                {/* Traffic light summary */}
                <div className="flex items-center gap-4 mb-5 pb-5 border-b border-zinc-800">
                  {highCount > 0 ? (
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full bg-red-500" />
                      <span className="text-sm text-red-400 font-medium">{highCount} critical issue{highCount !== 1 ? 's' : ''} need attention</span>
                    </div>
                  ) : mediumCount > 0 ? (
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full bg-amber-500" />
                      <span className="text-sm text-amber-400 font-medium">{mediumCount} issue{mediumCount !== 1 ? 's' : ''} worth reviewing</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full bg-green-500" />
                      <span className="text-sm text-green-400 font-medium">Looking good — no critical issues</span>
                    </div>
                  )}
                </div>

                {/* Synthesis — the executive summary */}
                {latestSynthesis && (
                  <div className="mb-5">
                    <div
                      className="text-sm text-zinc-300 leading-relaxed prose-sm prose-invert max-w-none
                        [&_.md-h1]:text-base [&_.md-h1]:font-bold [&_.md-h1]:text-zinc-200 [&_.md-h1]:mt-4 [&_.md-h1]:mb-2
                        [&_.md-h2]:text-sm [&_.md-h2]:font-bold [&_.md-h2]:text-zinc-200 [&_.md-h2]:mt-3 [&_.md-h2]:mb-1.5
                        [&_.md-h3]:text-sm [&_.md-h3]:font-semibold [&_.md-h3]:text-zinc-300 [&_.md-h3]:mt-2 [&_.md-h3]:mb-1
                        [&_.md-p]:mb-2
                        [&_.md-ul]:list-disc [&_.md-ul]:pl-4 [&_.md-ul]:mb-2
                        [&_.md-ol]:list-decimal [&_.md-ol]:pl-4 [&_.md-ol]:mb-2
                        [&_.md-li]:mb-1
                        [&_.md-pre]:bg-zinc-950 [&_.md-pre]:rounded [&_.md-pre]:p-2 [&_.md-pre]:my-2 [&_.md-pre]:overflow-x-auto
                        [&_.md-code]:bg-zinc-800 [&_.md-code]:px-1 [&_.md-code]:rounded [&_.md-code]:text-emerald-400
                        [&_.md-hr]:border-zinc-700 [&_.md-hr]:my-3
                        [&_.md-table-wrap]:overflow-x-auto [&_.md-table-wrap]:my-2
                        [&_.md-table]:w-full [&_.md-table]:text-xs
                        [&_.md-th]:text-left [&_.md-th]:px-2 [&_.md-th]:py-1 [&_.md-th]:border-b [&_.md-th]:border-zinc-700 [&_.md-th]:text-zinc-400
                        [&_.md-td]:px-2 [&_.md-td]:py-1 [&_.md-td]:border-b [&_.md-td]:border-zinc-800"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(cleanForDisplay(latestSynthesis)) }}
                    />
                  </div>
                )}

                {/* If no synthesis, show a generated summary from findings */}
                {!latestSynthesis && allFindings.length > 0 && (
                  <p className="text-sm text-zinc-400 mb-5">
                    {allFindings.length} finding{allFindings.length !== 1 ? 's' : ''} across {byDomain.length} domain{byDomain.length !== 1 ? 's' : ''}.
                    {highCount > 0 && ` ${highCount} require immediate action.`}
                    {highCount === 0 && mediumCount > 0 && ` ${mediumCount} worth reviewing when you have time.`}
                    {highCount === 0 && mediumCount === 0 && ' All low severity — routine maintenance items.'}
                  </p>
                )}
              </div>

              {/* ── By Domain ────────────────────────────────────── */}
              {byDomain.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">By Domain</h3>

                  {byDomain.map(([domain, findings]) => {
                    const high = findings.filter(f => f.severity === 'HIGH').length;
                    const med = findings.filter(f => f.severity === 'MEDIUM').length;
                    const low = findings.filter(f => f.severity === 'LOW').length;
                    const dotColor = high > 0 ? 'bg-red-500' : med > 0 ? 'bg-amber-500' : 'bg-green-500';

                    return (
                      <div key={domain} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                          <h4 className="text-sm font-semibold text-zinc-200">{domain}</h4>
                          <div className="flex items-center gap-1.5 ml-auto">
                            {high > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">{high} high</span>}
                            {med > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">{med} med</span>}
                            {low > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">{low} low</span>}
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          {findings.map((f, i) => (
                            <p key={i} className="text-xs text-zinc-400 leading-relaxed pl-4">
                              {cleanForDisplay(f.description).split(/[.!?\n]/)[0].trim() || f.description.slice(0, 100)}
                            </p>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Review Cycles ──────────────────────────────────── */}
              {cycles.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Review Cycles</h3>

                  {/* Cost trend indicator */}
                  {cycles.length >= 2 && (() => {
                    const recent = cycles[0];
                    const prev = cycles[1];
                    const recentCost = Number(recent.total_cost) || 0;
                    const prevCost = Number(prev.total_cost) || 0;
                    if (prevCost === 0) return null;
                    const pctChange = ((recentCost - prevCost) / prevCost) * 100;
                    const direction = pctChange > 5 ? 'up' : pctChange < -5 ? 'down' : 'flat';
                    const color = direction === 'down' ? 'text-green-400' : direction === 'up' ? 'text-red-400' : 'text-zinc-400';
                    const arrow = direction === 'down' ? 'v' : direction === 'up' ? '^' : '~';
                    return (
                      <div className={`text-xs ${color} mb-2 px-1`}>
                        Cost trend: {arrow} {Math.abs(pctChange).toFixed(0)}% {direction === 'down' ? 'decrease' : direction === 'up' ? 'increase' : 'stable'} vs previous cycle
                      </div>
                    );
                  })()}

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-zinc-500 border-b border-zinc-800">
                          <th className="text-left py-1.5 px-2 font-medium">Date</th>
                          <th className="text-right py-1.5 px-2 font-medium">Tasks</th>
                          <th className="text-right py-1.5 px-2 font-medium">Agents</th>
                          <th className="text-right py-1.5 px-2 font-medium">Cost</th>
                          <th className="text-right py-1.5 px-2 font-medium">Duration</th>
                          <th className="text-left py-1.5 px-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cycles.map(c => {
                          const startedAt = Number(c.started_at);
                          const completedAt = c.completed_at ? Number(c.completed_at) : null;
                          const durationMs = completedAt ? completedAt - startedAt : null;
                          const durationMin = durationMs ? Math.round(durationMs / 60000) : null;
                          const cost = Number(c.total_cost) || 0;
                          const statusColor = c.status === 'completed' ? 'text-green-400' : c.status === 'running' ? 'text-amber-400' : 'text-zinc-500';
                          return (
                            <tr key={c.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                              <td className="py-1.5 px-2 text-zinc-400 font-mono">
                                {new Date(startedAt).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}
                              </td>
                              <td className="py-1.5 px-2 text-right text-zinc-300">
                                {c.task_count}
                                {Number(c.failed_count) > 0 && <span className="text-red-400 ml-1">({c.failed_count}F)</span>}
                              </td>
                              <td className="py-1.5 px-2 text-right text-zinc-300">{c.agents_used}</td>
                              <td className="py-1.5 px-2 text-right text-amber-500/80 font-mono">${cost.toFixed(2)}</td>
                              <td className="py-1.5 px-2 text-right text-zinc-400">
                                {durationMin !== null ? `${durationMin}m` : '--'}
                              </td>
                              <td className={`py-1.5 px-2 ${statusColor}`}>{c.status}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Review History ────────────────────────────────── */}
              <div>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Review History</h3>
                <div className="space-y-2">
                  {runs.map(run => (
                    <div key={run.id} className="flex items-center gap-3 text-xs bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-3">
                      <span className="text-zinc-600 font-mono shrink-0">{run.date}</span>
                      <span className="text-zinc-300 flex-1">{run.projectName}</span>
                      <span className="text-zinc-600">{run.agentCount} agents</span>
                      <span className="text-zinc-600">{run.topFindings.length} findings</span>
                      <span className="text-amber-500/80 font-mono">${run.totalCost.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
