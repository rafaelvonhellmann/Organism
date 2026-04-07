'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';
import Link from 'next/link';

// ── Types ──────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  agent: string;
  status: string;
  lane: string;
  description: string;
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

const PLANS: PerspectivePlan[] = [
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

const COLUMNS = [
  { key: 'thisWeek' as const, label: 'This Week', color: 'border-emerald-500', bg: 'bg-emerald-500/5', dot: 'bg-emerald-500' },
  { key: 'fifteenDays' as const, label: '15 Days', color: 'border-blue-500', bg: 'bg-blue-500/5', dot: 'bg-blue-500' },
  { key: 'oneMonth' as const, label: '1 Month', color: 'border-indigo-500', bg: 'bg-indigo-500/5', dot: 'bg-indigo-500' },
  { key: 'threeMonths' as const, label: '3 Months', color: 'border-amber-500', bg: 'bg-amber-500/5', dot: 'bg-amber-500' },
  { key: 'sixMonths' as const, label: '6 Months', color: 'border-zinc-500', bg: 'bg-zinc-500/5', dot: 'bg-zinc-500' },
];

type ColKey = typeof COLUMNS[number]['key'];

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ── Component ──────────────────────────────────────────────────

export default function PlanPage() {
  const [project, setProject] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: tasksData, lastUpdated } = usePolling<{ tasks: TaskRow[] }>('/api/tasks?limit=200');

  const tasks = tasksData?.tasks ?? [];
  const needsDecision = tasks.filter(t => t.status === 'awaiting_review').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress' || t.status === 'pending').length;

  return (
    <>
      <Header title="Plan" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">

        {/* Active work counters */}
        {(needsDecision > 0 || inProgress > 0) && (
          <div className="flex items-center gap-3 mb-4 max-w-full">
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

        {/* Kanban board */}
        <div className="overflow-x-auto">
          <div className="flex gap-3 min-w-[1200px] pb-4">
            {COLUMNS.map(col => (
              <div key={col.key} className="flex-1 min-w-[220px]">
                {/* Column header */}
                <div className={`border-t-2 ${col.color} rounded-t-lg px-3 py-2 mb-2 ${col.bg}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${col.dot}`} />
                    <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{col.label}</h3>
                  </div>
                </div>

                {/* Cards */}
                <div className="space-y-2">
                  {PLANS.map(plan => {
                    const text = plan[col.key];
                    const isExpanded = expanded === `${plan.role}-${col.key}`;
                    const recentTask = tasks
                      .filter(t => t.agent === plan.role)
                      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))[0];

                    return (
                      <button
                        key={plan.role}
                        onClick={() => setExpanded(isExpanded ? null : `${plan.role}-${col.key}`)}
                        className={`w-full text-left bg-zinc-900 border border-zinc-800 rounded-lg p-3 hover:border-zinc-700 transition-colors ${isExpanded ? 'ring-1 ring-emerald-500/30' : ''}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{plan.name}</span>
                          {recentTask && col.key === 'thisWeek' && (
                            <span className={`w-1.5 h-1.5 rounded-full ${
                              recentTask.status === 'completed' ? 'bg-green-500' :
                              recentTask.status === 'awaiting_review' ? 'bg-red-500' :
                              recentTask.status === 'in_progress' ? 'bg-amber-500 animate-pulse' : 'bg-zinc-600'
                            }`} />
                          )}
                        </div>
                        <p className={`text-xs text-zinc-400 leading-relaxed ${isExpanded ? '' : 'line-clamp-2'}`}>
                          {text}
                        </p>
                        {isExpanded && recentTask && (
                          <div className="mt-2 pt-2 border-t border-zinc-800/50 text-[10px] text-zinc-600">
                            Latest: {recentTask.description.replace(/^\[SHAPING\]\s*/i, '').slice(0, 50)} ({timeAgo(recentTask.completedAt ?? recentTask.createdAt)})
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
