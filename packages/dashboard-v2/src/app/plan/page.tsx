'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';
import { getInitialSelectedProject } from '@/lib/selected-project';
import Link from 'next/link';

// ── Types ──────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
  output?: unknown;
  input?: Record<string, unknown> | null;
  workflowKind?: string | null;
  costUsd: number | null;
  createdAt: number;
  completedAt: number | null;
}

// ── Perspective plans ─────────────────────────────────────────

interface PerspectivePlan {
  name: string;
  role: string;
  thisWeek: string;
  fifteenDays: string;
  oneMonth: string;
  threeMonths: string;
  sixMonths: string;
}

const SYNAPSE_PLANS: PerspectivePlan[] = [
  {
    name: 'Strategy',
    role: 'ceo',
    thisWeek: 'Validate ANZCA beachhead PMF. Approve enrichment spend ($465).',
    fifteenDays: 'Confirm pricing (AUD $49 or $59). Set 30-day launch OKRs.',
    oneMonth: 'Beta launch with 10 trainees. Measure NPS + retention.',
    threeMonths: '30 paying subscribers (breakeven). Open CICM beachhead.',
    sixMonths: '80+ subscribers. ACEM expansion. Series seed if needed.',
  },
  {
    name: 'Product',
    role: 'product-manager',
    thisWeek: 'RICE-score remaining backlog. Define activation metric.',
    fifteenDays: 'Ship onboarding flow. Freemium vs paywall decision.',
    oneMonth: 'Stripe integration live. First paying users.',
    threeMonths: 'Usage analytics dashboard. CICM question bank scoped.',
    sixMonths: 'Multi-college platform. Adaptive learning v1.',
  },
  {
    name: 'Engineering',
    role: 'engineering',
    thisWeek: 'Complete SAQ citation enrichment ($85). Fix auth flow.',
    fifteenDays: 'VIVA model_answer enrichment ($380). Landing page.',
    oneMonth: 'Stripe paywall. Performance optimization.',
    threeMonths: 'CICM schema + question import. API cost optimization.',
    sixMonths: 'Adaptive difficulty engine. Mobile app (if warranted).',
  },
  {
    name: 'Technology',
    role: 'cto',
    thisWeek: 'Architecture review: enrichment pipeline stability.',
    fifteenDays: 'Evaluate caching strategy for API cost reduction.',
    oneMonth: 'Load testing for 30+ concurrent users.',
    threeMonths: 'Multi-tenant architecture for CICM. CDN + edge.',
    sixMonths: 'Platform scaling plan. Evaluate AI model alternatives.',
  },
  {
    name: 'Finance',
    role: 'cfo',
    thisWeek: 'Track enrichment spend vs budget ($465 cap).',
    fifteenDays: 'Unit economics model: CAC, LTV, payback period.',
    oneMonth: 'Revenue tracking live. Monthly burn report.',
    threeMonths: 'Breakeven validation. CICM investment case.',
    sixMonths: 'Annual financial model. Funding requirements analysis.',
  },
  {
    name: 'Marketing',
    role: 'marketing-strategist',
    thisWeek: 'Draft founder post for ANZCA trainee Facebook groups.',
    fifteenDays: 'SEO: target "ANZCA primary exam questions" keywords.',
    oneMonth: 'YouTube demo video. 5 beta testimonials.',
    threeMonths: 'Content calendar live. Community building in trainee networks.',
    sixMonths: 'Conference presence (ANZCA ASM). Referral program.',
  },
  {
    name: 'Security',
    role: 'security-audit',
    thisWeek: 'Verify auth bypass is OFF. Check RLS policies.',
    fifteenDays: 'Penetration test pre-launch checklist.',
    oneMonth: 'Compliance review for medical data handling.',
    threeMonths: 'OWASP top 10 full audit. SOC 2 readiness check.',
    sixMonths: 'Privacy impact assessment for multi-college data.',
  },
  {
    name: 'Legal',
    role: 'legal',
    thisWeek: 'Review TOS draft. Copyright audit status.',
    fifteenDays: 'Privacy policy for Australian medical data.',
    oneMonth: 'Subscription terms finalized. Refund policy.',
    threeMonths: 'AHPRA compliance check. Cross-college licensing.',
    sixMonths: 'International expansion legal requirements.',
  },
  {
    name: 'Medical Content',
    role: 'medical-content-reviewer',
    thisWeek: 'Audit enrichment quality: SAQ citation accuracy.',
    fifteenDays: 'VIVA model_answer quality validation.',
    oneMonth: 'Content accuracy report for beta users.',
    threeMonths: 'CICM curriculum mapping. Gap analysis.',
    sixMonths: 'ACEM question bank scoping. Expert review panel.',
  },
  {
    name: 'Data',
    role: 'data-analyst',
    thisWeek: 'Define pre-launch KPIs. Instrument signup funnel.',
    fifteenDays: 'Analytics dashboard: session patterns, completion rates.',
    oneMonth: 'Cohort analysis: 7-day retention, study patterns.',
    threeMonths: 'API cost per user tracking. Engagement scoring.',
    sixMonths: 'Predictive analytics: pass rate correlation.',
  },
];

