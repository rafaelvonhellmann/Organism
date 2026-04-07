import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Initialize a fresh in-memory DB before each test by resetting the module state.
// task-queue.ts uses a singleton; we force a fresh path each run.
import { getDb } from './task-queue.js';

import {
  createPitch, getPitch, listPitches, markPitchReady,
  createBet, getBet, listBets, approveBet, activateBet,
  pauseBet, completeBet, cooldownBet, cancelBet,
  addScope, listScopes, updateScopeProgress,
  postHillUpdate, listHillUpdates,
  checkBetCircuitBreaker, checkBetBoundaries, recordBetSpend,
  resolveSpecialistTriggers, listBetDecisions,
} from './shapeup.js';

// Ensure DB is initialized (migrations run)
getDb();

describe('Shape Up — Pitches', () => {
  it('creates a pitch and retrieves it', () => {
    const pitch = createPitch({
      title: 'Test Pitch',
      problem: 'Things are broken',
      appetite: 'small batch',
      shaped_by: 'rafael',
      project_id: 'test-project',
    });

    assert.ok(pitch.id);
    assert.equal(pitch.title, 'Test Pitch');
    assert.equal(pitch.status, 'draft');
    assert.equal(pitch.shaped_by, 'rafael');

    const fetched = getPitch(pitch.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, pitch.id);
  });

  it('marks a pitch ready', () => {
    const pitch = createPitch({
      title: 'Ready Pitch',
      problem: 'Needs work',
      shaped_by: 'rafael',
    });
    assert.equal(pitch.status, 'draft');

    const updated = markPitchReady(pitch.id);
    assert.equal(updated.status, 'ready');
  });

  it('lists pitches by project', () => {
    const p1 = createPitch({ title: 'P1', problem: 'x', shaped_by: 'a', project_id: 'proj-a' });
    const p2 = createPitch({ title: 'P2', problem: 'y', shaped_by: 'a', project_id: 'proj-b' });

    const projA = listPitches('proj-a');
    assert.ok(projA.some(p => p.id === p1.id));
    assert.ok(!projA.some(p => p.id === p2.id));
  });
});

describe('Shape Up — Bets', () => {
  it('creates and retrieves a bet', () => {
    const bet = createBet({
      title: 'Test Bet',
      problem: 'Need to build X',
      appetite: 'small batch',
      shaped_by: 'rafael',
      token_budget: 100000,
      cost_budget_usd: 2.00,
      no_gos: JSON.stringify(['rewrite everything']),
      rabbit_holes: JSON.stringify(['premature optimization']),
      success_criteria: JSON.stringify(['tests pass', 'deploys clean']),
    });

    assert.ok(bet.id);
    assert.equal(bet.status, 'pitch_draft');
    assert.equal(bet.token_budget, 100000);
    assert.equal(bet.cost_budget_usd, 2.00);

    const fetched = getBet(bet.id);
    assert.ok(fetched);
    assert.equal(fetched!.title, 'Test Bet');
  });

  it('approves a bet', () => {
    const bet = createBet({ title: 'Approve Me', problem: 'x', shaped_by: 'system' });
    const approved = approveBet(bet.id, 'rafael', 'Looks good');
    assert.equal(approved.status, 'bet_approved');
    assert.equal(approved.approved_by, 'rafael');

    const decisions = listBetDecisions(bet.id);
    assert.ok(decisions.some(d => d.decision === 'approved'));
  });

  it('activates a bet', () => {
    const bet = createBet({ title: 'Activate Me', problem: 'x', shaped_by: 'system' });
    approveBet(bet.id, 'rafael');
    const active = activateBet(bet.id);
    assert.equal(active.status, 'active');
  });

  it('pauses a bet on exception', () => {
    const bet = createBet({ title: 'Pause Me', problem: 'x', shaped_by: 'system' });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    const paused = pauseBet(bet.id, 'Token budget exceeded', 'token_budget_exceeded');
    assert.equal(paused.status, 'paused');

    const decisions = listBetDecisions(bet.id);
    assert.ok(decisions.some(d => d.decision === 'paused' && d.exception_type === 'token_budget_exceeded'));
  });

  it('completes a bet', () => {
    const bet = createBet({ title: 'Complete Me', problem: 'x', shaped_by: 'system' });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);
    const done = completeBet(bet.id, 'system', 'All criteria met');
    assert.equal(done.status, 'done');
  });

  it('cools down a bet', () => {
    const bet = createBet({ title: 'Cooldown Me', problem: 'x', shaped_by: 'system' });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);
    const cooled = cooldownBet(bet.id, 'End of cycle');
    assert.equal(cooled.status, 'cooldown');
  });

  it('cancels a bet', () => {
    const bet = createBet({ title: 'Cancel Me', problem: 'x', shaped_by: 'system' });
    const cancelled = cancelBet(bet.id, 'rafael', 'No longer needed');
    assert.equal(cancelled.status, 'cancelled');
  });

  it('lists bets by status', () => {
    const bet = createBet({ title: 'Status Test', problem: 'x', shaped_by: 'system' });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    const active = listBets(undefined, 'active');
    assert.ok(active.some(b => b.id === bet.id));
  });
});

