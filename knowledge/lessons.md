# Organism — Lessons Learned

Running log of what went wrong, what was surprising, and what fixed it.
Updated after every smoke test and major incident.

---

## Week 1 — Bootstrap

**2026-04-04:** Initial architecture established.

Key decisions and why:
- **Monorepo over multi-repo**: Eliminates version drift between packages. One audit log, one dashboard.
- **Paperclip-only orchestration contract**: Written into both CLAUDE.md and enforced in code via MCPContractViolationError. Prevents the split-brain failure Codex warned about.
- **SQLite over external DB**: Local-first, zero infra dependencies, WAL mode for concurrent reads. Can migrate to Postgres later if needed.
- **Dashboard before agents**: The dashboard reads `state/tasks.db` and is the first thing started. You cannot debug a multi-agent system you cannot see.
- **Shadow mode for all new agents**: No agent goes live without 10 shadow runs above the quality threshold. Prevents 3am surprises.
- **Quality Guardian CLAUDE.md = quality-guardian-agent.md + Organism scope**: The Guardian spec is authoritative and unchanged; Organism-specific audit areas are appended so the spec can be updated independently.
- **Codex Review as single GPT-4o call, not a full agent**: Saves $0.50-1.00 per invocation vs a full agent session. Faster, more predictable.
- **CEO CLAUDE.md sets first mission = Synapse**: Prevents documentation paralysis. Week 1 agents have real tasks to work on immediately.
- **Telegram as G4 gate**: Rafael already uses Telegram for Claude Code. No separate board approval UI needed.

**Smoke test: PASSED — 2026-04-04**

Results:
- Full LOW pipeline: submit → CEO (Sonnet) → Quality Agent (Sonnet) → completed
- Cost: $0.0087 total (CEO $0.0030 + QA $0.0057)
- Audit trail: 4 entries, complete trace
- Mission statement generated and quality-approved in ~4 seconds

Issues hit during bootstrap:
- `better-sqlite3` won't compile on Node 24 Windows — switched to `node:sqlite` (built-in, Node 22.5+). Add `--experimental-sqlite` to all scripts.
- `.secrets.json` must be valid JSON `{"ANTHROPIC_API_KEY": "..."}` — raw key value in file causes parse failure.
- `agent_spend` PRIMARY KEY change (added `project_id`) requires full table drop + recreate — SQLite ALTER TABLE cannot change PKs. On existing DBs, drop `state/tasks.db` and re-run `npm run migrate`.
- `agent-runner.ts` import paths: from `packages/core/src/`, agents are 3 levels up (`../../../agents/`), not 2.
- `CREATE INDEX ON tasks(project_id)` must be in the additive migrations block (try/catch), not in the main `CREATE TABLE` exec — the column doesn't exist on old tables yet when the batch runs.

---

---

## Week 2 — MEDIUM Lane + Engineering + Domain Model

**2026-04-04: MEDIUM lane test PASSED**

Full pipeline: submit → Domain Model (DDD-style interrogation) → primary agent → Quality Agent review. Cost: $0.0284.

Key decisions:
- **Domain Model runs pre-execution, not post**: interrogates task description/approach before the primary agent touches anything. Produces a shaping review attached to the real task's input.
- **MEDIUM tasks route to Domain Model at orchestrator level**: the orchestrator wraps the real task into a domain-model task with `intendedAgent` in the input. Domain Model creates the real agent task after the review.
- **G1 gate wired into BaseAgent**: runs automatically after every task completion. Records gate result to SQLite. `testsPassed` defaults to true until a test runner is wired (Week 3).
- **Engineering in shadow mode**: `resolveOwner` only returns active agents, so engineering tasks fall back to CEO until engineering is promoted via `scripts/shadow-promote.ts`. This is intentional — shadow mode means proven before trusted.

Issues hit:
- `.secrets.json` was corrupted with extra content after the JSON closing brace. Fix: read raw → extract `{...}` boundaries → rewrite. Add a secrets file validator to `scripts/health-check.ts`.
- MEDIUM lane classification: the Haiku classifier correctly classified "Add a /health endpoint..." as MEDIUM. The heuristic fallback (when secrets are broken) incorrectly returns LOW. This confirms: broken secrets = incorrect classification. Fix secrets first, always.

Next for engineering to receive tasks:
1. Run 3 shadow tasks manually to populate `state/shadow-runs.jsonl`
2. Run `npm run shadow-promote -- --agent engineering` once quality scores are above threshold
3. Engineering will then appear in `resolveOwner` results and receive MEDIUM engineering tasks directly

_Add new entries below as incidents and lessons accumulate._
