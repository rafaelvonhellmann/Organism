# Organism — Root Session Instructions

## What This Is

Organism is a fully autonomous multi-agent company orchestration system. Rafael is the board member who reviews outputs at G4 gates. All other decisions are made autonomously.

## The Single Most Important Rule

**Paperclip is the ONLY orchestrator. PraisonAI is a restricted tool provider.**

Paperclip (`packages/core/`) owns:
- Task creation, checkout, assignment, completion
- Budget accounting and hard caps
- Gate evaluation (G1-G4)
- Agent lifecycle (start, stop, suspend)
- Audit log writes
- Capability registry reads
- All scheduling decisions

PraisonAI (`packages/mcp-sidecar/`) exposes exactly 5 MCP tools:
1. `route_model(prompt, model_preference)` → LLM response
2. `rag_retrieve(query, k)` → ranked context chunks
3. `check_policy(action, context)` → pass/fail + reason
4. `detect_doom_loop(call_sequence)` → signal + evidence
5. `persist_memory(fact, graph_context)` → confirmation

PraisonAI never creates tasks, writes to the budget, or calls another agent. If it tries, `OrganismError.MCP_CONTRACT_VIOLATION` is thrown and logged.

## Before Running Any Agent

1. Start the dashboard: `pnpm --filter dashboard dev` (port 7391)
2. Confirm dashboard shows "all agents: idle"
3. Verify `state/tasks.db` exists (run migrations if not)
4. Then and only then run agents

## Agent Communication

- Agents never talk to each other directly
- All inter-agent work goes through Paperclip's orchestrator (hub-and-spoke)
- A2A protocol is only used as a message format, not a mesh

## Risk-Based Review Pipeline

Every task is classified by `packages/core/src/risk-classifier.ts`:

- **LOW** (50%): Quality Agent → auto-ship
- **MEDIUM** (35%): Grill-Me → Quality Agent → Codex Review → auto-ship
- **HIGH** (15%): Grill-Me → Quality Agent → Copyright → Legal → Security → Quality Guardian → Codex Review → G4 Board Gate

## Model Routing

- **Haiku**: risk classification, routing only
- **Sonnet 4.6**: all agents by default (planning, execution, quality, strategy, code)
- **Opus 4.6**: Quality Guardian ONLY
- **GPT-4o**: Codex Review ONLY (one API call, not a full agent session)

## Shadow Mode

No new agent goes live without shadow mode promotion:
1. Register agent as `status: 'shadow'` in `knowledge/capability-registry.json`
2. Run 10 shadow tasks (output discarded, logged to `state/shadow-runs.jsonl`)
3. Run `scripts/shadow-promote.ts` after quality threshold is met
4. Agent becomes `status: 'active'`

## Error Handling

All errors use `OrganismError` codes from `packages/shared/src/error-taxonomy.ts`. Every error logged to `state/audit.log` with: error code, task ID, agent, full context, recovery action.

## Engineering Agent Git Rules

- Feature branches only: `agent/engineering/<task-id>/<slug>`
- All commits prefixed `[agent]`
- No `git push --force`, `git reset --hard`, `git commit --amend`
- Cannot merge PRs — G4 gate only
- Shadow checkpoints every 30 minutes to `shadow/<task-id>`

## Secrets

Never commit secrets. Never hardcode API keys. Load via `packages/shared/src/secrets.ts`. Each agent's `CLAUDE.md` declares required secrets in a `## Required Secrets` section.

## Session Start Protocol

At the start of every agent session:

1. Read the last 5 audit log entries for that agent:
```sql
SELECT * FROM audit_log WHERE agent = ? ORDER BY ts DESC LIMIT 5
```

2. **Check the project tasklist** — before acting on any task for a known project, read its master tasklist if one exists. Look for these files in the project directory (in order):
   - `tasks/master_tasklist.md`
   - `TASKLIST.md`
   - `tasks/todo.md`
   - `.ai/tasklist.md`
   - `TODO.md`

   The tasklist is ground truth for what is done, in progress, and pending. Never rely on context alone — the tasklist has the real DB state, completed sessions, and current priorities. If your task description contradicts the tasklist, flag it before proceeding.

3. For Synapse specifically: `C:/Users/rafae/OneDrive/Desktop/synapse/tasks/master_tasklist.md`

## Token Discipline

- No preamble. No summaries of what you just did.
- Lead with the action or answer, not the reasoning.
- Be terse. One sentence where possible.
- Don't add features, error handling, or abstractions beyond what was asked.

## Investigation Before Opinion

Every agent must investigate before giving an opinion. This means:
- Read the actual code, not just the task description
- Check the project tasklist for what's already done or in progress
- Verify claims by looking at real files, not assuming from summaries
- Never flag a problem without checking if it's already been addressed

## Problem + Solution Format (mandatory)

Every finding must include BOTH:
1. **PROBLEM:** What is wrong, with evidence (file path, line number, actual code)
2. **SOLUTION:** Concrete fix with implementation steps Rafael can execute

Findings without solutions are not findings — they are noise. An agent that says "copyright is a risk" without checking if a copyright audit already exists is wasting Rafael's time.
