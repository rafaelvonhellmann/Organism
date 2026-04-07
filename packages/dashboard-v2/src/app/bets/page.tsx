'use client';

import { useState, useCallback } from 'react';
import { Header } from '@/components/header';
import { usePolling } from '@/hooks/use-polling';
import { StatusBadge } from '@/components/status-badge';

interface BetRow {
  id: string;
  title: string;
  problem: string;
  appetite: string;
  status: string;
  shapedBy: string;
  approvedBy: string | null;
  tokenBudget: number;
  costBudgetUsd: number;
  tokensUsed: number;
  costUsedUsd: number;
  noGos: string;
  rabbitHoles: string;
  successCriteria: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  // Paused bets extras
  pauseReason?: string | null;
  exceptionType?: string | null;
  pausedAt?: number | null;
}

interface ScopeRow {
  id: string;
  betId: string;
  title: string;
  description: string;
  hillPhase: string;
  hillProgress: number;
  completed: boolean;
}

interface HillUpdateRow {
  id: string;
  betId: string;
  scopeId: string | null;
  hillProgress: number;
  note: string;
  agent: string;
  createdAt: number;
}

interface BetDecisionRow {
  id: string;
  betId: string;
  decision: string;
  reason: string;
  decidedBy: string;
  exceptionType: string | null;
  createdAt: number;
}

interface BetDetail {
  bet: BetRow;
  scopes: ScopeRow[];
  hillUpdates: HillUpdateRow[];
  decisions: BetDecisionRow[];
  tasks: Array<{ id: string; agent: string; status: string; lane: string; description: string; createdAt: number }>;
}

