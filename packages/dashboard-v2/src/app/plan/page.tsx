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

// ── Perspective plans per time horizon ─────────────────────────

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
    name: 'CEO / Strategy',
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
    name: 'Data & Analytics',
    role: 'data-analyst',
    thisWeek: 'Define pre-launch KPIs. Instrument signup funnel.',
    fifteenDays: 'Analytics dashboard: session patterns, completion rates.',
    oneMonth: 'Cohort analysis: 7-day retention, study patterns.',
    threeMonths: 'API cost per user tracking. Engagement scoring.',
    sixMonths: 'Predictive analytics: pass rate correlation.',
  },
];

const HORIZONS = [
  { key: 'thisWeek' as const, label: 'This Week', accent: 'emerald' },
  { key: 'fifteenDays' as const, label: '15 Days', accent: 'blue' },
  { key: 'oneMonth' as const, label: '1 Month', accent: 'indigo' },
  { key: 'threeMonths' as const, label: '3 Months', accent: 'amber' },
  { key: 'sixMonths' as const, label: '6 Months', accent: 'zinc' },
];

type HorizonKey = typeof HORIZONS[number]['key'];

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Component ──────────────────────────────────────────────────

export default function PlanPage() {
  const [project, setProject] = useState('');
  const [horizon, setHorizon] = useState<HorizonKey>('thisWeek');
  const { data: tasksData, lastUpdated } = usePolling<{ tasks: TaskRow[] }>('/api/tasks?limit=200');

  const tasks = tasksData?.tasks ?? [];
  const needsDecision = tasks.filter(t => t.status === 'awaiting_review').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress' || t.status === 'pending').length;

  return (
    <>
      <Header title="Plan" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        <div className="max-w-4xl mx-auto space-y-6">

          {/* Horizon tabs */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-xl p-1">
            {HORIZONS.map(h => (
              <button
                key={h.key}
                onClick={() => setHorizon(h.key)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  horizon === h.key
                    ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {h.label}
              </button>
            ))}
          </div>

          {/* Active work counters */}
          {(needsDecision > 0 || inProgress > 0) && (
            <div className="grid grid-cols-2 gap-3">
              {needsDecision > 0 && (
                <Link href="/" className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 hover:border-red-500/40 transition-colors">
                  <span className="text-2xl font-bold text-red-400">{needsDecision}</span>
                  <p className="text-xs text-red-400/70 mt-1">awaiting your decision</p>
                </Link>
              )}
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                <span className="text-2xl font-bold text-amber-400">{inProgress}</span>
                <p className="text-xs text-amber-400/70 mt-1">tasks in progress</p>
              </div>
            </div>
          )}

          {/* Perspective plan cards */}
          <div className="space-y-3">
            {PLANS.map(plan => {
              const planText = plan[horizon];
              const accentColor = HORIZONS.find(h => h.key === horizon)?.accent ?? 'zinc';
              const recentTasks = tasks
                .filter(t => t.agent === plan.role)
                .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
                .slice(0, 2);

              return (
                <div key={plan.role} className={`bg-zinc-900 border-l-2 border-${accentColor}-500/40 border border-zinc-800 rounded-xl p-4`}>
                  <h4 className="text-sm font-semibold text-zinc-200 mb-1.5">{plan.name}</h4>
                  <p className="text-sm text-zinc-300 leading-relaxed">{planText}</p>

                  {recentTasks.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-zinc-800/50">
                      <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Recent</p>
                      {recentTasks.map(t => (
                        <div key={t.id} className="flex items-center gap-2 text-xs text-zinc-500 mb-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            t.status === 'completed' ? 'bg-green-500' :
                            t.status === 'awaiting_review' ? 'bg-red-500' :
                            t.status === 'in_progress' ? 'bg-amber-500' : 'bg-zinc-600'
                          }`} />
                          <span className="flex-1 truncate">{t.description.replace(/^\[SHAPING\]\s*/i, '').slice(0, 60)}</span>
                          <span className="shrink-0">{timeAgo(t.completedAt ?? t.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
