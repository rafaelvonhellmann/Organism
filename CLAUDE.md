# Organism — Root Session Instructions

## What This Is

Organism is a multi-agent orchestration system that reviews, builds, and evolves Rafael's projects. Output is persistent, linked markdown in an Obsidian vault — files over apps. Rafael is the human-in-the-loop: Organism proposes, Rafael approves.

## Terminology

Organism uses **agents**, not "perspectives". Every agent is defined by a row in `knowledge/capability-registry.json` (`owner` field) and has a concrete implementation class in `packages/core/src/agent-runner.ts` (`AGENT_MAP`). The registry and the AGENT_MAP must stay in sync — `checkRegistryCoherence()` runs at daemon startup and prints drift.

Earlier notes and roadmaps used the term "perspectives" while the code shipped agents. Treat the two words as equivalent for historical context, but new docs should say "agent". The `perspectives` CLI remains as an alias for on-demand multi-agent reviews.

## Core Engine

**Paperclip** (`packages/core/`) is the orchestrator. It owns:
- Task creation, checkout, assignment, completion
- Budget accounting (daily caps + per-task hard caps + mid-flight freeze at 95%)
- Gate evaluation (G1-G4)
- Agent lifecycle (activate, shadow, suspend)
- Audit log writes
- Capability registry reads
- All scheduling decisions

## Phase 1 Active Agent Set (stabilization)

The phase 1 roster while the autonomy governor graduates:

| Agent | Role |
|---|---|
| `ceo` | Strategy, delegation, report compilation |
| `product-manager` | PRDs, prioritization |
| `engineering` | Code writing, fixes, deploys |
| `quality-agent` | Autoresearch review |
| `domain-model` (legacy alias `grill-me`) | Socratic challenge before execution |
| `codex-review` | OpenAI second-opinion lane |
| `synthesis` | Consolidates findings into one report |
| `medical-content-reviewer` | Synapse-only specialist (HIGH lane) |

All other agents live in the registry as `status: "suspended"` or `status: "shadow"`. Regrow the roster only after:
- 3 consecutive healthy goals per project (governor rule)
- 7 days of green daemon uptime
- Zero silent-failure completions

## Commands

| Command | What it does |
|---|---|
| `pnpm start` | Start the daemon (runs scheduler + agent runner + lifecycle ticks) |
| `npm run clear-stuck [-- --dry-run]` | Mark orphaned in_progress/paused/awaiting_review tasks failed |
| `npm run health-check` | Preflight: backend, secrets, DB, registry |
| `npm run organism "perspectives <project>"` | Ad-hoc multi-agent review of a project (alias kept) |
| `npm run organism "onboard <name>"` | Onboard a new project into the vault |
| `npm run organism "palate list"` | Show registered knowledge sources + fitness |
| `npm run organism "palate stats"` | Injection telemetry |
| `npm run organism "palate add <path> tags"` | Register a knowledge source (unapproved) |
| `npm run organism "palate approve <id>"` | Approve source for injection |
| `npm run organism "rate <page> <1-5>"` | Rate a wiki page |
| `pnpm --filter dashboard dev` | Start dashboard on port 7391 |

## Palate (Knowledge Injection)

The Palate (`packages/core/src/palate.ts`) injects capability-scoped knowledge into every task automatically. When a task matches a capability in `knowledge/capability-registry.json`, the Palate:

1. Resolves which `knowledgeSources` apply (by capability + project)
2. Distills each source via Haiku to ~30% of original tokens (cached by content hash)
3. Injects distilled content into `task.input.knowledgeSources`
4. Logs injection telemetry (`source_injection` audit entries)

Sources beyond the registry live in `knowledge/palate/sources.json`. All new sources require explicit approval. The `palate-wiki` agent (shadow mode) writes wiki pages from sources; Rafael rates them; ratings propagate to source fitness.

## File-Over-App Philosophy

All knowledge output is plain markdown in the Obsidian vault. No proprietary formats, no databases for human-readable content. The vault is the source of truth for analysis, findings, and decisions. Files link with `[[wikilinks]]`.

## Risk-Based Review Pipeline

Every task is classified by `packages/core/src/risk-classifier.ts`. The Phase 1 collapsed pipeline:

