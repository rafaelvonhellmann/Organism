# Organism — Agent Instructions (Codex-Compatible)

## Orchestration Rule

Paperclip (`packages/core/`) is the only orchestrator. PraisonAI (`packages/mcp-sidecar/`) is a restricted MCP tool provider with exactly 5 tools. Never let PraisonAI create tasks, schedule work, or call other agents.

## Quality Pipeline

All output goes through the risk-based review pipeline:
- LOW: Quality Agent → auto-ship
- MEDIUM: Domain Model → Quality Agent → Codex Review → auto-ship
- HIGH: full pipeline → G4 Board Gate (Rafael approves)

## Model Discipline

- OpenAI is the default company runtime. Codex CLI is primary; OpenAI API is fallback.
- Legacy Claude/Anthropic backends are opt-in only via explicit environment override.
- Haiku profile maps to GPT-4o for routing/small interrogation work.
- Sonnet profile maps to GPT-5.4 for standard agent work.
- Opus profile maps to GPT-5.4 with deeper reasoning for Quality Guardian.
- Codex Review uses a dedicated OpenAI review profile, with Codex CLI using the CLI-compatible review model by default.

## New Agents

All new agents start as `status: 'shadow'` in `knowledge/capability-registry.json`. Shadow runs for 10 tasks before promotion via `scripts/shadow-promote.ts`.

## Code Rules

- TypeScript strict mode throughout
- All errors use `OrganismError` enum from `packages/shared/src/error-taxonomy.ts`
- All state in `state/tasks.db` (SQLite)
- Audit log is append-only JSONL at `state/audit.log`
- Never commit secrets — use `packages/shared/src/secrets.ts`

## Engineering Agent Rules

- Feature branches: `agent/engineering/<task-id>/<slug>`
- Commits prefixed `[agent]`
- No force push, no hard reset, no amend
- PRs only — cannot merge