function buildGenericPlans(projectLabel: string): PerspectivePlan[] {
  return [
    {
      name: 'Strategy',
      role: 'ceo',
      thisWeek: `Stabilize the first safe autonomous run for ${projectLabel}.`,
      fifteenDays: 'Move from observation into constrained implementation with clear success criteria.',
      oneMonth: 'Prove the controller can deliver routine work with minimal operator intervention.',
      threeMonths: 'Turn repeated healthy runs into a reusable autonomy pattern.',
      sixMonths: 'Treat this project as a mature reference deployment for Organism.',
    },
    {
      name: 'Engineering',
      role: 'engineering',
      thisWeek: 'Focus on small, auditable, PR-oriented work with clean verification.',
      fifteenDays: 'Reduce operator rescue work by improving execution and recovery loops.',
      oneMonth: 'Make common repo operations predictable and policy-driven.',
      threeMonths: 'Reach stable repo-native autonomy for routine coding work.',
      sixMonths: 'Have boringly reliable execution that no longer feels experimental.',
    },
    {
      name: 'Quality',
      role: 'quality-agent',
      thisWeek: 'Confirm tasks route correctly and produce actionable findings.',
      fifteenDays: 'Tune the review path using real run evidence.',
      oneMonth: 'Reduce false alarms and noisy follow-ups.',
      threeMonths: 'Turn validation history into stronger rollout confidence.',
      sixMonths: 'Keep the project inside a healthy autonomy envelope by default.',
    },
  ];
}

function taskTimestamp(task: TaskRow): number {
  return task.completedAt ?? task.createdAt;
}

