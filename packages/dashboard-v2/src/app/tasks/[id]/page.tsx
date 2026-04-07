'use client';

import { use, useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/header';
import { StatusBadge } from '@/components/status-badge';
import { usePolling } from '@/hooks/use-polling';
import { renderMarkdown } from '@/lib/markdown';

interface TaskDetail {
  task: {
    id: string; agent: string; status: string; lane: string;
    description: string; input: unknown; output: unknown;
    tokensUsed: number | null; costUsd: number | null;
    startedAt: number | null; completedAt: number | null;
    error: string | null; parentTaskId: string | null;
    projectId: string; createdAt: number;
  };
  auditTrail: Array<{
    id: number; ts: number; agent: string; taskId: string;
    action: string; payload: unknown; outcome: string; errorCode: string | null;
  }>;
  gates: Array<{
    id: string; gate: string; decision: string;
    decidedBy: string | null; reason: string | null; decidedAt: number | null;
  }>;
  childTasks: Array<{
    id: string; agent: string; status: string; lane: string;
    description: string; createdAt: number;
  }>;
  parentTask: {
    id: string; agent: string; status: string; description: string;
  } | null;
  prevTaskId: string | null;
  nextTaskId: string | null;
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return '\u2014';
  return new Date(ms).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function duration(start: number | null, end: number | null): string {
  if (!start || !end) return '\u2014';
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Extract readable assessment text from the task output */
function extractAssessment(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return extractAssessment(parsed);
    } catch {
      return output.length > 0 ? output : null;
    }
  }
  if (typeof output === 'object' && output !== null) {
    const o = output as Record<string, unknown>;

    // Special handling for shaping tasks
    if (o.type === 'shaping_complete' || o.pitchId || o.betId) {
      const parts: string[] = [];
      if (typeof o.title === 'string') parts.push(`**${o.title}**`);
      if (typeof o.problem === 'string') parts.push(o.problem as string);
      if (typeof o.appetite === 'string') parts.push(`**Appetite:** ${o.appetite}`);
      if (Array.isArray(o.successCriteria) && o.successCriteria.length > 0) {
        parts.push('**Success criteria:** ' + (o.successCriteria as string[]).join(', '));
      }
      if (parts.length > 0) return parts.join('\n\n');
    }

    const KEYS = ['scrutiny', 'report', 'brief', 'implementation', 'analysis', 'plan', 'spec', 'review', 'assessment', 'content', 'result', 'summary', 'text'];

    for (const key of KEYS) {
      if (typeof o[key] === 'string' && (o[key] as string).trim().length > 10) {
        return o[key] as string;
      }
    }

    for (const key of KEYS) {
      if (o[key] && typeof o[key] === 'object') {
        const nested = extractAssessment(o[key]);
        if (nested && !nested.startsWith('{') && !nested.startsWith('[')) {
          return nested;
        }
      }
    }

    let bestStr = '';
    for (const val of Object.values(o)) {
      if (typeof val === 'string' && val.trim().length > bestStr.length) {
        bestStr = val.trim();
      }
    }
    if (bestStr.length > 10) return bestStr;

    for (const val of Object.values(o)) {
      if (val && typeof val === 'object') {
        const nested = extractAssessment(val);
        if (nested && !nested.startsWith('{') && !nested.startsWith('[')) {
          return nested;
        }
      }
    }

    const entries = Object.entries(o).filter(([, v]) => v != null && v !== '');
    if (entries.length > 0) {
      const parts = entries.map(([k, v]) => {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
        const value = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        return `**${label}:** ${value}`;
      });
      return parts.join('\n\n');
    }
  }
  return null;
}

/** Format the full output object with all sections rendered as markdown */
function formatFullOutput(output: unknown): string {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (typeof output !== 'object') return String(output);

  const obj = output as Record<string, unknown>;
  const sections: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const heading = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
    if (typeof value === 'string') {
      sections.push(`### ${heading}\n\n${value}`);
    } else if (typeof value === 'object') {
      sections.push(`### ${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
    } else {
      sections.push(`### ${heading}\n\n${String(value)}`);
    }
  }
  return sections.join('\n\n');
}

/** Create a brief human-readable title from the description */
function briefTitle(desc: string, agent: string): string {
  const roles: Record<string, string> = {
    'ceo': 'Strategic Review',
    'cto': 'Technology Strategy',
    'cfo': 'Financial Analysis',
    'product-manager': 'Product Gap Analysis',
    'data-analyst': 'Data & Metrics',
    'engineering': 'Technical Architecture',
    'devops': 'Infrastructure Audit',
    'security-audit': 'Security Audit',
    'quality-guardian': 'Quality Audit',
    'quality-agent': 'Quality Review',
    'grill-me': 'Socratic Interrogation',
    'codex-review': 'Cross-Model Review',
    'marketing-strategist': 'Marketing Strategy',
    'marketing-executor': 'Marketing Execution',
    'seo': 'SEO Analysis',
    'community-manager': 'Community Strategy',
    'pr-comms': 'PR & Communications',
    'legal': 'Legal Review',
    'sales': 'Sales Strategy',
    'customer-success': 'Customer Success',
    'hr': 'Team Planning',
    'medical-content-reviewer': 'Research Workflow Review',
    'design': 'Design Review',
  };
  return roles[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [decisionMade, setDecisionMade] = useState<string | null>(null);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState('');
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const { data, lastUpdated } = usePolling<TaskDetail>(`/api/tasks/${id}`, 30000);
  const t = data?.task;
  const assessment = t ? extractAssessment(t.output) : null;
  const title = t ? briefTitle(t.description, t.agent) : 'Task Detail';

  const prevId = data?.prevTaskId;
  const nextId = data?.nextTaskId;

  function goToNext() {
    if (nextId) router.push(`/tasks/${nextId}`);
    else if (prevId) router.push(`/tasks/${prevId}`);
  }

  async function postDecision(decision: string, reason?: string) {
    if (deciding || !t) return;
    setDeciding(true);

    try {
      const res = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: t.id, decision, reason }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      setDecisionMade(decision);
      setShowReplyForm(false);
      setReplyText('');

      // Notify sidebar
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('review-decision'));
      }

      // Auto-advance after a short delay
      if (decision !== 'reply') {
        setTimeout(() => goToNext(), 500);
      }
    } catch (err) {
      console.error('Decision failed:', err);
    } finally {
      setDeciding(false);
    }
  }

  // Auto-focus reply box
  useEffect(() => {
    if (showReplyForm && replyRef.current) {
      replyRef.current.focus();
    }
  }, [showReplyForm]);

  return (
    <>
      <Header
        title={title}
        project={project}
        onProjectChange={setProject}
        lastUpdated={lastUpdated}
      />

      <div className="p-6 space-y-6 max-w-4xl">
        {!data && (
          <div className="text-center py-12 text-zinc-600">Loading...</div>
        )}

        {t && (
          <>
            {/* Meta bar */}
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={t.status} variant="task" />
              <StatusBadge status={t.lane} variant="lane" />
              <span className="text-sm text-zinc-400">{t.agent}</span>
              {t.costUsd != null && (
                <span className="text-sm text-zinc-500 font-mono">${t.costUsd.toFixed(2)}</span>
              )}
              <span className="text-xs text-zinc-600">{duration(t.startedAt, t.completedAt)}</span>
              <span className="text-xs text-zinc-600">{formatTimestamp(t.completedAt ?? t.createdAt)}</span>
            </div>

            {/* Error */}
            {t.error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-300">{t.error}</p>
              </div>
            )}

            {/* Decision confirmation */}
            {decisionMade && (
              <div className={`p-3 rounded-lg border ${
                decisionMade === 'approved' ? 'bg-green-500/10 border-green-500/30 text-green-300' :
                decisionMade === 'reply' ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' :
                'bg-zinc-800 border-zinc-700 text-zinc-300'
              }`}>
                <p className="text-sm">
                  {decisionMade === 'approved' && 'Approved. Moving to next...'}
                  {decisionMade === 'reply' && 'Reply sent.'}
                  {decisionMade === 'dismissed' && 'Dismissed. Moving to next...'}
                  {decisionMade === 'changes_requested' && 'Changes requested. Moving to next...'}
                </p>
              </div>
            )}

            {/* Assessment output */}
            {assessment && (
              <div className="bg-surface rounded-xl border border-edge">
                <div className="p-5">
                  <div
                    className="max-w-none"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(formatFullOutput(t.output)) }}
                  />
                </div>

                {/* Action buttons: Approve | Reply | Dismiss */}
                {!decisionMade && (
                  <div className="border-t border-edge px-5 py-3 flex items-center gap-3">
                    <button
                      onClick={() => postDecision('approved')}
                      disabled={deciding}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
                    >
                      <span>&#10003;</span> Approve
                    </button>
                    <button
                      onClick={() => setShowReplyForm(!showReplyForm)}
                      disabled={deciding}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        showReplyForm
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          : 'bg-zinc-800 text-zinc-400 hover:bg-blue-500/10 hover:text-blue-400 border border-transparent'
                      }`}
                    >
                      Reply
                    </button>
                    <button
                      onClick={() => postDecision('dismissed')}
                      disabled={deciding}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
                    >
                      Dismiss
                    </button>

                    {/* Nav arrows */}
                    <div className="ml-auto flex items-center gap-1">
                      {prevId && (
                        <Link
                          href={`/tasks/${prevId}`}
                          className="px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 transition-colors"
                        >
                          &#8592; Prev
                        </Link>
                      )}
                      {nextId && (
                        <Link
                          href={`/tasks/${nextId}`}
                          className="px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 transition-colors"
                        >
                          Next &#8594;
                        </Link>
                      )}
                      <button
                        onClick={() => setShowRaw(!showRaw)}
                        className="px-3 py-2 rounded-lg text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                      >
                        {showRaw ? 'Hide raw' : 'Raw'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Reply form */}
                {showReplyForm && !decisionMade && (
                  <div className="border-t border-edge px-5 py-3">
                    <textarea
                      ref={replyRef}
                      value={replyText}
                      onChange={e => setReplyText(e.target.value)}
                      placeholder="Type your reply or question..."
                      className="w-full bg-zinc-900 border border-edge rounded-lg p-3 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500 resize-none"
                      rows={3}
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button
                        onClick={() => { setShowReplyForm(false); setReplyText(''); }}
                        className="px-3 py-1.5 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          if (replyText.trim()) {
                            postDecision('reply', replyText.trim());
                          }
                        }}
                        disabled={deciding || !replyText.trim()}
                        className="px-4 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
                      >
                        {deciding ? 'Sending...' : 'Send reply'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* No output yet */}
            {!assessment && t.status === 'in_progress' && (
              <div className="bg-surface rounded-xl border border-edge p-8 text-center">
                <div className="w-3 h-3 rounded-full bg-indigo-500 animate-pulse mx-auto mb-3" />
                <p className="text-sm text-zinc-400">Agent is working on this task...</p>
              </div>
            )}

            {!assessment && t.status === 'pending' && (
              <div className="bg-surface rounded-xl border border-edge p-8 text-center">
                <p className="text-sm text-zinc-500">Waiting in queue</p>
              </div>
            )}

            {/* Raw data (hidden by default) */}
            {showRaw && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {t.input != null && (
                  <div className="bg-surface rounded-xl border border-edge p-4">
                    <h4 className="text-xs font-medium text-zinc-500 mb-2">Raw Input</h4>
                    <pre className="text-xs text-zinc-400 bg-zinc-900 rounded-lg p-3 overflow-auto max-h-[600px] font-mono">
                      {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
                    </pre>
                  </div>
                )}
                {t.output != null && (
                  <div className="bg-surface rounded-xl border border-edge p-4">
                    <h4 className="text-xs font-medium text-zinc-500 mb-2">Raw Output</h4>
                    <pre className="text-xs text-zinc-400 bg-zinc-900 rounded-lg p-3 overflow-auto max-h-[600px] font-mono">
                      {typeof t.output === 'string' ? t.output : JSON.stringify(t.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Parent / Children */}
            {(data.parentTask || data.childTasks.length > 0) && (
              <div className="bg-surface rounded-xl border border-edge p-4">
                <h4 className="text-xs font-medium text-zinc-500 mb-2">Related Tasks</h4>
                {data.parentTask && (
                  <Link
                    href={`/tasks/${data.parentTask.id}`}
                    className="flex items-center gap-2 p-2 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/60 transition-colors mb-1"
                  >
                    <span className="text-[10px] text-zinc-600">parent</span>
                    <span className="text-xs text-zinc-300">{data.parentTask.agent}</span>
                    <StatusBadge status={data.parentTask.status} variant="task" />
                  </Link>
                )}
                {data.childTasks.map(c => (
                  <Link
                    key={c.id}
                    href={`/tasks/${c.id}`}
                    className="flex items-center gap-2 p-2 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/60 transition-colors mb-1"
                  >
                    <span className="text-[10px] text-zinc-600">child</span>
                    <span className="text-xs text-zinc-300">{c.agent}</span>
                    <StatusBadge status={c.status} variant="task" />
                    <StatusBadge status={c.lane} variant="lane" />
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
