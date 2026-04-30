# Warp Adaptation Analysis for Organism

Date: 2026-04-29
Scope: defensive, non-invasive architecture/product review of the public Warp source and docs only.

Inspected Warp source: `warpdotdev/warp` at commit `d0f045c01bacbd845a631d07da30f277cfd2b98d` from 2026-04-28.

## Executive Recommendation

Do not replace Organism with Warp.

Warp and Organism are aimed at adjacent but different layers:

- Warp is an agentic terminal and development environment. Its center of gravity is an interactive terminal/session substrate, CLI-agent harnesses, codebase context, permissions, and developer UX.
- Organism is a project orchestration and governance runtime. Its center of gravity is Paperclip-owned scheduling, project policy, auditability, risk lanes, review gates, dashboards, and cross-project operations.

The best path is to keep Organism as the orchestrator and adapt selected Warp patterns into Organism's runtime, dashboard, and executor layer. Think: Organism owns governance and lifecycle; Warp-style ideas improve the run harness, permission model, task state model, and developer-facing console.

## Legal Boundary

Warp is not generally permissively licensed. The root workspace declares AGPL-3.0-only, while the README states that `warpui_core` and `warpui` are MIT and the rest is AGPL v3. This means Organism should not copy non-MIT Warp implementation code unless we intentionally accept AGPL obligations.

Recommended rule: use Warp as an architecture reference, not a code donor. Recreate patterns cleanly in TypeScript under Organism's own design.

Sources:

- README license lines: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/README.md#L36-L38
- Cargo workspace license: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/Cargo.toml#L2-L27

## High-Level Warp Architecture

Warp is a Rust workspace with roughly 5,000 tracked files in the inspected checkout, dominated by Rust. The top-level organization is:

- `app/`: main desktop application, terminal integration, AI, workspace, settings, auth, drive, code review, workflows.
- `crates/`: reusable Rust crates for AI, terminal, UI, IPC, settings, repo metadata, MCP-ish integration, secrets, ripgrep, LSP, JSON-RPC, virtual filesystem, and more.
- `.agents/skills`: repo-native agent instructions.
- `.warp/workflows`: reusable command workflows.
- `command-signatures-v2`: command/completion knowledge.

Warp's own repo guide describes it as a Rust terminal emulator with WarpUI, with terminal emulation/shell management in `app/src/terminal`, AI integration in `app/src/ai`, and context-aware codebase indexing.

Sources:

- Architecture overview: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/WARP.md#L44-L79
- Build/test workflow: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/WARP.md#L7-L36
- Workspace crates: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/Cargo.toml#L32-L91

## What Warp Has That Organism Should Adapt

### 1. Richer Run and Task State Model

Warp's ambient agent task state is more expressive than Organism's older task surface. It distinguishes queued, pending, claimed, in progress, succeeded, failed, error, blocked, cancelled, and unknown. It also defines helper semantics for in-progress, failed, and terminal states.

Organism already has `RunSessionStatus` and `TaskStatus`, including pending, running/in_progress, paused, retry_scheduled, completed, failed, cancelled, awaiting_review, dead_letter. The missing distinction is mostly semantic clarity:

- `blocked` should be first-class, not only represented as paused, failed, or interrupt.
- `claimed` should exist when a worker has reserved work but has not begun execution.
- `error` should be separated from `failed` where `failed` means the agent completed and judged the task unsuccessful, while `error` means infrastructure/runtime failure.
- `unknown` should exist only as a deserialization compatibility state for dashboard/API resilience.

Recommendation:

- Add a normalized run display state for dashboard/API: `queued`, `pending`, `claimed`, `running`, `blocked`, `retry_scheduled`, `succeeded`, `failed`, `error`, `cancelled`, `dead_letter`, `awaiting_review`, `unknown`.
- Preserve existing DB values where possible, but expose a richer derived state in API responses.
- Add `blockedReason`, `claimedBy`, and `claimExpiresAt` to run/task views.

Source:

- Warp task state and helpers: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/ambient_agents/task.rs#L326-L405
- Organism current types: `packages/shared/src/types.ts`

