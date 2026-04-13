import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getV2DeployTargets, isActionBlocked, loadProjectPolicy, normalizePolicyCommand, resolveTaskSafetyEnvelope, toV2ProjectName } from './project-policy.js';

describe('project-policy', () => {
  it('applies stabilization blocks for contact and purchases', () => {
    const policy = loadProjectPolicy('organism');
    assert.equal(policy.autonomyMode, 'stabilization');
    assert.equal(isActionBlocked(policy, 'contact'), true);
    assert.equal(isActionBlocked(policy, 'purchase'), true);
    assert.equal(isActionBlocked(policy, 'create_account'), true);
    assert.equal(policy.workspaceMode, 'isolated_worktree');
    assert.equal(policy.launchGuards.minimumHealthyRunsForDeploy, 5);
  });

  it('derives fork comparison targets for v2 deployments', () => {
    const policy = loadProjectPolicy('organism');
    const targets = getV2DeployTargets(policy);

    assert.ok(targets.length > 0);
    assert.ok(targets.every((target) => target.project.endsWith('-v2')));
    assert.ok(targets.every((target) => target.name.endsWith('-v2')));
    assert.equal(toV2ProjectName('organism-hq'), 'organism-hq-v2');
  });

  it('loads MiniMax as a bounded tool provider for Organism', () => {
    const policy = loadProjectPolicy('organism');
    assert.equal(policy.toolProviders.minimax.enabled, true);
    assert.deepEqual(policy.toolProviders.minimax.allowedCommands, ['search']);
    assert.equal(policy.toolProviders.minimax.region, 'global');
  });

  it('loads a bounded self-audit lane for Organism', () => {
    const policy = loadProjectPolicy('organism');
    assert.equal(policy.selfAudit.enabled, true);
    assert.equal(policy.selfAudit.cadence, 'daily');
    assert.equal(policy.selfAudit.hour, 8);
    assert.deepEqual(policy.selfAudit.workflows, ['review', 'validate', 'recover', 'implement']);
    assert.equal(policy.selfAudit.maxFollowups, 4);
  });

  it('loads the early canary workflow guard for Tokens for Good', () => {
    const policy = loadProjectPolicy('tokens-for-good');
    assert.equal(policy.launchGuards.initialWorkflowLimit, 3);
    assert.deepEqual(policy.launchGuards.initialAllowedWorkflows, ['review', 'implement', 'validate']);
    assert.equal(policy.workspaceMode, 'isolated_worktree');
    assert.equal(policy.commands.install, 'corepack pnpm install');
  });

  it('normalizes pnpm commands through the shared shell contract', () => {
    assert.equal(normalizePolicyCommand('pnpm typecheck'), 'corepack pnpm typecheck');
    assert.equal(normalizePolicyCommand('cd apps/portal && pnpm build'), 'cd apps/portal && corepack pnpm build');
    assert.equal(normalizePolicyCommand('npx vercel --prod --yes'), 'npx vercel --prod --yes');
  });

  it('loads a medical-safe autonomy lane for Synapse', () => {
    const policy = loadProjectPolicy('synapse');
    assert.deepEqual(policy.qualityStandards, ['MEDICAL']);
    assert.equal(policy.autonomySurfaces.readOnlyCanary, true);
    assert.deepEqual(policy.launchGuards.initialAllowedWorkflows, ['review', 'plan', 'validate']);
    assert.ok(policy.autonomySurfaces.protectedTaskKeywords.includes('grading'));
    assert.ok(policy.autonomySurfaces.safeTaskKeywords.includes('admin dashboard'));
  });

  it('blocks autonomous implementation on protected Synapse surfaces', () => {
    const policy = loadProjectPolicy('synapse');
    const envelope = resolveTaskSafetyEnvelope(
      policy,
      'Implement SAQ grading rubric fixes and update answer key generation',
      'implement',
    );

    assert.equal(envelope.forcedLane, 'HIGH');
    assert.equal(Boolean(envelope.blockedReason), true);
    assert.equal(envelope.protectedSurfaceMatch, true);
  });
});
