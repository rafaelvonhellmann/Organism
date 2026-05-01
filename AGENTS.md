# Organism — Agent Instructions (Codex-Compatible)

## Orchestration Rule

Paperclip (`packages/core/`) is the only orchestrator. PraisonAI (`packages/mcp-sidecar/`) is a restricted MCP tool provider with exactly 5 tools. Never let PraisonAI create tasks, schedule work, or call other agents.
Runtime model access goes through the PraisonAI sidecar contract first. The embedded sidecar transport is the current default runtime boundary; the Python sidecar transport is optional parity work, not a place for orchestration logic.

## Quality Pipeline

All output goes through the risk-based review pipeline:
- LOW: Quality Agent → auto-ship
- MEDIUM: Quality Agent → Codex Review → auto-ship
- HIGH: Quality Agent → Codex Review → Quality Guardian → G4 Board Gate (Rafael approves)

Domain Model is a shaping lane used before execution when a task needs extra framing, ADR guidance, or domain challenge work. It is not the canonical post-execution review gate.

## Model Discipline

- OpenAI is the default company runtime. Codex CLI is primary; OpenAI API is fallback.
- Legacy Claude/Anthropic backends are opt-in only via explicit environment override.
- Haiku profile maps to GPT-4o for routing/small interrogation work.
- Sonnet profile maps to GPT-5.4 for standard agent work.
- Opus profile maps to GPT-5.4 with deeper reasoning for Quality Guardian.
- Codex Review uses a dedicated OpenAI review profile, with Codex CLI using the CLI-compatible review model by default.

## New Agents

All new agents start as `status: 'shadow'` in `knowledge/capability-registry.json`. Promotion requires 10 shadow runs plus 10 scored shadow runs before `scripts/shadow-promote.ts` can move an agent to active.

## Code Rules

- TypeScript strict mode throughout
- All errors use `OrganismError` enum from `packages/shared/src/error-taxonomy.ts`
- Canonical runtime state lives in `$HOME/.organism/state` unless `ORGANISM_STATE_DIR` overrides it
- SQLite lives at `$STATE_DIR/tasks.db`
- Audit log is append-only JSONL at `$STATE_DIR/audit.log`, written through `packages/core/src/audit.ts`
- Never commit secrets — use `packages/shared/src/secrets.ts`

## Engineering Agent Rules

- Feature branches: `agent/engineering/<task-id>/<slug>`
- Commits prefixed `[agent]`
- No force push, no hard reset, no amend
- PRs only — cannot merge