### 2. Immutable Agent Config Snapshot Per Run

Warp stores an `AgentConfigSnapshot` with model, environment, base prompt, MCP servers, profile, worker host, skill spec, computer-use setting, harness, and harness auth secret references. This is a very strong pattern.

Organism currently has project policy, workflow kind, source kind, agent, budget, and run state, but run provenance is spread across tables, config files, env vars, executor resolution, and audit entries.

Recommendation:

- Add `run_config_snapshot` to `run_sessions` or a related table.
- Capture at task creation or run start:
  - project ID, workflow kind, source kind
  - agent, model profile, resolved model/backend
  - code executor kind and version/path if available
  - sidecar mode and allowed sidecar tool set
  - project policy hash and relevant autonomy settings
  - required secrets by name only, never values
  - workspace mode and repo path
  - selected skills/workflows
  - risk lane and review pipeline requirements
- Use this snapshot for replay, debugging, dashboard display, and "why did it do that?" audit trails.

Source:

- Warp config snapshot: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/ambient_agents/task.rs#L20-L64

### 3. Deterministic Agent Driver Phases

Warp's `AgentDriver` is the most useful adaptation target. It explicitly owns a run lifecycle around a headless terminal pane, secrets, environment setup, MCP server startup, harness execution, resume behavior, periodic save, idle timeout, and end-of-run snapshot upload.

Organism's executor stack already has good pieces: `code-executor.ts`, `run-state.ts`, runtime events, policy gate, sidecar boundary, adaptive timeouts, cooldowns, and fallback. What it lacks is one named driver abstraction that records each setup and execution phase as first-class steps.

Recommendation:

- Introduce `packages/core/src/run-driver.ts`.
- Make it the one place that advances phases:
  1. resolve project policy
  2. create/claim run
  3. write immutable config snapshot
  4. verify workspace/repo path
  5. verify required secrets by name
  6. resolve model/backend through sidecar
  7. resolve executor/harness
  8. start run step records
  9. execute prompt
  10. collect output/artifacts
  11. classify failure
  12. update run/task/goal status
  13. trigger review pipeline
  14. emit final handoff/checkpoint
- Every phase should write a `run_steps` row and `runtime_event`.

This directly addresses the class of problems seen recently in Organism: stale dashboard state, ambiguous dispatch, broad recovery jobs picking up unintended tasks, and hard-to-debug production/runtime failures.

Sources:

- Warp driver timeouts and lifecycle constants: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_sdk/driver.rs#L102-L109
- Driver options: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_sdk/driver.rs#L210-L238
- Driver responsibility: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_sdk/driver.rs#L243-L262
- Harness execution/save lifecycle: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_sdk/driver.rs#L1387-L1606
- Snapshot upload pipeline: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_sdk/driver.rs#L2192-L2243

### 4. Permission Reasons, Not Just Allow/Deny

Warp's permission model returns typed allowed/denied reasons for command execution, file reads, file writes, and MCP actions. It has explicit reasons such as always ask, explicitly denied, redirection detected, inconclusive, agent decided, protected path, read-only setting, and run-to-completion.

Organism has `action-gate.ts`, project policy, sidecar policy checks, approval thresholds, and safety envelopes. The missing piece is detailed reason taxonomy at the tool/action level.

Recommendation:

- Extend `RuntimeActionGateResult` with `reasonCode`.
- Split command/tool permission into:
  - `allowed`
  - `denied`
  - `requires_approval`
  - `not_ready`
  - `protected_path`
  - `inconclusive`
- Add explicit denial reasons:
  - `project_policy_block`
  - `sidecar_policy_block`
  - `contains_redirection`
  - `destructive_command`
  - `outside_workspace`
  - `missing_secret`
  - `protected_config`
  - `not_read_only`
  - `approval_required`
- Display these in dashboard and audit log.

Source:

- Warp permission enums: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/blocklist/permissions.rs#L38-L133
- Warp command autoexecution checks: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/blocklist/permissions.rs#L832-L923
- Protected path handling: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/blocklist/permissions.rs#L1162-L1173

### 5. Parallel Read-Only Context Gathering

