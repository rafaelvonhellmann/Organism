'use client';

import { useState } from 'react';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';

interface PalateSource {
  id: string;
  localPath: string;
  fitness: number;
  tags: string[];
  scope: string;
  approved: boolean;
  addedBy: string;
  addedAt: number;
  totalInjections: number;
  lastInjected: number | null;
}

interface PalateData {
  sources: PalateSource[];
  stats: {
    totalInjections: number;
    totalRawTokens: number;
    totalDistilledTokens: number;
    totalSavings: number;
    savingsPercent: number;
    cacheHits: number;
    cacheMisses: number;
    byCapability: Record<string, number>;
  };
  ratings: Array<{ page: string; count: number; avg: number }>;
}

function fitnessColor(f: number): string {
  if (f >= 0.6) return 'text-green-400';
  if (f >= 0.3) return 'text-yellow-400';
  return 'text-red-400';
}

function fitnessBar(f: number): string {
  const filled = Math.round(f * 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

export default function PalatePage() {
  const [project, setProject] = useState('');
  const { data, lastUpdated } = usePolling<PalateData>('/api/palate');

  return (
    <>
      <Header title="Palate" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />
      <div className="p-6 space-y-6">

        {/* Stats cards */}
        {data?.stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-surface rounded-xl border border-edge p-5">
              <div className="text-xs text-muted uppercase tracking-wide">Injections</div>
              <div className="text-2xl font-bold mt-1">{data.stats.totalInjections}</div>
            </div>
            <div className="bg-surface rounded-xl border border-edge p-5">
              <div className="text-xs text-muted uppercase tracking-wide">Token Savings</div>
              <div className="text-2xl font-bold mt-1 text-green-400">
                {data.stats.savingsPercent}%
              </div>
              <div className="text-xs text-muted">
                {data.stats.totalSavings.toLocaleString()} tokens saved
              </div>
            </div>
            <div className="bg-surface rounded-xl border border-edge p-5">
              <div className="text-xs text-muted uppercase tracking-wide">Cache</div>
              <div className="text-2xl font-bold mt-1">{data.stats.cacheHits + data.stats.cacheMisses}</div>
              <div className="text-xs text-muted">
                {data.stats.cacheHits} hits / {data.stats.cacheMisses} misses
              </div>
            </div>
            <div className="bg-surface rounded-xl border border-edge p-5">
              <div className="text-xs text-muted uppercase tracking-wide">Sources</div>
              <div className="text-2xl font-bold mt-1">{data.sources.length}</div>
              <div className="text-xs text-muted">
                {data.sources.filter((s) => s.approved).length} approved
              </div>
            </div>
          </div>
        )}

        {/* By capability */}
        {data?.stats.byCapability && Object.keys(data.stats.byCapability).length > 0 && (
          <div className="bg-surface rounded-xl border border-edge p-5">
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-3">Injections by Capability</h2>
            <div className="space-y-2">
              {Object.entries(data.stats.byCapability)
                .sort(([, a], [, b]) => b - a)
                .map(([cap, count]) => (
                  <div key={cap} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs">{cap}</span>
                    <span className="text-muted">{count}x</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Source registry */}
        {data?.sources && data.sources.length > 0 && (
          <div className="bg-surface rounded-xl border border-edge p-5">
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-3">Source Registry</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-edge">
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Fitness</th>
                    <th className="py-2 pr-4">Injections</th>
                    <th className="py-2 pr-4">Tags</th>
                    <th className="py-2">Path</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sources.map((s) => (
                    <tr key={s.id} className="border-b border-edge/50">
                      <td className="py-2 pr-4 font-medium">{s.id}</td>
                      <td className="py-2 pr-4">
                        <span className={`text-xs px-2 py-0.5 rounded ${s.approved ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}`}>
                          {s.approved ? 'APPROVED' : 'PENDING'}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`font-mono text-xs ${fitnessColor(s.fitness)}`}>
                          {fitnessBar(s.fitness)} {s.fitness.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-muted">{s.totalInjections}</td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-1 flex-wrap">
                          {s.tags.map((t) => (
                            <span key={t} className="text-xs bg-edge px-1.5 py-0.5 rounded">{t}</span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 font-mono text-xs text-muted">{s.localPath}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Wiki ratings */}
        {data?.ratings && data.ratings.length > 0 && (
          <div className="bg-surface rounded-xl border border-edge p-5">
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-3">Wiki Ratings</h2>
            <div className="space-y-2">
              {data.ratings.map((r) => (
                <div key={r.page} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{r.page}</span>
                  <div className="flex items-center gap-2 text-muted">
                    <span className="text-yellow-400">
                      {'★'.repeat(Math.round(r.avg))}{'☆'.repeat(5 - Math.round(r.avg))}
                    </span>
                    <span className="text-xs">({r.count} ratings, avg {r.avg})</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {data && data.sources.length === 0 && data.stats.totalInjections === 0 && (
          <div className="bg-surface rounded-xl border border-edge p-10 text-center text-muted">
            <div className="text-lg mb-2">No Palate data yet</div>
            <div className="text-sm">
              Run a task that matches a capability with knowledgeSources to see injection telemetry.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