- **LOW** (50%): auto-ship after agent completes
- **MEDIUM** (35%): `quality-agent` → auto-ship on pass
- **HIGH** (15%): `domain-model` → `quality-agent` → Rafael G4 gate

Legal / copyright / security-audit / quality-guardian agents are currently suspended and do NOT fire on the live path. They return as on-demand commands after graduation.

## Budget Controls

- **Daily per-agent cap** (`budget.ts`): hard freeze at 95%, runner stops dispatching to that agent for the rest of the day
- **Per-task hard cap by lane**: LOW $0.25 / MEDIUM $1.00 / HIGH $3.00 (overrides for reviewers: `quality-guardian` $4, `legal` $3, `security-audit` $3, `medical-content-reviewer` $2, `perspectives` $5)
- **Overrun audit**: clamped spend is logged as `budget_overrun` in `audit_log` so true cost is recoverable
- **Silent-failure guard**: $0 + empty output → task marked `failed` with E305 `PROVIDER_EMPTY_OUTPUT` (prevents the governor from counting stubs as healthy runs)

## Shadow Mode

No new agent goes live without shadow mode promotion:
1. Register as `status: 'shadow'` in `knowledge/capability-registry.json`
2. Run 10 shadow tasks (logged to `shadow_runs` and mirrored to `~/.organism/state/shadow-runs.jsonl`)
3. Run `scripts/shadow-promote.ts` after quality threshold is met
4. Agent becomes `status: 'active'`

## Autonomy Governor

`packages/core/src/autonomy-governor.ts` tracks per-project health:
- `consecutiveHealthyRuns` counts contiguous green goals in the last 7 days
- Provider failures older than 7 days decay and do NOT block graduation
- Stages: `stabilizing` → `bounded` (1 green) → `deploy_ready` (2 green) → `graduated` (3 green)
- Blockers list is published to `daemon-status.json` and surfaced on the dashboard

## Observability

`daemon-status.json` includes:
- `observability.recentErrors` — top 10 failure patterns in last 24h
- `observability.silentFailures24h` — E305 count today
- `observability.dispatchLag` — p50/p95/max time from task creation to checkout
- `observability.capLocks` — agents currently frozen by daily cap

Check these before grep'ing logs.

## Error Handling

All errors use `OrganismError` codes from `packages/shared/src/error-taxonomy.ts`. Every error logged to `audit_log` with: error code, task ID, agent, full context, recovery action.

## Engineering Git Rules

- Feature branches only: `organism/<task-id>/<slug>`
- All commits prefixed `[organism]`
- No `git push --force`, `git reset --hard`, `git commit --amend`
- Cannot merge PRs — G4 gate only
- Shadow checkpoints every 30 minutes to `shadow/<task-id>`

## Secrets

Never commit secrets. Never hardcode API keys. Load via `packages/shared/src/secrets.ts`. Each agent's config declares required secrets in a `## Required Secrets` section.

## Session Start Protocol

At the start of every session:

1. Read the last 5 audit log entries:
   ```sql
   SELECT * FROM audit_log WHERE agent = ? ORDER BY ts DESC LIMIT 5
   ```
2. **Check the project tasklist** — before acting on any task, read its master tasklist. Look for (in order):
   - `tasks/master_tasklist.md`
   - `TASKLIST.md`
   - `tasks/todo.md`
   - `.ai/tasklist.md`
   - `TODO.md`
   The tasklist is ground truth. If your task contradicts the tasklist, flag it before proceeding.
3. For Synapse specifically: `C:/Users/rafae/OneDrive/Desktop/synapse/tasks/master_tasklist.md`

## Token Discipline

- No preamble. No summaries of what you just did.
- Lead with the action or answer, not the reasoning.
- Be terse. One sentence where possible.
- Don't add features, error handling, or abstractions beyond what was asked.

## Investigation Before Opinion

Every agent must investigate before giving an opinion:
- Read the actual code, not just the task description
- Check the project tasklist for what's already done or in progress
- Verify claims by looking at real files, not assuming from summaries
- Research the internet when external knowledge is needed
- Never flag a problem without checking if it's already been addressed

## Problem + Solution Format (mandatory)

Every finding must include BOTH:
1. **PROBLEM:** What is wrong, with evidence (file path, line number, actual code)
2. **SOLUTION:** Concrete fix with implementation steps Rafael can execute

Findings without solutions are noise.
