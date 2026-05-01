# Organism Autoresearch Program

This adapts the useful operating pattern from `karpathy/autoresearch` without copying its code or turning Organism into a model-training repo. The reference snapshot inspected for this pass was `karpathy/autoresearch@228791f`.

## Research Loop

Autoresearch for Organism means:

1. Pick one bounded hypothesis about the control plane, dashboard, runtime, or project policy.
2. Make the smallest code or documentation change that can test that hypothesis.
3. Run the fixed evaluation harness.
4. Record the result in the TSV ledger.
5. Keep the change only when it improves reliability, clarity, or safety without adding unjustified complexity.

The agent should keep the loop moving until interrupted, but each iteration must remain reviewable.

## Fixed Evaluation

Use:

```bash
node node_modules/tsx/dist/cli.mjs --experimental-sqlite scripts/autoresearch-organism.ts --tag apr29 --notes "short experiment note"
```

The harness records results in `.tmp/autoresearch/results.tsv` by default. The ledger is intentionally untracked.

The default `quick` profile checks:

- TypeScript for core scripts and packages.
- Core runtime/control-plane tests that are already tracked.
- Dashboard auth tests.

Use `--profile full` before pushing or deploying. Full mode adds the dashboard production build.

## Editable Surface

Prefer changes in these surfaces:

- `packages/core/src/` control-plane logic.
- `packages/shared/src/types.ts` shared contracts.
- `packages/dashboard-v2/src/` runtime visibility and command surfaces.
- `scripts/` deterministic harnesses and smoke checks.
- `knowledge/projects/*/config.json` policy and project-shaping files.
- `docs/` ADRs, handoffs, and operator programs.

Do not put orchestration logic in `packages/mcp-sidecar/`. PraisonAI remains a restricted MCP tool provider. Paperclip remains the orchestrator.

## Keep Criteria

Keep a change when it does one or more of these:

- Makes a failure mode visible earlier.
- Reduces unauthenticated or unsafe surface area.
- Makes a runtime decision replayable from captured state.
- Turns a manual production check into a deterministic smoke.
- Shrinks ambiguity in project policy, review lanes, or action gates.
- Simplifies code while preserving behavior.

Discard or revise a change when it:

- Mixes multiple unrelated ideas into one patch.
- Adds broad abstraction before repeated pain exists.
- Weakens the review pipeline or sidecar boundary.
- Depends on secrets, live mutation, or external state for basic verification.
- Makes dashboard APIs heavier by default.

## Ledger Fields

The harness writes:

```tsv
timestamp	tag	profile	branch	commit	status	score	duration_ms	changed_files	checks	notes
```

The score is `passedChecks / totalChecks`. A score below `1.000` means the current candidate is not shippable.

## Eight-Hour Mode

For a long autonomous pass, repeat this cadence:

1. Research or inspect for 10-20 minutes.
2. Implement one bounded improvement.
3. Run the quick harness.
4. If quick passes, optionally run full.
5. Commit only the coherent improvement.
6. Move to the next hypothesis.

If the worktree is dirty before the pass starts, stage only the files touched for the current hypothesis. Treat every unrelated dirty file as user-owned.
