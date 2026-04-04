# Organism — Agent Instructions (Codex-Compatible)

## Orchestration Rule

Paperclip (`packages/core/`) is the only orchestrator. PraisonAI (`packages/mcp-sidecar/`) is a restricted MCP tool provider with exactly 5 tools. Never let PraisonAI create tasks, schedule work, or call other agents.

## Quality Pipeline

All output goes through the risk-based review pipeline:
- LOW: Quality Agent → auto-ship
- MEDIUM: Grill-Me → Quality Agent → Codex Review → auto-ship
- HIGH: full pipeline → G4 Board Gate (Rafael approves)

## Model Discipline

- Haiku for classification/routing only
- Sonnet 4.6 for all agent work by default
- Opus 4.6 for Quality Guardian only
- GPT-4o for Codex Review only (single API call)

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