Warp classifies read-only local context actions as safe to run in a parallel phase: read files, search codebase, read skill, grep, and file glob. Mutating or side-effectful actions remain serial barriers.

Organism should adapt this at the Paperclip level:

- Parallelizable:
  - read files
  - grep/search
  - parse project configs
  - collect package metadata
  - run non-mutating status commands
  - fetch dashboard state
  - load memory/context
- Serial:
  - write files
  - dispatch tasks
  - update DB status
  - run tests/builds that mutate caches unless isolated
  - deploy
  - commit/push/open PR

Recommendation:

- Add `ActionEffect = read_only | local_mutation | external_mutation | approval_required`.
- Let read-only phases fan out and merge into a single context bundle before model invocation.
- Keep Paperclip as the only scheduler/orchestrator. PraisonAI remains a restricted tool provider.

Source:

- Warp action parallel policy: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/blocklist/action_model/execute.rs#L102-L116
- Warp read-only action grouping: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/blocklist/action_model/execute.rs#L390-L408

### 6. Harness Abstraction for CLI Agents

Warp treats third-party CLI agents as harnesses. The inspected source supports harness concepts for Claude, OpenCode, Gemini, Oz, and unknown future harnesses. It handles harness mismatch on resume, harness-specific payload rehydration, auth secrets, plugin setup, periodic saves, final saves, and cleanup.

Organism already has `CodeExecutorKind = 'claude' | 'codex'`, Codex-first selection, cooldowns, and optional legacy Claude fallback. It should evolve this into a harness abstraction without letting the harness orchestrate.

Recommendation:

- Introduce `ExecutorHarness`:
  - `codex-cli`
  - `claude-cli` only when legacy fallback enabled
  - future `gemini-cli`, `opencode`, etc.
- Each harness owns:
  - availability check
  - version/path
  - prompt invocation
  - output extraction
  - timeout strategy
  - resume payload if supported
  - secret names required
  - failure classification
- Paperclip still owns task creation, scheduling, retries, gates, and review pipeline.

Source:

- Warp harness config on task snapshot: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/ambient_agents/task.rs#L66-L123
- Warp harness driver details: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_sdk/driver.rs#L1424-L1606
- Organism current executor: `packages/core/src/code-executor.ts`

### 7. MCP Config Parsing and Validation

Warp has a robust MCP config normalization layer. It accepts common user JSON, recognizes config-file wrappers, supports Codex TOML normalization, templatizes env/header values, and stores variable placeholders instead of raw values.

Organism's PraisonAI sidecar must remain restricted to exactly five tools by rule. Still, the config hygiene pattern is valuable:

- strict schema normalization
- secret-value templating/redaction
- explicit transport types
- clear validation errors
- no silent acceptance of malformed maps

Recommendation:

- Do not broaden PraisonAI's tools.
- Do adapt Warp-like validation for any future MCP/server config:
  - reject unknown top-level keys unless explicitly allowed
  - require exactly one transport kind
  - require string maps for env/headers
  - store secret names/placeholders, not values
  - include config hash in run snapshot

Source:

- Warp MCP normalization and Codex TOML support: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/mcp/parsing.rs#L19-L180
- Warp templating/redaction flow: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/mcp/parsing.rs#L236-L353
- Organism sidecar boundary test: `packages/core/src/sidecar-boundary.test.ts`

### 8. Agent Management Filters and Display Status

Warp's agent conversation model includes filters by owner, status, source, creator, artifact, created-on, environment, and harness. It also distinguishes task status from conversation status and computes a user-facing display status.

Organism dashboard should borrow this UX structure. Today Organism has a lot of state, but the dashboard can still blur causes: stale daemon, blocked run, retry scheduled, source mismatch, task-level failure, run-level failure, etc.

Recommendation:

- Add dashboard filters:
  - project
  - owner/source
  - workflow
  - status
  - risk lane
  - review state
  - executor/harness
  - artifact kind
  - retry class/provider failure
- Add a derived `displayStatus` and `displayReason`.
- Make stale snapshot, daemon stale, DB write blocked, and auth missing visibly different states.