describe('Shape Up — Scopes and Hill Chart', () => {
  it('adds scopes to a bet', () => {
    const bet = createBet({ title: 'Scoped Bet', problem: 'x', shaped_by: 'system' });
    const s1 = addScope(bet.id, 'Database schema', 'Design and migrate');
    const s2 = addScope(bet.id, 'API endpoints', 'REST routes');

    assert.ok(s1.id);
    assert.equal(s1.hill_phase, 'figuring_out');
    assert.equal(s1.hill_progress, 0);

    const scopes = listScopes(bet.id);
    assert.equal(scopes.length, 2);
  });

  it('updates scope progress', () => {
    const bet = createBet({ title: 'Progress Bet', problem: 'x', shaped_by: 'system' });
    const scope = addScope(bet.id, 'Test scope');

    const updated = updateScopeProgress(scope.id, 30);
    assert.equal(updated.hill_progress, 30);
    assert.equal(updated.hill_phase, 'figuring_out');

    const updated2 = updateScopeProgress(scope.id, 75);
    assert.equal(updated2.hill_progress, 75);
    assert.equal(updated2.hill_phase, 'making_it_happen');

    const completed = updateScopeProgress(scope.id, 100);
    assert.equal(completed.completed, true);
  });

  it('posts hill updates', () => {
    const bet = createBet({ title: 'Hill Bet', problem: 'x', shaped_by: 'system' });
    const scope = addScope(bet.id, 'Hill scope');

    const update = postHillUpdate({
      bet_id: bet.id,
      scope_id: scope.id,
      hill_progress: 40,
      note: 'Making progress on design',
      agent: 'engineering',
    });

    assert.ok(update.id);
    assert.equal(update.hill_progress, 40);
    assert.equal(update.agent, 'engineering');

    const updates = listHillUpdates(bet.id);
    assert.ok(updates.length > 0);
  });
});

describe('Shape Up — Circuit Breaker', () => {
  it('trips when token budget exceeded', () => {
    const bet = createBet({
      title: 'Breaker Test',
      problem: 'x',
      shaped_by: 'system',
      token_budget: 1000,
      cost_budget_usd: 10.00,
    });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    // Spend more than the budget
    recordBetSpend(bet.id, 1500, 0.50);

    const result = checkBetCircuitBreaker(bet.id);
    assert.equal(result.tripped, true);
    assert.equal(result.exception, 'token_budget_exceeded');

    // Bet should now be paused
    const updated = getBet(bet.id);
    assert.equal(updated!.status, 'paused');
  });

  it('trips when cost budget exceeded', () => {
    const bet = createBet({
      title: 'Cost Breaker',
      problem: 'x',
      shaped_by: 'system',
      token_budget: 1000000,
      cost_budget_usd: 1.00,
    });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    recordBetSpend(bet.id, 500, 1.50);

    const result = checkBetCircuitBreaker(bet.id);
    assert.equal(result.tripped, true);
    assert.equal(result.exception, 'appetite_exceeded');
  });

  it('does not trip when within budget', () => {
    const bet = createBet({
      title: 'Within Budget',
      problem: 'x',
      shaped_by: 'system',
      token_budget: 100000,
      cost_budget_usd: 10.00,
    });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    recordBetSpend(bet.id, 500, 0.01);

    const result = checkBetCircuitBreaker(bet.id);
    assert.equal(result.tripped, false);
  });
});

describe('Shape Up — Boundary Checks', () => {
  it('trips on no-go keyword', () => {
    const bet = createBet({
      title: 'No-Go Test',
      problem: 'x',
      shaped_by: 'system',
      no_gos: JSON.stringify(['rewrite everything', 'change auth']),
    });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    const result = checkBetBoundaries(bet.id, 'We should rewrite everything from scratch');
    assert.equal(result.tripped, true);
    assert.equal(result.exception, 'no_go_hit');
  });

  it('trips on rabbit hole keyword', () => {
    const bet = createBet({
      title: 'Rabbit Hole Test',
      problem: 'x',
      shaped_by: 'system',
      rabbit_holes: JSON.stringify(['premature optimization', 'custom framework']),
    });
    approveBet(bet.id, 'rafael');
    activateBet(bet.id);

    const result = checkBetBoundaries(bet.id, 'Let me do some premature optimization first');
    assert.equal(result.tripped, true);
    assert.equal(result.exception, 'rabbit_hole_hit');
  });

  it('passes when no boundaries violated', () => {
    const bet = createBet({
      title: 'Clean Task',
      problem: 'x',
      shaped_by: 'system',
      no_gos: JSON.stringify(['rewrite everything']),
      rabbit_holes: JSON.stringify(['premature optimization']),
    });

    const result = checkBetBoundaries(bet.id, 'Add a new API endpoint for users');
    assert.equal(result.tripped, false);
  });
});

describe('Shape Up — Specialist Triggers', () => {
  it('triggers legal for compliance-related tasks', () => {
    const specialists = resolveSpecialistTriggers('Review GDPR compliance for user data', 'HIGH', true);
    assert.ok(specialists.includes('legal'));
  });

  it('triggers security-audit for auth-related tasks', () => {
    const specialists = resolveSpecialistTriggers('Implement OAuth authentication flow', 'HIGH', true);
    assert.ok(specialists.includes('security-audit'));
  });

  it('triggers quality-guardian for deployment tasks', () => {
    const specialists = resolveSpecialistTriggers('Deploy to production', 'HIGH', true);
    assert.ok(specialists.includes('quality-guardian'));
  });

  it('does not trigger specialists for LOW lane', () => {
    const specialists = resolveSpecialistTriggers('Review GDPR compliance', 'LOW', true);
    assert.equal(specialists.length, 0);
  });

  it('does not trigger specialists without a bet when requires_bet=true', () => {
    const specialists = resolveSpecialistTriggers('Review GDPR compliance', 'HIGH', false);
    assert.equal(specialists.length, 0);
  });

  it('does not trigger specialists for unrelated descriptions', () => {
    const specialists = resolveSpecialistTriggers('Update the README file', 'HIGH', true);
    assert.equal(specialists.length, 0);
  });
});
