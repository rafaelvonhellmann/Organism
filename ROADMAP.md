# Organism Roadmap

Last updated: 2026-04-07

## Completed

| Phase | What | Goal | Shipped |
|-------|------|------|---------|
| 1 | Flat Perspective Engine | Replace serial org-chart with parallel perspectives | 2026-04-05 |
| 2 | Obsidian Knowledge Output | Vault writes with wikilinks, frontmatter | 2026-04-06 |
| 3 | Project Onboarding | 8-12 question interview → VISION.md + config | 2026-04-06 |
| 4 | Internet Research | Web search before opinions, cached as markdown | 2026-04-06 |
| 10 | Palate Knowledge Injection | Capability-scoped source injection, Haiku distillation, 66% token savings | 2026-04-07 |

## In Progress

### Phase 5: Darwinian Evolution
**Goal:** Perspectives that produce value get prioritised; useless ones go dormant automatically. No manual curation.
**Success metric:** After 3 review runs, at least 2 perspectives auto-dormant and review cost drops 20%.
**Target:** 2026-04-14

| Task | Status |
|------|--------|
| Fitness tracking in `perspective_fitness` table | Done (schema exists, perspectives.ts writes to it) |
| Auto-dormancy threshold (fitness < 0.2 → suspended) | Not wired |
| Rating CLI (`npm run organism "rate <perspective> <1-5>"`) | Palate has this for sources; extend to perspectives |
| Fitness visible on dashboard `/evolution` page | Done |

### Phase 7: Dashboard Redesign
**Goal:** Dashboard shows project health and capability domains, not an org chart. Rafael can review, approve, and rate from the browser.
**Success metric:** Rafael uses the dashboard daily without needing CLI for reviews/approvals.
**Target:** 2026-04-21

| Task | Status |
|------|--------|
| Review queue with full output rendering | Fixing now |
| Sticky action bar (approve/dismiss/skip) | Fixing now |
| Task detail page with complete output | Fixing now |
| Palate page (sources, stats, wiki ratings) | Done |
| Project-centric navigation (not agent-centric) | Not started |
| Inline markdown rendering for task outputs | Not started |

---

## Upcoming

### Phase 5b: Cost Optimization
**Goal:** Full Synapse review under $20 (down from $54). Zero wasted spend.
**Success metric:** `npm run organism "review synapse"` completes under $20 with all agents producing useful output.
**Target:** 2026-04-10

| Task | Status |
|------|--------|
| Security-audit overspend cap ($3/task, trigger tightening) | Fixing now |
| PM revision loop cap (max 2 iterations) | Fixing now |
| Codex review graceful skip when no API key | Fixing now |
| StixDB 422 silenced | Fixing now |
| Re-run review and measure | Blocked on fixes |

### Phase 6: Question-Asking During Execution
**Goal:** When a perspective is uncertain, it asks Rafael via Telegram instead of guessing. Reduces hallucination and wasted work.
**Success metric:** At least 1 question asked per review run; Rafael answers via Telegram; answer improves output quality.
**Target:** 2026-04-21

| Task | Status |
|------|--------|
| Telegram bot integration (MCP bridge) | Configured (bot exists) |
| Uncertainty detection in BaseAgent | Not started |
| `askRafael()` function with blocking wait | `clarify.ts` exists but not wired |
| Answer injected back into task | Not started |

### Phase 8: MCP Knowledge Bridge
**Goal:** Organism searches its own vault at runtime. Past findings inform new analysis. Knowledge compounds.
**Success metric:** A perspective cites a finding from a previous review in its output without being told to.
**Target:** 2026-05-05

| Task | Status |
|------|--------|
| Vault search MCP tool | Not started |
| Ingestion pipeline (new vault files → searchable index) | Not started |
| Self-improving graph (link discoveries back to vault) | Not started |

### Phase 9: Cabinet Mode
**Goal:** Organism runs autonomously on a schedule. Weekly reviews, daily health checks, monthly distillations — all without Rafael typing commands.
**Success metric:** Organism produces a weekly review and distillation for each project without manual intervention.
**Target:** 2026-05-19

| Task | Status |
|------|--------|
| Cron scheduler (beyond current `schedulerTick`) | Partial (scheduler exists, needs cron persistence) |
| Git-backed history (every review committed) | Not started |
| Web terminal (run commands from dashboard) | Not started |
| Auto-distillation (weekly knowledge synthesis) | `distillation.ts` exists, needs scheduling |

---

## Milestones

| Date | Milestone | How to verify |
|------|-----------|---------------|
| **2026-04-10** | Review under $20 | `npm run organism "review synapse"` → check cost in audit log |
| **2026-04-14** | Darwinian auto-dormancy live | After review, `palate list` shows fitness changes; `evolution` page shows suspended perspectives |
| **2026-04-21** | Dashboard is daily driver | Rafael reviews + approves from browser, not CLI |
| **2026-04-21** | Telegram Q&A live | Organism asks question during review, Rafael answers on phone |
| **2026-05-05** | Knowledge compounds | Perspective output cites previous vault findings |
| **2026-05-19** | Fully autonomous | Weekly review runs without any manual trigger |

---

## Cost Targets

| Run | Target | Actual |
|-----|--------|--------|
| Apr 6 review | — | $88.06 |
| Apr 7 review | < $60 | $54.37 (-38%) |
| Next review | **< $20** | Pending bug fixes |
| Steady state | **< $10/review** | After Darwinian dormancy prunes low-value perspectives |