Source:

- Warp agent filters and display status: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/agent_conversations_model.rs#L35-L183

### 9. Codebase Context: Repo Metadata + Search

Warp has a layered codebase context design: repository metadata, outlines, full-source embedding feature flag, search requests keyed by action IDs, abort handles, and fallback behavior when indexing is missing/pending/failed.

Organism's agents currently rely on direct repo reads, searches, project memory, and model context. A Warp-like context controller would reduce redundant file reads and make dashboard explanations better.

Recommendation:

- Add a per-run `ContextController`:
  - repo root detection
  - indexed/not-indexed status
  - read-only file search
  - action-scoped request IDs
  - abort/cancel support
  - "context unavailable" reason codes
- Start simple with file glob/search plus cache. Defer embeddings until the state model is clean.

Source:

- Warp relevant files controller: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/get_relevant_files/controller.rs#L1-L260
- Warp search executor: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/app/src/ai/blocklist/action_model/execute/search_codebase.rs#L1-L260
- Warp repo metadata crate: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/crates/repo_metadata/src/lib.rs#L1-L150

### 10. Repo-Native Skills and Workflows

Warp ships repo-native `.agents/skills` and `.warp/workflows`. The strong pattern is not the exact content, but the operational posture: repeatable agent recipes live with the repository and are part of review.

Organism already has agents, AGENTS.md, project configs, quality rules, and skills in this Codex environment. It should formalize a project-local workflow system:

- `.agents/skills` or `knowledge/projects/<project>/skills`
- `knowledge/projects/<project>/workflows`
- workflow metadata: name, description, command/steps, required approvals, allowed project/actions
- audited workflow invocation artifacts

Recommendation:

- Add a first-class `WorkflowRecipe` type in Organism.
- Map current `WorkflowKind` to optional concrete recipes.
- Let dashboard show "this run used workflow recipe X at version/hash Y."

Source:

- Warp spec-driven skill: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/.agents/skills/spec-driven-implementation/SKILL.md
- Warp tech spec skill: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/.agents/skills/write-tech-spec/SKILL.md
- Warp workflow example: https://github.com/warpdotdev/warp/blob/d0f045c01bacbd845a631d07da30f277cfd2b98d/.warp/workflows/start_new_task.yaml

## What Organism Should Avoid

### Avoid Replacing Paperclip with Warp

This would violate Organism's core orchestration rule. PraisonAI remains a tool provider, and Warp should not become an orchestrator either.

Organism's unique value is governed autonomy: project policy, G1-G4 gates, Shape Up boundaries, audit log, task DB, dashboard, and project memory. Warp does not replace that; it can only improve the execution/interaction layer.

### Avoid Copying AGPL Code

Do not paste Warp implementation into Organism. Recreate the ideas.

The only narrow exception is if we later intentionally use MIT-licensed `warpui`/`warpui_core`, but that is not attractive for a TypeScript/Next dashboard.

### Avoid a Rust Rewrite

Warp's Rust architecture is excellent for a terminal emulator. Organism's TypeScript/Node architecture is better aligned with:

- Next/Vercel dashboard
- local SQLite state
- project JSON policies
- CLI orchestration scripts
- rapid agent/runtime iteration

A Rust rewrite would delay the work that actually matters: cleaner state, safer permissions, better executor harnesses, and better dashboard explanations.

### Avoid Terminal-First UX as the Main Dashboard

Warp is terminal-native. Organism's primary UX should remain operational: projects, goals, runs, blocked states, risk, review gates, deploy readiness, and audit trails.

However, a terminal/session view can be a powerful detail panel for a run.

### Avoid Broad MCP Expansion

Warp is more general-purpose around MCP. Organism has a deliberate boundary: PraisonAI exposes exactly five sanctioned tools and must never create/schedule tasks or call other agents.

Adapt validation and templating, not a wider tool surface.

## What Should Stay Unchanged in Organism

