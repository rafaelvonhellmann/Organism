# Organism Autoresearch Queue

Ranked follow-up hypotheses from the first `karpathy/autoresearch` adaptation pass.

## P0

1. **Replayable Runtime Decisions**
   - Hypothesis: every dashboard-visible runtime decision should be explainable from a stored config snapshot plus action-gate reason code.
   - Candidate work: surface `displayStatus`, `displayReason`, and `configSnapshot` in dashboard runtime detail cards.
   - Keep metric: live/browser smoke still passes; runtime cards distinguish blocked vs retry vs error without reading raw task blobs.

2. **Autonomy Experiment Ledger in Dashboard**
   - Hypothesis: operators will trust autonomous changes more if experiment outcomes are visible in the dashboard.
   - Candidate work: add a read-only API and compact dashboard panel for `.tmp/autoresearch/results.tsv` or a future state-backed ledger.
   - Keep metric: authenticated-only API, no secret exposure, empty-state friendly.

3. **Policy Boundary Regression Suite**
   - Hypothesis: most dangerous regressions are boundary-crossing mistakes, not individual test failures.
   - Candidate work: deterministic tests for Paperclip-only orchestration, PraisonAI five-tool sidecar boundary, project action gates, and approval thresholds.
   - Keep metric: single command fails if sidecar gains orchestration behavior or a project can bypass approval.

## P1

4. **Project-Specific Canary Recipes**
   - Hypothesis: each project needs a small, safe, repeatable canary instead of ad hoc live tests.
   - Candidate work: formalize `scripts/synapse-canary.ts` into a generic `scripts/project-canary.ts --project synapse --preset read-only`.
   - Keep metric: canary dispatches only its own task and records a bounded result.

5. **API Payload Budget Tests**
   - Hypothesis: dashboard slowness and data exposure return when endpoints ship unbounded blobs.
   - Candidate work: add tests or smoke thresholds for `/api/tasks`, `/api/runtime`, and `/api/actions` response sizes.
   - Keep metric: unauthenticated 401, authenticated default payloads stay below explicit byte budgets.

6. **Autoresearch Full Profile**
   - Hypothesis: the quick harness is good for iteration, but full mode should mirror deploy readiness.
   - Candidate work: add optional production dashboard smoke and Synapse canary flags to `scripts/autoresearch-organism.ts`.
   - Keep metric: full profile catches live dashboard regression before deploy promotion.

## P2

7. **Experiment Cards for Agent Changes**
   - Hypothesis: agent promotion and agent code changes should carry experiment metadata, not just commits.
   - Candidate work: require a short hypothesis/result note for changes to `agents/` and `knowledge/capability-registry.json`.
   - Keep metric: shadow promotion remains gated and reviewable.

8. **Research Cache Freshness UI**
   - Hypothesis: cached research becomes stale invisibly.
   - Candidate work: expose project research cache age and source count in the dashboard.
   - Keep metric: no external browsing from dashboard; read-only cache metadata only.

9. **Discard-Path Tooling**
   - Hypothesis: autonomous agents keep weak changes because reverting is socially and mechanically expensive.
   - Candidate work: add a `--compare-to <ref>` mode to the harness that reports whether a candidate improved, tied, or worsened.
   - Keep metric: no destructive reset; it prints evidence and leaves the decision to the operator/agent.
