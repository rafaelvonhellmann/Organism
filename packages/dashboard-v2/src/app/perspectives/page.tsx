'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';

// ── Types ──────────────────────────────────────────────────────

interface Perspective {
  id: string;
  domain: string;
  systemPrompt: string;
  relevanceKeywords: string[];
  projectFitness: Record<string, number>;
  status: string;
  model: string;
  totalInvocations: number;
  totalCostUsd: number;
  avgRating: number;
  lastUsed: number;
  fitnessForProject?: number | null;
}

interface QueueResponse {
  tasks: Array<{ id: string; agent: string; description: string }>;
  total: number;
  reviewed: number;
}

interface TaskRow {
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

// ── Agent-to-perspective mapping ───────────────────────────────

const DOMAIN_AGENTS: Record<string, string[]> = {
  'Strategy': ['ceo', 'cfo'],
  'Technology': ['cto', 'engineering', 'devops'],
  'Product': ['product-manager', 'design', 'data-analyst'],
  'Security': ['security-audit'],
  'Quality': ['quality-guardian'],
  'Marketing': ['marketing-strategist', 'marketing-executor', 'seo', 'community-manager', 'pr-comms'],
  'Legal': ['legal'],
  'Sales': ['sales', 'customer-success'],
  'People': ['hr'],
  'Research': ['medical-content-reviewer'],
};

// ── Helpers ────────────────────────────────────────────────────

function fitnessColor(score: number | null | undefined): string {
  if (score == null) return 'text-zinc-600';
  if (score > 0.7) return 'text-green-400';
  if (score >= 0.4) return 'text-amber-400';
  return 'text-red-400';
}

function statusDot(status: string): string {
  if (status === 'active') return 'bg-green-500';
  if (status === 'shadow' || status === 'dormant') return 'bg-amber-500';
  return 'bg-zinc-600';
}

// ── Component ──────────────────────────────────────────────────

export default function PerspectivesPage() {
  const [project, setProject] = useState('');

  const { data: perspectives, lastUpdated } = usePolling<Perspective[]>(
    project ? `/api/perspectives?project=${project}` : '/api/perspectives',
  );

  const { data: queueData } = usePolling<QueueResponse>(
    project ? `/api/review-queue?project=${project}` : '/api/review-queue',
  );

  const { data: tasksData } = usePolling<{ tasks: TaskRow[]; total: number }>(
    project ? `/api/tasks?project=${project}&status=completed&limit=500` : '/api/tasks?status=completed&limit=500',
  );

  const queueTasks = queueData?.tasks ?? [];
  const completedTasks = tasksData?.tasks ?? [];
  const perspList = perspectives ?? [];

  // Build domain cards from perspectives + task data
  const domainCards = perspList.map(p => {
    const fitness = p.fitnessForProject ?? (
      Object.values(p.projectFitness).length > 0
        ? Object.values(p.projectFitness).reduce((a, b) => a + b, 0) / Object.values(p.projectFitness).length
        : null
    );

    // Find matching agents for this perspective
    const domainEntry = Object.entries(DOMAIN_AGENTS).find(([, agents]) =>
      agents.some(a => p.id.includes(a) || a.includes(p.id))
    );
    const domainAgents = domainEntry ? domainEntry[1] : [p.id];

    // Count tasks needing review (in queue, matching agents)
    const needingReview = queueTasks.filter(t =>
      domainAgents.includes(t.agent) ||
      t.description.toLowerCase().includes(p.domain.toLowerCase())
    ).length;

    // Count completed tasks
    const completed = completedTasks.filter(t =>
      domainAgents.includes(t.agent) ||
      t.description.toLowerCase().includes(p.domain.toLowerCase())
    ).length;

    return {
      id: p.id,
      domain: p.domain,
      status: p.status,
      fitness,
      needingReview,
      completed,
    };
  });

  // Sort: items needing review first, then by fitness
  domainCards.sort((a, b) => {
    if (b.needingReview !== a.needingReview) return b.needingReview - a.needingReview;
    const af = a.fitness ?? -1;
    const bf = b.fitness ?? -1;
    return bf - af;
  });

  return (
    <>
      <Header title="Perspectives" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-4 md:p-6">
        <div className="max-w-3xl mx-auto">
          {/* Grid of perspective cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
            {domainCards.map(card => (
              <Link
                key={card.id}
                href={`/?perspective=${encodeURIComponent(card.id)}`}
                className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 md:p-6 hover:border-zinc-700 hover:bg-zinc-800/50 transition-colors group relative"
              >
                {/* Review count badge */}
                {card.needingReview > 0 && (
                  <span className="absolute top-3 right-3 bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                    {card.needingReview}
                  </span>
                )}

                {/* Status dot + domain name */}
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(card.status)}`} />
                  <h3 className="text-sm font-semibold text-zinc-100 group-hover:text-emerald-400 transition-colors truncate">
                    {card.domain}
                  </h3>
                </div>

                {/* Fitness score */}
                <div className="mb-3">
                  <span className="text-xs text-zinc-500">Fitness</span>
                  <span className={`ml-2 text-sm font-mono font-medium ${fitnessColor(card.fitness)}`}>
                    {card.fitness != null ? card.fitness.toFixed(2) : '---'}
                  </span>
                </div>

                {/* Task counts */}
                <div className="flex items-center gap-3 text-xs">
                  {card.needingReview > 0 && (
                    <span className="text-amber-400">
                      {card.needingReview} to review
                    </span>
                  )}
                  {card.completed > 0 && (
                    <span className="text-zinc-500">
                      {card.completed} done
                    </span>
                  )}
                  {card.needingReview === 0 && card.completed === 0 && (
                    <span className="text-zinc-600">No tasks</span>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {/* Empty state */}
          {domainCards.length === 0 && !perspectives && (
            <div className="text-center py-16">
              <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse mx-auto mb-3" />
              <p className="text-sm text-zinc-500">Loading perspectives...</p>
            </div>
          )}

          {domainCards.length === 0 && perspectives && (
            <div className="text-center py-16">
              <div className="text-4xl mb-3 opacity-40">&#9671;</div>
              <h3 className="text-lg font-semibold text-zinc-300 mb-2">No perspectives active</h3>
              <p className="text-sm text-zinc-500">Onboard a project to activate perspectives.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