- Paperclip remains the only orchestrator.
- PraisonAI sidecar remains restricted to the five-tool provider contract.
- OpenAI/Codex-first model discipline remains the default.
- Risk-based review pipeline remains canonical:
  - LOW: Quality Agent -> auto-ship
  - MEDIUM: Quality Agent -> Codex Review -> auto-ship
  - HIGH: Quality Agent -> Codex Review -> Quality Guardian -> G4 approval
- Canonical state remains under `$HOME/.organism/state`, with SQLite and audit logs.
- Project policy and autonomy mode remain project-scoped and dashboard-visible.
- Dashboard remains the control plane, not just a terminal wrapper.

## Proposed Organism Roadmap

### Phase 1: State and Provenance

Goal: make every run explainable.

- Add config snapshot storage.
- Add derived display status and first-class blocked/error/claimed semantics.
- Add reason codes to runtime gate results.
- Include policy hash, executor selection, sidecar mode, model profile, and workflow recipe hash in run detail.

Expected impact: fixes a large share of "why is the dashboard saying this?" confusion.

### Phase 2: Run Driver

Goal: one run lifecycle instead of scattered implicit phases.

- Add `run-driver.ts`.
- Convert executor setup, sidecar routing, workspace checks, secret checks, run steps, and final artifact capture into deterministic phases.
- Emit structured runtime events for each phase.

Expected impact: safer retries, clearer failures, less accidental broad dispatch.

### Phase 3: Permission and Effect Model

Goal: make autonomy explainable and safe.

- Add `ActionEffect`.
- Add typed permission reason codes.
- Add redirection/destructive command classification.
- Add protected paths for config/secrets/state.
- Parallelize read-only context gathering; serialize mutation.

Expected impact: better safety without making the system timid.

### Phase 4: Harness Layer

Goal: make Codex/Claude/future CLI execution interchangeable but governed.

- Replace raw `CodeExecutorKind` branching with `ExecutorHarness`.
- Keep Codex first.
- Preserve legacy Claude as explicit opt-in.
- Store harness/version/path/failure class in run snapshot.

Expected impact: robust execution and cleaner future expansion.

### Phase 5: Dashboard Product Work

Goal: bring Warp's agent-management clarity into Organism's operational dashboard.

- Add project/workflow/status/source/risk/executor/artifact filters.
- Show blocked reason, retry class, stale state, daemon freshness, and required next action separately.
- Make artifacts first-class: plan, patch, command log, report, verification, deployment.

Expected impact: the dashboard becomes a reliable control room rather than a pile of task rows.

### Phase 6: Repo-Native Workflow Recipes

Goal: make agent workflows reviewable.

- Add project-local workflow recipe schema.
- Hash recipe content into run snapshots.
- Add "used recipe" display to dashboard.
- Convert recurring manual procedures into recipes.

Expected impact: better repeatability and agent handoff quality.

## Decision Matrix

| Question | Recommendation |
| --- | --- |
| Should Organism migrate to Warp? | No. |
| Should Organism integrate with Warp as a developer console? | Maybe later, but not as a prerequisite. |
| Should Organism copy Warp code? | No, because most of the repo is AGPL. |
| Should Organism adapt Warp's run state/config snapshot model? | Yes, high priority. |
| Should Organism adapt Warp's permission reason taxonomy? | Yes, high priority. |
| Should Organism adapt Warp's read-only parallel action phase? | Yes, high priority. |
| Should Organism adopt Warp's terminal/session substrate? | Partially, as an executor detail panel or harness concept. |
| Should Organism adopt Warp's repo-native skills/workflows pattern? | Yes, with Organism's own schema and gates. |
| Should Organism broaden PraisonAI MCP tools to match Warp flexibility? | No. |

## Bottom Line

Warp is a rich reference for the "agentic development environment" layer. Organism should not become Warp, but it should learn from Warp's discipline around:

- run snapshots
- typed task states
- harness lifecycle
- permission reasons
- read-only parallelism
- MCP config hygiene
- agent management filters
- repo-native skills/workflows

The highest-leverage Organism change is a Paperclip-owned `RunDriver` with immutable config snapshots and typed permission/effect decisions. That gives Organism most of Warp's runtime maturity while preserving Organism's real advantage: governed, project-aware orchestration.