function summarizeText(text: string, maxLength = 180): string {
  const cleaned = text
    .replace(/[_*`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function extractTaskSummary(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === 'string') {
    return summarizeText(output);
  }

  if (typeof output !== 'object') return null;

  const record = output as Record<string, unknown>;
  for (const key of ['summary', 'review', 'text', 'verdict', 'recommendation', 'result']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return summarizeText(value);
    }
  }

  const findings = Array.isArray(record.findings) ? record.findings : [];
  const findingSummaries = findings
    .map((finding) => {
      if (!finding || typeof finding !== 'object') return null;
      const entry = finding as Record<string, unknown>;
      const summary = entry.summary ?? entry.description ?? entry.remediation;
      return typeof summary === 'string' ? summary.trim() : null;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);

  if (findingSummaries.length > 0) {
    return summarizeText(findingSummaries.join(' '));
  }

  return summarizeText(JSON.stringify(record));
}

function isCanaryTask(task: TaskRow): boolean {
  return /canary review/i.test(task.description) || task.input?.canaryPreset === true;
}

function buildTokensPlans(tasks: TaskRow[]): PerspectivePlan[] {
  const completedCanary = tasks
    .filter((task) => task.status === 'completed' && isCanaryTask(task))
    .sort((a, b) => taskTimestamp(b) - taskTimestamp(a))[0] ?? null;
  const latestReviewTask = tasks
    .filter((task) =>
      task.status === 'completed' &&
      (
        task.workflowKind === 'review' ||
        isCanaryTask(task) ||
        task.agent === 'quality-agent' ||
        task.agent === 'codex-review'
      ))
    .sort((a, b) => taskTimestamp(b) - taskTimestamp(a))[0] ?? null;
  const latestReviewSummary = latestReviewTask ? extractTaskSummary(latestReviewTask.output) : null;
  const activeFollowups = tasks.filter((task) =>
    ['pending', 'in_progress', 'awaiting_review'].includes(task.status) &&
    ['implement', 'validate', 'plan'].includes(task.workflowKind ?? ''),
  );
  const completedFollowups = tasks.filter((task) =>
    task.status === 'completed' &&
    ['implement', 'validate', 'plan'].includes(task.workflowKind ?? ''),
  );

  return [
    {
      name: 'Strategy',
      role: 'ceo',
      thisWeek: completedCanary
        ? 'The canary review is done. The next move is to convert validated findings into bounded low and medium risk work, not to keep rerunning the same review.'
        : 'Run the first safe canary review and confirm Organism can inspect Tokens for Good without widening risk.',
      fifteenDays: 'Move from review-only into constrained implementation with PR-only output and no deploy.',
      oneMonth: 'Graduate the project from first-canary mode if healthy-run evidence is building.',
      threeMonths: 'Let Tokens for Good become the first stable external proof that Organism can operate on a real repo.',
      sixMonths: 'Use the project as the template for onboarding additional mission-aligned products.',
    },
    {
      name: 'Product',
      role: 'product-manager',
      thisWeek: completedCanary
        ? 'Pick the smallest user-visible improvement that came out of the canary findings and turn it into one bounded PR-sized mission.'
        : 'Clarify the smallest user-visible improvement worth shipping after the canary review.',
      fifteenDays: 'Sequence a few low-blast-radius product improvements into PR-sized missions.',
      oneMonth: 'Use real run history to separate platform bugs from genuine product backlog.',
      threeMonths: 'Turn project memory into a clearer long-horizon roadmap powered by completed agent work.',
      sixMonths: 'Make the project a polished showcase of autonomous product iteration under policy.',
    },
    {
      name: 'Engineering',
      role: 'engineering',
      thisWeek: activeFollowups.length > 0
        ? `Autonomous follow-up is live: ${activeFollowups.length} bounded engineering or validation task${activeFollowups.length === 1 ? '' : 's'} are currently active or awaiting review.`
        : completedFollowups.length > 0
          ? `The first bounded follow-up pass completed ${completedFollowups.length} engineering or validation task${completedFollowups.length === 1 ? '' : 's'}. The next step is to choose the next approved low/medium task automatically.`
          : 'Keep worktree isolation, verification, commit, and PR handoff clean on the first review and first implementation task.',
      fifteenDays: 'Land one or two small PRs with clean controller-owned execution and zero recursive noise.',
      oneMonth: 'Automate repeated repo-safe changes with less operator involvement.',
      threeMonths: 'Treat Tokens for Good as a stable proving ground for cross-executor engineering autonomy.',
      sixMonths: 'Reach boring reliability where routine engineering changes feel normal rather than experimental.',
    },
    {
      name: 'Operations',
      role: 'devops',
      thisWeek: completedCanary
        ? 'Keep deploy locked behind the healthy-run gate while the canary findings feed PR-oriented execution. The controller should prove boring reliability before deployment widens.'
        : 'Keep deploy locked behind the healthy-run gate and make sure PR-oriented flow is stable first.',
      fifteenDays: 'Validate deploy readiness and environment expectations without widening autonomy too early.',
      oneMonth: 'Open deploys only after stable PR output and recovery behavior are repeatedly confirmed.',
      threeMonths: 'Promote deployment from guarded to routine for this project if the rollout gate is genuinely earned.',
      sixMonths: 'Use the project as the template for safe deploy governance across future client repos.',
    },
    {
      name: 'Quality',
      role: 'quality-agent',
      thisWeek: latestReviewSummary
        ? `Latest canary outcome: ${latestReviewSummary}`
        : 'Verify that review tasks stay review tasks and do not collapse into shaping or recursive follow-ups.',
      fifteenDays: 'Build confidence that the first few runs produce usable findings rather than orchestration churn.',
      oneMonth: 'Use run history to tune guardrails and remove false positives from the review path.',
      threeMonths: 'Make quality review feel like a reliable control plane signal instead of a fragile checkpoint.',
      sixMonths: 'Treat quality artifacts as first-class evidence for graduation into broader autonomy.',
    },
    {
      name: 'Security',
      role: 'security-audit',
      thisWeek: 'Keep credentials scoped, review launch posture, and make sure the project stays inside its declared policy envelope.',
      fifteenDays: 'Validate that PR-only flow, isolated worktrees, and sensitive-action gating are holding under real use.',
      oneMonth: 'Use Tokens for Good to prove the controller can stay least-privilege without becoming brittle.',
      threeMonths: 'Codify the project’s secure operating pattern into reusable defaults for the rest of Organism.',
      sixMonths: 'Make security review mostly about exceptions, not about cleaning up runtime drift.',
    },
  ];
}

function plansForProject(projectId: string, tasks: TaskRow[]): PerspectivePlan[] {
  if (projectId === 'synapse') return SYNAPSE_PLANS;
  if (projectId === 'tokens-for-good') return buildTokensPlans(tasks);
  if (projectId === 'organism') return buildGenericPlans('Organism');
  return buildGenericPlans(projectId.replace(/-/g, ' '));
}

const TIME_PERIODS = [
  { key: 'thisWeek' as const, label: 'This Week', color: 'emerald' },
  { key: 'fifteenDays' as const, label: '15 Days', color: 'blue' },
  { key: 'oneMonth' as const, label: '1 Month', color: 'indigo' },
  { key: 'threeMonths' as const, label: '3 Months', color: 'amber' },
  { key: 'sixMonths' as const, label: '6 Months', color: 'zinc' },
] as const;

type PeriodKey = typeof TIME_PERIODS[number]['key'];

const COLOR_MAP: Record<string, { border: string; bg: string; dot: string; tab: string; tabActive: string }> = {
  emerald: { border: 'border-emerald-500', bg: 'bg-emerald-500/10', dot: 'bg-emerald-500', tab: 'text-emerald-500/60 hover:text-emerald-400', tabActive: 'text-emerald-400 border-emerald-500' },
  blue:    { border: 'border-blue-500',    bg: 'bg-blue-500/10',    dot: 'bg-blue-500',    tab: 'text-blue-500/60 hover:text-blue-400',    tabActive: 'text-blue-400 border-blue-500' },
  indigo:  { border: 'border-indigo-500',  bg: 'bg-indigo-500/10',  dot: 'bg-indigo-500',  tab: 'text-indigo-500/60 hover:text-indigo-400',  tabActive: 'text-indigo-400 border-indigo-500' },
  amber:   { border: 'border-amber-500',   bg: 'bg-amber-500/10',   dot: 'bg-amber-500',   tab: 'text-amber-500/60 hover:text-amber-400',   tabActive: 'text-amber-400 border-amber-500' },
  zinc:    { border: 'border-zinc-500',    bg: 'bg-zinc-500/10',    dot: 'bg-zinc-500',    tab: 'text-zinc-500/60 hover:text-zinc-400',    tabActive: 'text-zinc-400 border-zinc-500' },
};

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function statusDot(status: string): string {
  if (status === 'completed') return 'bg-green-500';
  if (status === 'awaiting_review') return 'bg-red-500';
  if (status === 'in_progress') return 'bg-amber-500 animate-pulse';
  return 'bg-zinc-600';
}

const RECENT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// ── Component ──────────────────────────────────────────────────

export default function PlanPage() {
  const [project, setProject] = useState(() => getInitialSelectedProject());
  const [activePeriod, setActivePeriod] = useState<PeriodKey>('thisWeek');
  const taskUrl = project ? `/api/tasks?limit=200&include=summary&project=${project}` : '/api/tasks?limit=200&include=summary';
  const reviewQueueUrl = project ? `/api/review-queue?project=${project}` : '/api/review-queue';
  const { data: tasksData, lastUpdated } = usePolling<{ tasks: TaskRow[] }>(taskUrl);
  const { data: reviewQueueData } = usePolling<{ pending: number }>(reviewQueueUrl);

  const tasks = tasksData?.tasks ?? [];
  const needsDecision = reviewQueueData?.pending ?? 0;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const plans = plansForProject(project || 'organism', tasks);
  const latestReviewTask = tasks
    .filter((task) =>
      task.status === 'completed' &&
      (
        task.workflowKind === 'review' ||
        isCanaryTask(task) ||
        task.agent === 'quality-agent' ||
        task.agent === 'codex-review'
      ))
    .sort((a, b) => taskTimestamp(b) - taskTimestamp(a))[0] ?? null;
  const latestReviewSummary = latestReviewTask ? extractTaskSummary(latestReviewTask.output) : null;
  const hasCompletedCanary = tasks.some((task) => task.status === 'completed' && isCanaryTask(task));
  const activeAutonomousFollowups = tasks.filter((task) =>
    ['pending', 'in_progress', 'awaiting_review'].includes(task.status) &&
    ['implement', 'validate', 'plan'].includes(task.workflowKind ?? ''),
  ).length;

  const activeColor = TIME_PERIODS.find(p => p.key === activePeriod)!.color;
  const colors = COLOR_MAP[activeColor];

  return (
    <>
      <Header title="Plan" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">

        {/* Active work counters */}
        {(needsDecision > 0 || inProgress > 0) && (
          <div className="flex items-center gap-3 mb-4">
            {needsDecision > 0 && (
              <Link href="/" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 hover:border-red-500/40 transition-colors">
                <span className="text-sm font-bold text-red-400">{needsDecision}</span>
                <span className="text-xs text-red-400/70">awaiting decision</span>
              </Link>
            )}
            {inProgress > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <span className="text-sm font-bold text-amber-400">{inProgress}</span>
                <span className="text-xs text-amber-400/70">in progress</span>
              </div>
            )}
          </div>
        )}

        {project === 'tokens-for-good' && (
          <div className="mb-6 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 md:p-5">
            <div className="flex flex-wrap items-center gap-3 justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${hasCompletedCanary ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
                <h2 className="text-sm font-semibold text-zinc-100">Latest canary outcome</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span>{hasCompletedCanary ? 'Canary review completed' : 'Canary review still pending'}</span>
                <span>•</span>
                <span>{activeAutonomousFollowups} bounded follow-up task{activeAutonomousFollowups === 1 ? '' : 's'} active</span>
              </div>
            </div>
            <p className="text-sm text-zinc-300 leading-relaxed">
              {latestReviewSummary ?? 'No review artifact has been surfaced yet. Once the canary completes, this card will show the latest captured summary directly from the review pipeline.'}
            </p>
            <p className="mt-3 text-xs text-zinc-500">
              No extra formal review should be required just to understand the canary. This panel reflects the latest review artifact the dashboard has captured for Tokens for Good.
            </p>
          </div>
        )}

        {/* Time period tab bar */}
        <div className="flex items-center gap-1 border-b border-zinc-800 mb-6">
          {TIME_PERIODS.map(period => {
            const isActive = activePeriod === period.key;
            const c = COLOR_MAP[period.color];
            return (
              <button
                key={period.key}
                onClick={() => setActivePeriod(period.key)}
                className={`
                  px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px
                  ${isActive ? c.tabActive : `border-transparent ${c.tab}`}
                `}
              >
                {period.label}
              </button>
            );
          })}
        </div>

        {/* Perspective cards for selected period */}
        <div className="grid gap-3 md:grid-cols-2">
          {plans.map(plan => {
            const text = plan[activePeriod];
            const agentTasks = tasks
              .filter(t => t.agent === plan.role && t.createdAt >= Date.now() - RECENT_ACTIVITY_WINDOW_MS)
              .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
            const recentTask = agentTasks[0];
            const completedCount = agentTasks.filter(t => t.status === 'completed').length;
            const totalCost = agentTasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);

            return (
              <div
                key={plan.role}
                className={`${colors.bg} border ${colors.border}/20 rounded-lg p-4 hover:${colors.border}/40 transition-colors`}
              >
                {/* Header row */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                    <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{plan.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {recentTask && (
                      <span className={`w-1.5 h-1.5 rounded-full ${statusDot(recentTask.status)}`} />
                    )}
                    {completedCount > 0 && (
                      <span className="text-[10px] text-zinc-600">{completedCount} done</span>
                    )}
                    {totalCost > 0 && (
                      <span className="text-[10px] text-zinc-600">${totalCost.toFixed(2)}</span>
                    )}
                  </div>
                </div>

                {/* Plan text — fully visible */}
                <p className="text-sm text-zinc-300 leading-relaxed">
                  {text}
                </p>

                {/* Recent task activity */}
                {recentTask && (
                  <div className="mt-3 pt-3 border-t border-zinc-800/50 text-xs text-zinc-500">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${statusDot(recentTask.status)}`} />
                    {recentTask.description.replace(/^\[SHAPING\]\s*/i, '').slice(0, 100)}
                    <span className="text-zinc-600 ml-1">({timeAgo(recentTask.completedAt ?? recentTask.createdAt)})</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
