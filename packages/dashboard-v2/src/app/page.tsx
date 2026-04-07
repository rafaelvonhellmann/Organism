'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { StatusBadge } from '@/components/status-badge';
import { renderMarkdown } from '@/lib/markdown';
import Link from 'next/link';

// ── Types ──────────────────────────────────────────────────────

interface QueueTask {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  input: unknown;
  output: unknown;
  tokensUsed: number | null;
  costUsd: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  parentTaskId: string | null;
  projectId: string;
  createdAt: number;
}

interface QueueResponse {
  tasks: QueueTask[];
  total: number;
  reviewed: number;
  pending: number;
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
};

function agentRole(agent: string): string {
  return AGENT_ROLES[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Urgency mapping from lane ──────────────────────────────────

function urgencyLabel(lane: string): { text: string; color: string } {
  switch (lane) {
    case 'HIGH': return { text: 'Needs attention now', color: 'text-red-400' };
    case 'MEDIUM': return { text: 'Worth reviewing soon', color: 'text-amber-400' };
    case 'LOW': return { text: 'Low priority', color: 'text-green-400' };
    default: return { text: '', color: 'text-zinc-500' };
  }
}

// ── Helpers ────────────────────────────────────────────────────

/** Strip technical codes and jargon, produce a plain English summary */
function simplifyText(text: string): string {
  return text
    // Remove OWASP codes like "OWASP: A04:2021"
    .replace(/OWASP:\s*A\d{2}:\d{4}/gi, '')
    // Remove APP references like "APP 12 (access)"
    .replace(/APP\s*\d+\s*\([^)]*\)/gi, '')
    // Remove CWE references
    .replace(/CWE-\d+/gi, '')
    // Remove CVE references
    .replace(/CVE-\d{4}-\d+/gi, '')
    // Remove NIST references
    .replace(/NIST\s*SP\s*\d+-\d+/gi, '')
    // Remove ISO references
    .replace(/ISO\s*\d+/gi, '')
    // Remove APRA references
    .replace(/APRA\s*CPS\s*\d+/gi, '')
    // Remove severity scores like "CVSS: 7.5"
    .replace(/CVSS:\s*[\d.]+/gi, '')
    // Remove empty parentheses left behind
    .replace(/\(\s*\)/g, '')
    // Remove double spaces
    .replace(/\s{2,}/g, ' ')
    // Remove leading/trailing whitespace on each line
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

function briefTitle(desc: string): string {
  let d = desc
    .replace(/^(Strategic review|Technology strategy|Financial analysis|Product gap analysis|Architecture review|Infrastructure audit|Security audit|Marketing strategy|Marketing execution|SEO analysis|Community strategy|PR plan|Australian legal review|Sales strategy|Customer success|Team plan|Competitive intelligence|Metrics framework|Research workflow review|\[QUALITY AUDIT\]|Quality review|Codex review):?\s*/i, '')
    .replace(/^[""\u201C]/, '')
    .replace(/[""\u201D]$/, '')
    .replace(/\s+using codeEvidence.*$/i, '');
  const first = d.split(/[.!?\n]/)[0].trim();
  if (first.length > 80) return first.slice(0, 77) + '...';
  return first || desc.slice(0, 60);
}

function extractAssessment(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === 'string') {
    try { return extractAssessment(JSON.parse(output)); }
    catch { return output.length > 0 ? output : null; }
  }
  if (typeof output === 'object' && output !== null) {
    const o = output as Record<string, unknown>;

    // Special handling for shaping tasks — use problem + title, not "Pitch shaped..."
    if (o.type === 'shaping_complete' || o.pitchId || o.betId) {
      const parts: string[] = [];
      if (typeof o.title === 'string') parts.push(`**${o.title}**`);
      if (typeof o.problem === 'string') parts.push(o.problem as string);
      if (typeof o.appetite === 'string') parts.push(`**Appetite:** ${o.appetite}`);
      if (Array.isArray(o.successCriteria) && o.successCriteria.length > 0) {
        parts.push('**Success criteria:** ' + (o.successCriteria as string[]).join(', '));
      }
      if (Array.isArray(o.noGos) && o.noGos.length > 0) {
        parts.push('**No-gos:** ' + (o.noGos as string[]).join(', '));
      }
      if (parts.length > 0) return parts.join('\n\n');
    }

    // Priority keys for regular assessments
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

    // Fallback: longest string value
    let bestStr = '';
    for (const val of Object.values(o)) {
      if (typeof val === 'string' && val.trim().length > bestStr.length) {
        bestStr = val.trim();
      }
    }
    if (bestStr.length > 10) return bestStr;

    // Last resort: format all entries
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

/** Condense a long assessment into a 2-3 sentence summary for the card view */
function condenseAssessment(raw: string): string {
  const simplified = simplifyText(raw);
  // Split into sentences
  const sentences = simplified
    .replace(/\n+/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/#+ /g, '')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 10);

  if (sentences.length <= 3) return sentences.join(' ');
  // Pick first 3 meaningful sentences
  return sentences.slice(0, 3).join(' ');
}

/** Try to extract a "why this matters" line from assessment text */
function extractWhyItMatters(raw: string): string | null {
  const lower = raw.toLowerCase();
  // Look for common patterns
  const patterns = [
    /(?:why (?:this|it) matters|impact|significance|risk|consequence)[:\s]*([^.\n]+[.]?)/i,
    /(?:this (?:means|could|will|affects|impacts))[:\s]*([^.\n]+[.]?)/i,
    /(?:without (?:this|fixing))[:\s]*([^.\n]+[.]?)/i,
  ];
  for (const pat of patterns) {
    const m = raw.match(pat);
    if (m && m[1] && m[1].trim().length > 15) {
      return simplifyText(m[1].trim());
    }
  }
  // Fallback: check for a "risk" or "impact" section
  const riskIdx = lower.indexOf('risk');
  if (riskIdx >= 0) {
    const after = raw.slice(riskIdx);
    const sentence = after.split(/[.\n]/)[0];
    if (sentence.length > 20 && sentence.length < 200) {
      return simplifyText(sentence);
    }
  }
  return null;
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-AU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function duration(start: number | null, end: number | null): string {
  if (!start || !end) return '';
  const s = Math.floor((end - start) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Dispatch a custom event to notify the sidebar that a decision was made */
function notifyDecision() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('review-decision'));
  }
}

// ── Component ──────────────────────────────────────────────────

export default function ReviewQueuePage() {
  return (
    <Suspense fallback={
      <div className="text-center py-16">
        <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    }>
      <ReviewQueueInner />
    </Suspense>
  );
}

function ReviewQueueInner() {
  const searchParams = useSearchParams();
  const perspectiveFilter = searchParams.get('perspective');

  const [project, setProject] = useState('');
  const [queue, setQueue] = useState<QueueTask[]>([]);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showFullText, setShowFullText] = useState(false);

  // Decision state
  const [deciding, setDeciding] = useState(false);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sessionStats, setSessionStats] = useState({ approved: 0, replied: 0, dismissed: 0, skipped: 0 });
  const [error, setError] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Track which task the user is looking at so polling doesn't replace it
  const stableQueueRef = useRef<QueueTask[]>([]);
  const currentTaskIdRef = useRef<string | null>(null);

  // Fetch queue
  const fetchQueue = useCallback(async () => {
    try {
      const url = project
        ? `/api/review-queue?project=${project}`
        : '/api/review-queue';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const data: QueueResponse = await res.json();

      let tasks = data.tasks;

      // Filter by perspective if query param is set
      if (perspectiveFilter) {
        tasks = tasks.filter(t => {
          const role = t.agent.toLowerCase();
          return role.includes(perspectiveFilter.toLowerCase()) ||
            t.description.toLowerCase().includes(perspectiveFilter.toLowerCase());
        });
      }

      // Stable merge: keep current task in place, update the rest
      const currentId = currentTaskIdRef.current;
      if (currentId && tasks.some(t => t.id === currentId)) {
        const newIndex = tasks.findIndex(t => t.id === currentId);
        setCurrentIndex(newIndex >= 0 ? newIndex : 0);
      }

      stableQueueRef.current = tasks;
      setQueue(tasks);
      setReviewedCount(data.reviewed);
      setLastUpdated(new Date());
    } catch {
      // Silent fail -- will retry on next poll
    } finally {
      setLoading(false);
    }
  }, [project, perspectiveFilter]);

  useEffect(() => {
    setLoading(true);
    fetchQueue();
    const id = setInterval(fetchQueue, 60_000);
    return () => clearInterval(id);
  }, [fetchQueue]);

  // Track current task ID
  useEffect(() => {
    if (queue.length > 0 && currentIndex < queue.length) {
      currentTaskIdRef.current = queue[currentIndex].id;
    } else {
      currentTaskIdRef.current = null;
    }
  }, [queue, currentIndex]);

  // Focus textarea when reply form opens
  useEffect(() => {
    if (showReplyForm && replyRef.current) {
      replyRef.current.focus();
    }
  }, [showReplyForm]);

  // Keyboard shortcuts: A=approve, R=reply, D=dismiss, J/→=next, K/←=prev, S=skip
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (!currentTask || deciding) return;

      switch (e.key.toLowerCase()) {
        case 'a': handleApprove(); break;
        case 'r': if (!showReplyForm) setShowReplyForm(true); break;
        case 'd': handleDismiss(); break;
        case 's': handleSkip(); break;
        case 'j': case 'arrowright': goToNext(); break;
        case 'k': case 'arrowleft': goToPrev(); break;
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  // ── Actions ────────────────────────────────────────────────────

  async function postDecision(decision: string, reason?: string) {
    const task = queue[currentIndex];
    if (!task || deciding) return;
    setDeciding(true);
    setError(null);

    try {
      const res = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, decision, reason }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Update session stats
      if (decision === 'approved') {
        setSessionStats(s => ({ ...s, approved: s.approved + 1 }));
      } else if (decision === 'reply') {
        setSessionStats(s => ({ ...s, replied: s.replied + 1 }));
      } else if (decision === 'dismissed') {
        setSessionStats(s => ({ ...s, dismissed: s.dismissed + 1 }));
      }

      // For reply, keep the task in queue but close the form
      if (decision === 'reply') {
        setShowReplyForm(false);
        setReplyText('');
        setShowFullText(false);
        // Move to next item
        if (currentIndex < queue.length - 1) {
          setCurrentIndex(currentIndex + 1);
        } else if (queue.length > 1) {
          setCurrentIndex(0);
        }
      } else {
        // Remove from queue and advance
        const newQueue = queue.filter((_, i) => i !== currentIndex);
        setQueue(newQueue);
        stableQueueRef.current = newQueue;
        setReviewedCount(r => r + 1);

        if (currentIndex >= newQueue.length && newQueue.length > 0) {
          setCurrentIndex(newQueue.length - 1);
        }

        setShowReplyForm(false);
        setReplyText('');
        setShowFullText(false);

        // Notify sidebar to update count
        notifyDecision();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save decision');
    } finally {
      setDeciding(false);
    }
  }

  function handleApprove() { postDecision('approved'); }
  function handleDismiss() { postDecision('dismissed'); }

  function handleReply() {
    if (!showReplyForm) {
      setShowReplyForm(true);
      return;
    }
    if (!replyText.trim()) return;
    postDecision('reply', replyText.trim());
  }

  function handleSkip() {
    setSessionStats(s => ({ ...s, skipped: s.skipped + 1 }));
    setShowReplyForm(false);
    setReplyText('');
    setShowFullText(false);
    if (currentIndex < queue.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else if (queue.length > 1) {
      setCurrentIndex(0);
    }
  }

  function goToPrev() {
    setShowReplyForm(false);
    setReplyText('');
    setShowFullText(false);
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
  }

  function goToNext() {
    setShowReplyForm(false);
    setReplyText('');
    setShowFullText(false);
    if (currentIndex < queue.length - 1) setCurrentIndex(currentIndex + 1);
  }

  // ── Derived values ─────────────────────────────────────────────

  const totalToReview = queue.length + reviewedCount;
  const progressPct = totalToReview > 0 ? (reviewedCount / totalToReview) * 100 : 0;
  const currentTask = queue.length > 0 && currentIndex < queue.length ? queue[currentIndex] : null;
  const assessment = currentTask ? extractAssessment(currentTask.output) : null;
  const condensed = assessment ? condenseAssessment(assessment) : null;
  const whyMatters = assessment ? extractWhyItMatters(assessment) : null;
  const urgency = currentTask ? urgencyLabel(currentTask.lane) : null;
  const queueEmpty = !loading && queue.length === 0;
  const sessionTotal = sessionStats.approved + sessionStats.replied + sessionStats.dismissed + sessionStats.skipped;

  // ── Render ─────────────────────────────────────────────────────

  return (
    <>
      <Header
        title={perspectiveFilter ? `Queue: ${perspectiveFilter}` : 'Review Queue'}
        project={project}
        onProjectChange={setProject}
        lastUpdated={lastUpdated}
      />

      <div className="flex flex-col min-h-[calc(100vh-3.5rem)] md:min-h-screen">
        {/* Progress bar */}
        <div className="sticky top-14 md:top-0 z-10 bg-zinc-950 border-b border-zinc-800 px-4 py-2.5">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-zinc-400">
                Reviewed {reviewedCount} of {totalToReview}
                {queue.length > 0 && (
                  <span className="text-zinc-600"> &middot; {queue.length} remaining</span>
                )}
              </span>
              {perspectiveFilter && (
                <Link href="/" className="text-xs text-emerald-400 hover:text-emerald-300">
                  Clear filter
                </Link>
              )}
            </div>
            <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Main content area */}
        <div className="flex-1 px-4 py-4 md:py-6 pb-28 md:pb-24">
          <div className="max-w-3xl mx-auto">

            {/* Error banner */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
                <p className="text-sm text-red-300">{error}</p>
                <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 text-xs ml-3">Dismiss</button>
              </div>
            )}

            {/* Loading state */}
            {loading && (
              <div className="text-center py-16">
                <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
                <p className="text-sm text-zinc-500">Loading review queue...</p>
              </div>
            )}

            {/* Empty state */}
            {queueEmpty && (
              <div className="text-center py-16">
                <div className="text-4xl mb-4">&#10003;</div>
                <h2 className="text-xl font-semibold text-zinc-100 mb-2">All caught up</h2>
                {sessionTotal > 0 ? (
                  <div className="text-sm text-zinc-400 space-y-1">
                    <p>You reviewed {sessionTotal} item{sessionTotal !== 1 ? 's' : ''} this session</p>
                    <p className="text-zinc-600">
                      {sessionStats.approved > 0 && <span className="text-green-400">{sessionStats.approved} approved</span>}
                      {sessionStats.replied > 0 && <><span className="text-zinc-600"> &middot; </span><span className="text-blue-400">{sessionStats.replied} replied</span></>}
                      {sessionStats.dismissed > 0 && <><span className="text-zinc-600"> &middot; </span><span className="text-zinc-400">{sessionStats.dismissed} dismissed</span></>}
                      {sessionStats.skipped > 0 && <><span className="text-zinc-600"> &middot; </span><span className="text-zinc-400">{sessionStats.skipped} skipped</span></>}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">No items pending review right now.</p>
                )}
                <Link
                  href="/history"
                  className="inline-block mt-6 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                >
                  View history
                </Link>
              </div>
            )}

            {/* ── Current task card ─────────────────────────────── */}
            {currentTask && (
              <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden flex flex-col">

                {/* ── Header bar: agent name (big) + severity + cost + time ── */}
                <div className="p-4 md:p-5 border-b border-zinc-800">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <span className="text-lg font-bold text-emerald-400">
                          {agentRole(currentTask.agent)}
                        </span>
                        <StatusBadge status={currentTask.lane} variant="lane" />
                        {currentTask.costUsd != null && currentTask.costUsd > 0 && (
                          <span className="text-xs font-mono text-zinc-500 bg-zinc-800/60 px-1.5 py-0.5 rounded">${currentTask.costUsd.toFixed(3)}</span>
                        )}
                        {duration(currentTask.startedAt, currentTask.completedAt) && (
                          <span className="text-xs text-zinc-600">{duration(currentTask.startedAt, currentTask.completedAt)}</span>
                        )}
                      </div>
                      <h2 className="text-sm font-medium text-zinc-200 leading-snug">
                        {briefTitle(currentTask.description)}
                      </h2>
                      {urgency && urgency.text && (
                        <p className={`text-xs font-medium mt-1 ${urgency.color}`}>
                          {urgency.text}
                        </p>
                      )}
                    </div>
                    {/* Nav arrows (desktop) */}
                    <div className="hidden md:flex items-center gap-1 shrink-0">
                      <button
                        onClick={goToPrev}
                        disabled={currentIndex === 0}
                        className="p-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Previous"
                      >
                        &#8592;
                      </button>
                      <span className="text-xs text-zinc-600 px-1">
                        {currentIndex + 1}/{queue.length}
                      </span>
                      <button
                        onClick={goToNext}
                        disabled={currentIndex === queue.length - 1}
                        className="p-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Next"
                      >
                        &#8594;
                      </button>
                    </div>
                  </div>
                </div>

                {/* ── Summary: first 2-3 sentences, always visible ────── */}
                {assessment && condensed && (
                  <div className="px-4 md:px-5 pt-4 pb-2">
                    <p className="text-sm text-zinc-300 leading-relaxed">
                      {condensed}
                    </p>
                    {whyMatters && (
                      <div className="flex gap-2 items-start mt-2">
                        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider shrink-0 pt-0.5">
                          Impact
                        </span>
                        <p className="text-sm text-zinc-400">
                          {whyMatters}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Full assessment: shown by default, collapsible ──── */}
                <div className="px-4 md:px-5 pb-4 flex-1">
                  {assessment ? (
                    <>
                      <div className={`mt-2 pt-3 border-t border-zinc-800/50 ${showFullText ? '' : 'max-h-[400px] overflow-y-auto'}`}>
                        <div
                          className="prose prose-invert prose-sm max-w-none prose-headings:text-zinc-200 prose-p:text-zinc-300 prose-strong:text-zinc-200 prose-code:text-emerald-400"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(formatFullOutput(currentTask.output)) }}
                        />
                      </div>
                      <button
                        onClick={() => setShowFullText(!showFullText)}
                        className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        {showFullText ? 'Collapse' : 'Expand full output'}
                      </button>
                    </>
                  ) : currentTask.status === 'in_progress' ? (
                    <div className="text-center py-8">
                      <div className="w-3 h-3 rounded-full bg-indigo-500 animate-pulse mx-auto mb-3" />
                      <p className="text-sm text-zinc-400">Agent is still working...</p>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-500 text-center py-8">No output yet.</p>
                  )}
                </div>

                {/* ── Action bar footer: Approve | Reply | Dismiss + metadata ── */}
                <div className="border-t border-zinc-800 px-4 md:px-5 py-2.5 flex flex-wrap items-center gap-3 text-xs text-zinc-600">
                  {formatTimestamp(currentTask.completedAt ?? currentTask.createdAt) && (
                    <span>{formatTimestamp(currentTask.completedAt ?? currentTask.createdAt)}</span>
                  )}
                  <button
                    onClick={() => setShowRaw(!showRaw)}
                    className="text-zinc-600 hover:text-zinc-400 transition-colors"
                  >
                    {showRaw ? 'Hide raw' : 'Raw'}
                  </button>
                  <Link
                    href={`/tasks/${currentTask.id}`}
                    className="text-zinc-600 hover:text-emerald-400 transition-colors ml-auto"
                  >
                    Detail &#8594;
                  </Link>
                </div>

                {/* Raw JSON (hidden by default) */}
                {showRaw && (
                  <div className="px-4 md:px-5 pb-4">
                    <pre className="text-xs text-zinc-500 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-64 font-mono">
                      {typeof currentTask.output === 'string'
                        ? currentTask.output
                        : JSON.stringify(currentTask.output, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Reply form */}
                {showReplyForm && (
                  <div className="px-4 md:px-5 pb-4">
                    <textarea
                      ref={replyRef}
                      value={replyText}
                      onChange={e => setReplyText(e.target.value)}
                      placeholder="Type your reply or question here..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500 resize-none"
                      rows={3}
                    />
                    <div className="flex items-center justify-between mt-2">
                      <button
                        onClick={() => { setShowReplyForm(false); setReplyText(''); }}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
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
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 min-h-[44px]"
                      >
                        {deciding ? 'Sending...' : 'Send reply'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Peek at next items */}
            {currentTask && queue.length > 1 && (
              <div className="mt-4 space-y-1.5">
                <p className="text-xs text-zinc-600 uppercase tracking-wider mb-2">Up next</p>
                {queue
                  .filter((_, i) => i !== currentIndex)
                  .slice(0, 3)
                  .map((task) => (
                    <button
                      key={task.id}
                      onClick={() => {
                        const realIndex = queue.findIndex(t => t.id === task.id);
                        if (realIndex >= 0) {
                          setCurrentIndex(realIndex);
                          setShowReplyForm(false);
                          setReplyText('');
                          setShowFullText(false);
                        }
                      }}
                      className="w-full flex items-center gap-3 p-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50 hover:bg-zinc-800/50 hover:border-zinc-700 transition-colors text-left"
                    >
                      <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider w-16 shrink-0">
                        {agentRole(task.agent)}
                      </span>
                      <span className="text-sm text-zinc-400 flex-1 min-w-0 truncate">
                        {briefTitle(task.description)}
                      </span>
                      <StatusBadge status={task.lane} variant="lane" />
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Fixed action bar */}
        {currentTask && !showReplyForm && (
          <div className="fixed bottom-0 left-0 right-0 md:left-56 z-40 bg-zinc-950 border-t border-zinc-800">
            <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
              {/* Mobile nav */}
              <div className="flex items-center gap-1 md:hidden">
                <button
                  onClick={goToPrev}
                  disabled={currentIndex === 0}
                  className="p-2 rounded-lg text-xs text-zinc-500 bg-zinc-800 disabled:opacity-30"
                  aria-label="Previous"
                >
                  &#8592;
                </button>
                <span className="text-[10px] text-zinc-600 px-0.5">
                  {currentIndex + 1}/{queue.length}
                </span>
                <button
                  onClick={goToNext}
                  disabled={currentIndex === queue.length - 1}
                  className="p-2 rounded-lg text-xs text-zinc-500 bg-zinc-800 disabled:opacity-30"
                  aria-label="Next"
                >
                  &#8594;
                </button>
              </div>

              <div className="flex-1 flex items-center justify-end gap-2">
                <button
                  onClick={handleSkip}
                  className="px-3 py-2.5 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors min-h-[44px]"
                  title="Skip (S)"
                >
                  Skip
                  <kbd className="hidden md:inline ml-1.5 text-[10px] text-zinc-600 font-mono">S</kbd>
                </button>
                <button
                  onClick={handleDismiss}
                  disabled={deciding}
                  className="px-3 py-2.5 rounded-lg text-sm font-medium bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors disabled:opacity-50 min-h-[44px]"
                  title="Dismiss (D)"
                >
                  Dismiss
                  <kbd className="hidden md:inline ml-1.5 text-[10px] text-zinc-600 font-mono">D</kbd>
                </button>
                <button
                  onClick={handleReply}
                  disabled={deciding}
                  className="px-3 py-2.5 rounded-lg text-sm font-medium bg-blue-600/15 text-blue-400 border border-blue-600/30 hover:bg-blue-600/25 transition-colors disabled:opacity-50 min-h-[44px]"
                  title="Reply (R)"
                >
                  Reply
                  <kbd className="hidden md:inline ml-1.5 text-[10px] text-blue-600 font-mono">R</kbd>
                </button>
                <button
                  onClick={handleApprove}
                  disabled={deciding}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 min-h-[44px]"
                  title="Approve (A)"
                >
                  {deciding ? '...' : 'Approve'}
                  {!deciding && <kbd className="hidden md:inline ml-1.5 text-[10px] text-emerald-300 font-mono">A</kbd>}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
