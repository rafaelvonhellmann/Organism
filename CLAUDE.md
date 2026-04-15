# Organism — Root Session Instructions

## What This Is

Organism is a living knowledge system. It applies domain perspectives in parallel to analyse, build, and evolve projects. Output is persistent, linked markdown in an Obsidian vault — files over apps. Rafael is the human-in-the-loop: Organism proposes, Rafael approves.

## Core Engine

**Paperclip** (`packages/core/`) is the orchestrator. It owns:
- Task creation, checkout, assignment, completion
- Budget accounting and hard caps
- Gate evaluation (G1-G4)
- Perspective lifecycle (activate, suspend, dormant)
- Audit log writes
- Capability registry reads
- All scheduling decisions

## Perspectives, Not Agents

Organism uses **perspectives** — domain lenses that analyse work through a specific competency (e.g. `security`, `architecture`, `pharmacology`, `cost`). Perspectives:
- Run in **parallel**, not through a serial hierarchy
- Each selects its own model (no central routing table)
- Write findings to the **Obsidian vault** as linked markdown (`vault/<project>/`)
- Evolve through **Darwinian fitness**: perspectives that produce value are prioritised; useless ones go dormant automatically
- **Ask questions** when uncertain instead of assuming
- **Research the internet** before forming opinions

## Commands

| Command | What it does |
|---|---|
| `npm run organism "perspectives <project>"` | Run all active perspectives against a project |
| `npm run organism "onboard <name>"` | Onboard a new project into the vault |
| `npm run organism "palate list"` | Show registered knowledge sources + fitness |
| `npm run organism "palate stats"` | Injection telemetry (token savings, cache hits) |
| `npm run organism "palate add <path> tags"` | Register a knowledge source (unapproved) |
| `npm run organism "palate approve <id>"` | Approve source for injection |
| `npm run organism "rate <page> <1-5>"` | Rate a wiki page (feeds Darwinian fitness) |
| `pnpm --filter dashboard dev` | Start dashboard on port 7391 (shows capability domains, not an org chart) |

## Palate (Knowledge Injection)

The Palate (`packages/core/src/palate.ts`) injects capability-scoped knowledge into every task automatically. When a task matches a capability in `knowledge/capability-registry.json`, the Palate:

1. Resolves which `knowledgeSources` apply (by capability + project, not agent name)
2. Distills each source via Haiku to ~30% of original tokens (cached by content hash)
3. Injects distilled content into `task.input.knowledgeSources`
4. Logs injection telemetry (`source_injection` audit entries)

Sources beyond the registry live in `knowledge/palate/sources.json`. All new sources require explicit approval before injection. The `palate-wiki` agent (shadow mode) writes wiki pages from sources; Rafael rates them; ratings propagate to source fitness via Darwinian decay.

Key files: `palate.ts` (resolution + distillation), `palate-sources.ts` (registry CRUD + fitness), `palate-ratings.ts` (connoisseur loop), `agents/palate-wiki/agent.ts`.

## File-Over-App Philosophy

All knowledge output is plain markdown in the Obsidian vault. No proprietary formats, no databases for human-readable content. The vault is the source of truth for analysis, findings, and decisions. Files link to each other with `[[wikilinks]]`.

## Risk-Based Review Pipeline

Every task is classified by `packages/core/src/risk-classifier.ts`:

- **LOW** (50%): Quality Agent pipeline -> auto-ship
- **MEDIUM** (35%): Grill-Me -> Quality Agent -> Codex Review -> auto-ship
- **HIGH** (15%): Grill-Me -> Quality Agent -> Copyright -> Legal -> Security -> Quality Guardian -> Codex Review -> G4 Gate (Rafael approves)

## Shadow Mode

No new perspective goes live without shadow mode promotion:
1. Register as `status: 'shadow'` in `knowledge/capability-registry.json`
2. Run 10 shadow tasks (logged to `shadow_runs` and mirrored to `~/.organism/state/shadow-runs.jsonl`)
3. Run `scripts/shadow-promote.ts` after quality threshold is met
4. Perspective becomes `status: 'active'`

## Error Handling

All errors use `OrganismError` codes from `packages/shared/src/error-taxonomy.ts`. Every error logged to `state/audit.log` with: error code, task ID, perspective, full context, recovery action.

## Engineering Git Rules

- Feature branches only: `organism/<task-id>/<slug>`
- All commits prefixed `[organism]`
- No `git push --force`, `git reset --hard`, `git commit --amend`
- Cannot merge PRs — G4 gate only
- Shadow checkpoints every 30 minutes to `shadow/<task-id>`

## Secrets

Never commit secrets. Never hardcode API keys. Load via `packages/shared/src/secrets.ts`. Each perspective's config declares required secrets in a `## Required Secrets` section.

## Session Start Protocol

At the start of every session:

1. Read the last 5 audit log entries:
   ```sql
   SELECT * FROM audit_log WHERE perspective = ? ORDER BY ts DESC LIMIT 5
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

Every perspective must investigate before giving an opinion:
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