const BET_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pitch_draft: { bg: 'bg-zinc-500/15', text: 'text-zinc-400' },
  pitch_ready: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  bet_approved: { bg: 'bg-indigo-500/15', text: 'text-indigo-400' },
  active: { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  paused: { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  cooldown: { bg: 'bg-sky-500/15', text: 'text-sky-400' },
  done: { bg: 'bg-green-500/15', text: 'text-green-400' },
  cancelled: { bg: 'bg-red-500/15', text: 'text-red-400' },
};

function HillChart({ scopes }: { scopes: ScopeRow[] }) {
  if (scopes.length === 0) return <div className="text-xs text-zinc-600">No scopes defined</div>;

  return (
    <div className="space-y-2">
      {scopes.map(scope => {
        const pct = Math.min(100, Math.max(0, scope.hillProgress));
        const phase = pct <= 50 ? 'Figuring out' : 'Making it happen';
        return (
          <div key={scope.id}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className={`font-medium ${scope.completed ? 'text-green-400 line-through' : 'text-zinc-300'}`}>
                {scope.title}
              </span>
              <span className="text-zinc-500">{phase} ({pct}%)</span>
            </div>
            <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
              {/* Hill shape indicator: midpoint = crest */}
              <div className="absolute inset-0 border-l-2 border-zinc-700" style={{ left: '50%' }} />
              <div
                className={`h-full rounded-full transition-all ${
                  scope.completed ? 'bg-green-500' : pct <= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BetCard({ bet, onClick }: { bet: BetRow; onClick: () => void }) {
  const colors = BET_STATUS_COLORS[bet.status] ?? BET_STATUS_COLORS.pitch_draft;
  const costPct = bet.costBudgetUsd > 0 ? (bet.costUsedUsd / bet.costBudgetUsd) * 100 : 0;
  const tokenPct = bet.tokenBudget > 0 ? (bet.tokensUsed / bet.tokenBudget) * 100 : 0;

  let noGos: string[] = [];
  try { noGos = JSON.parse(bet.noGos); } catch { /* ignore */ }

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-surface rounded-xl border border-edge p-5 hover:border-emerald-500/40 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="text-sm font-semibold text-zinc-100 flex-1 pr-2">{bet.title}</h3>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
          {bet.status.replace(/_/g, ' ')}
        </span>
      </div>

      <p className="text-xs text-zinc-400 mb-3 line-clamp-2">{bet.problem}</p>

      <div className="flex items-center gap-4 text-[11px] text-zinc-500">
        <span>Appetite: <span className="text-zinc-300">{bet.appetite}</span></span>
        <span>Shaped by: <span className="text-zinc-300">{bet.shapedBy}</span></span>
        {bet.approvedBy && <span>Approved by: <span className="text-zinc-300">{bet.approvedBy}</span></span>}
      </div>

      {/* Budget bars */}
      {(bet.status === 'active' || bet.status === 'paused') && (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-zinc-500 w-12">Cost</span>
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${costPct > 80 ? 'bg-red-500' : costPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, costPct)}%` }} />
            </div>
            <span className="text-zinc-400 font-mono">${bet.costUsedUsd.toFixed(2)}/${bet.costBudgetUsd.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-zinc-500 w-12">Tokens</span>
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${tokenPct > 80 ? 'bg-red-500' : tokenPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, tokenPct)}%` }} />
            </div>
            <span className="text-zinc-400 font-mono">{(bet.tokensUsed / 1000).toFixed(0)}k/{(bet.tokenBudget / 1000).toFixed(0)}k</span>
          </div>
        </div>
      )}

      {/* Paused exception */}
      {bet.pauseReason && (
        <div className="mt-3 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="text-[10px] font-semibold text-amber-400 mb-0.5">
            Exception: {bet.exceptionType?.replace(/_/g, ' ') ?? 'unknown'}
          </div>
          <div className="text-[11px] text-amber-300/80">{bet.pauseReason}</div>
        </div>
      )}

      {/* No-gos */}
      {noGos.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {noGos.slice(0, 3).map((ng, i) => (
            <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
              {ng}
            </span>
          ))}
        </div>
      )}

      {/* pitch_ready indicator */}
      {bet.status === 'pitch_ready' && (
        <div className="mt-3 text-[11px] font-semibold text-blue-400 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          Awaiting your approval
        </div>
      )}
    </button>
  );
}

function BetDetailView({ betId, onBack }: { betId: string; onBack: () => void }) {
  const { data, refresh } = usePolling<BetDetail>(`/api/bets/${betId}`);
  const [acting, setActing] = useState(false);
  const [actionNotes, setActionNotes] = useState('');

  const handleBetAction = useCallback(async (action: 'approve' | 'reject') => {
    setActing(true);
    try {
      const res = await fetch(`/api/bets/${betId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, notes: actionNotes || undefined }),
      });
      if (res.ok) {
        setActionNotes('');
        refresh();
      } else {
        const err = await res.json();
        alert(`Failed: ${err.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Failed: ${err}`);
    } finally {
      setActing(false);
    }
  }, [betId, actionNotes, refresh]);

  if (!data) return <div className="p-6 text-zinc-600">Loading bet details...</div>;

  const { bet, scopes, hillUpdates, decisions, tasks } = data;

  return (
    <div className="p-6 space-y-6">
      <button onClick={onBack} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
        &larr; Back to all bets
      </button>

      {/* Bet header */}
      <div className="bg-surface rounded-xl border border-edge p-5">
        <div className="flex items-start justify-between mb-2">
          <h2 className="text-lg font-semibold text-zinc-100">{bet.title}</h2>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${(BET_STATUS_COLORS[bet.status] ?? BET_STATUS_COLORS.pitch_draft).bg} ${(BET_STATUS_COLORS[bet.status] ?? BET_STATUS_COLORS.pitch_draft).text}`}>
            {bet.status.replace(/_/g, ' ')}
          </span>
        </div>
        <p className="text-sm text-zinc-400 mb-4">{bet.problem}</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div><span className="text-zinc-500">Appetite:</span> <span className="text-zinc-200">{bet.appetite}</span></div>
          <div><span className="text-zinc-500">Shaped by:</span> <span className="text-zinc-200">{bet.shapedBy}</span></div>
          <div><span className="text-zinc-500">Approved by:</span> <span className="text-zinc-200">{bet.approvedBy ?? 'pending'}</span></div>
          <div><span className="text-zinc-500">Project:</span> <span className="text-zinc-200">{bet.projectId}</span></div>
        </div>

        {/* Approve / Reject controls for pitch_ready bets */}
        {bet.status === 'pitch_ready' && (
          <div className="mt-4 pt-4 border-t border-edge space-y-3">
            <input
              type="text"
              placeholder="Notes (optional)"
              value={actionNotes}
              onChange={e => setActionNotes(e.target.value)}
              className="w-full text-xs bg-zinc-800 border border-edge rounded-lg px-3 py-2 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-emerald-500/50"
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleBetAction('approve')}
                disabled={acting}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
              >
                {acting ? 'Processing...' : 'Approve Bet'}
              </button>
              <button
                onClick={() => handleBetAction('reject')}
                disabled={acting}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors disabled:opacity-50"
              >
                {acting ? 'Processing...' : 'Reject Bet'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Hill Chart */}
      <div className="bg-surface rounded-xl border border-edge p-5">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3">Hill Chart</h3>
        <HillChart scopes={scopes} />
      </div>

      {/* Recent Hill Updates */}
      {hillUpdates.length > 0 && (
        <div className="bg-surface rounded-xl border border-edge p-5">
          <h3 className="text-sm font-semibold text-zinc-200 mb-3">Hill Updates</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {hillUpdates.map(hu => (
              <div key={hu.id} className="flex items-start gap-3 text-xs p-2 rounded-lg bg-zinc-800/30">
                <span className="text-zinc-500 font-mono whitespace-nowrap">{new Date(hu.createdAt).toLocaleString()}</span>
                <span className="text-zinc-400">{hu.agent}</span>
                <span className="text-emerald-400 font-mono">{hu.hillProgress}%</span>
                <span className="text-zinc-300 flex-1">{hu.note}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Decisions */}
      {decisions.length > 0 && (
        <div className="bg-surface rounded-xl border border-edge p-5">
          <h3 className="text-sm font-semibold text-zinc-200 mb-3">Decisions</h3>
          <div className="space-y-2">
            {decisions.map(d => (
              <div key={d.id} className="flex items-start gap-3 text-xs p-2 rounded-lg bg-zinc-800/30">
                <span className="text-zinc-500 font-mono whitespace-nowrap">{new Date(d.createdAt).toLocaleString()}</span>
                <span className={`font-semibold ${
                  d.decision === 'approved' ? 'text-green-400'
                  : d.decision === 'paused' ? 'text-amber-400'
                  : d.decision === 'cancelled' ? 'text-red-400'
                  : 'text-blue-400'
                }`}>{d.decision}</span>
                <span className="text-zinc-400">{d.decidedBy}</span>
                {d.exceptionType && <span className="text-amber-400">[{d.exceptionType.replace(/_/g, ' ')}]</span>}
                <span className="text-zinc-300 flex-1">{d.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      {tasks.length > 0 && (
        <div className="bg-surface rounded-xl border border-edge p-5">
          <h3 className="text-sm font-semibold text-zinc-200 mb-3">Linked Tasks ({tasks.length})</h3>
          <div className="space-y-1.5">
            {tasks.map(t => (
              <div key={t.id} className="flex items-center gap-3 text-xs p-2 rounded-lg bg-zinc-800/30">
                <StatusBadge status={t.status} />
                <span className="text-zinc-300 flex-1 truncate">{t.description}</span>
                <span className="text-zinc-500">{t.agent}</span>
                <span className="text-zinc-600 font-mono">{t.id.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BetsPage() {
  const [project, setProject] = useState('');
  const [tab, setTab] = useState<'all' | 'active' | 'paused' | 'pitches'>('all');
  const [selectedBetId, setSelectedBetId] = useState<string | null>(null);

  const url = tab === 'paused'
    ? '/api/bets?paused=1'
    : tab === 'pitches'
    ? '/api/pitches'
    : tab === 'active'
    ? '/api/bets?status=active'
    : '/api/bets';

  const { data, lastUpdated } = usePolling<BetRow[]>(url);

  if (selectedBetId) {
    return (
      <>
        <Header title="Shape Up" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />
        <BetDetailView betId={selectedBetId} onBack={() => setSelectedBetId(null)} />
      </>
    );
  }

  return (
    <>
      <Header title="Shape Up" project={project} onProjectChange={setProject} lastUpdated={lastUpdated} />

      <div className="p-6 space-y-6">
        {/* Tabs */}
        <div className="flex items-center gap-1 bg-zinc-800/40 rounded-lg p-1 w-fit">
          {(['all', 'active', 'paused', 'pitches'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                tab === t ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t === 'all' ? 'All Bets' : t === 'active' ? 'Active' : t === 'paused' ? 'Paused' : 'Pitches'}
            </button>
          ))}
        </div>

        {/* Bet list */}
        <div className="grid gap-4 sm:grid-cols-2">
          {(data ?? []).map((bet: BetRow) => (
            <BetCard key={bet.id} bet={bet} onClick={() => setSelectedBetId(bet.id)} />
          ))}
        </div>

        {data && data.length === 0 && (
          <div className="text-center py-12 text-zinc-600">
            {tab === 'pitches' ? 'No pitches found.' : 'No bets found.'}
          </div>
        )}

        {!data && (
          <div className="text-center py-12 text-zinc-600">Loading...</div>
        )}
      </div>
    </>
  );
}
