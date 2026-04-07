# Organism — Complete User Manual

> **If you're returning after a break:** Start at [Daily Session Checklist](#part-3-daily-operations). If something is broken, go to [Troubleshooting](#part-9-troubleshooting).

---

## Table of Contents

1. [What Is Organism](#part-1-what-is-organism)
2. [First-Time Setup](#part-2-first-time-setup)
3. [Daily Operations](#part-3-daily-operations)
4. [Submitting Tasks](#part-4-submitting-tasks)
5. [Managing Projects](#part-5-managing-projects)
6. [Creating and Managing Agents](#part-6-creating-and-managing-agents)
7. [The Knowledge Base](#part-7-the-knowledge-base)
8. [The Quality System](#part-8-the-quality-system)
9. [Troubleshooting](#part-9-troubleshooting)
10. [Cost Management](#part-10-cost-management)
11. [The 10-Week Rollout](#part-11-the-10-week-rollout)
12. [Quick Reference](#part-12-quick-reference)

---

## Part 1: What Is Organism

### The one-sentence version

Organism is your AI operations team — a collection of specialized agents that runs your projects 24/7, with you as the board member who approves critical decisions.

### The mental model

Think of Organism as a **holding company** with three layers:

```
YOU (Rafael)
└── Board member. Approves or rejects HIGH-risk decisions via Telegram.
    You never write code or content directly — you review and redirect.

ORGANISM CORE (packages/core/)
└── The governance spine. The ONLY thing that creates tasks, assigns agents,
    tracks budgets, and enforces quality gates. Nothing bypasses it.

AGENTS (agents/)
└── Specialized workers. Each has one job. They pick up tasks from the queue,
    do the work, return output, and go idle. They never talk to each other
    directly — everything goes through Organism Core.

PROJECTS (knowledge/projects/)
└── Everything agents need to know about each of your products.
    Synapse, Tokens for Good, new ideas — each gets its own scoped space.
```

### The three rules everything follows

1. **Paperclip governs.** `packages/core/` is the only orchestrator. The Python MCP sidecar (`packages/mcp-sidecar/`) is a tool provider — it routes LLM calls and stores memory, but it never creates tasks or makes decisions.

2. **Every task has a lane.** Before any agent touches a task, it's classified as LOW, MEDIUM, or HIGH risk. The lane determines which quality gates it passes through. You only see HIGH-risk tasks.

3. **Shadow before active.** Every new agent runs in silent mode for 10 tasks before it goes live. You never wake up to a broken agent that went rogue overnight.

### What you will and won't do

| You do | Organism does |
|---|---|
| Approve/reject HIGH-risk decisions via Telegram | Everything else |
| Add new projects (30-minute checklist) | Run the projects |
| Create new agents when you need new capability | Maintain and improve existing agents |
| Set budget caps | Stay within them |
| Read the Morning Brief | Write the Morning Brief |
| Define success metrics | Track and report them |

---

## Part 2: First-Time Setup

### Prerequisites

- Node.js 22.5+ (for built-in `node:sqlite`)
- Python 3.11+
- pnpm (`npm install -g pnpm`)
- An Anthropic API key
- Optionally: OpenAI API key (for Codex Review and TTS features)

Check your versions:
```bash
node --version    # must be v22.5+
python --version  # must be 3.11+
pnpm --version
```

### Step 1 — Clone or navigate to the repo

```bash
cd "C:\Users\rafae\OneDrive\Desktop\Organism"
```

### Step 2 — Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in:
```
ANTHROPIC_API_KEY=sk-ant-...        # Required — everything breaks without this
OPENAI_API_KEY=sk-...               # Optional — needed for Codex Review
SYSTEM_DAILY_CAP_USD=50             # Max spend per day across all projects
DASHBOARD_PORT=7391                 # Leave as-is
```

### Step 3 — Install Node packages

```bash
npm install
```

### Step 4 — Set up the Python MCP sidecar

```bash
cd packages/mcp-sidecar
python -m venv venv

# Windows:
venv\Scripts\activate

# Mac/Linux:
source venv/bin/activate

pip install -r requirements.txt
cd ../..
```

### Step 5 — Initialize the database

```bash
npm run migrate
```

You should see:
```
Database initialized. Tables:
  - agent_spend
  - audit_log
  - gates
  - shadow_runs
  - tasks
Migration complete.
```

### Step 6 — Run the health check

```bash
npm run health-check
```

All items should show OK. If anything fails, fix it before continuing. Common issues:
- `Secrets: FAIL` → check your `.env` file has `ANTHROPIC_API_KEY`
- `Database: FAIL` → re-run `npm run migrate`

### Step 7 — Start the dashboard

In a **dedicated terminal** (keep it open):
```bash
npm run dashboard
```

Open `http://localhost:7391` in your browser. You should see all agents showing as idle. **Leave this terminal running whenever Organism is active.**

### Step 8 — Run the smoke test

```bash
npm run smoke-test
```

This submits a test task and verifies the full LOW-risk pipeline. You should see:
```
✓ Task completed
✓ Audit trail exists
✓ Cost < $2
✓ Output exists

✓ WEEK 1 GATE: PASSED
```

If this passes, setup is complete. If it fails, check [Troubleshooting](#part-9-troubleshooting).

---

## Part 3: Daily Operations

### Every session: start here

Run these three things **in order** at the start of every session:

```bash
# 1. Health check (takes 5 seconds)
npm run health-check

# 2. Dashboard (keep this terminal open)
npm run dashboard

# 3. Start the MCP sidecar (keep this terminal open)
cd packages/mcp-sidecar && python server.py
```

Open `http://localhost:7391` and check:
- Any alerts? (red items need attention before starting)
- Any dead letters? (tasks stuck >30 min — see [Dead Letter Queue](#dead-letter-queue))
- Budget from yesterday? (check no agent went over cap)

### The Morning Brief

The CEO agent reads a structured brief at the start of each daily session. Until the Morning Brief script is automated, check these manually (takes 2 minutes):

```bash
# Open SQLite to check overnight status
node -e "
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('state/tasks.db');
const overnight = db.prepare(\"SELECT agent, status, COUNT(*) as count FROM tasks WHERE created_at > ? GROUP BY agent, status\").all(Date.now() - 86400000);
console.table(overnight);
const dead = db.prepare(\"SELECT * FROM tasks WHERE status='dead_letter'\").all();
if (dead.length) { console.log('DEAD LETTERS:', dead.length); dead.forEach(t => console.log(' -', t.agent, t.description)); }
"
```

### End of session checklist

Before closing your terminals:
- [ ] Dashboard shows no stuck tasks (nothing in `in_progress` for >30 min)
- [ ] No budget alerts (no agent >80% of daily cap)
- [ ] Check `knowledge/lessons.md` — add an entry if anything unexpected happened
- [ ] Dead letter queue is empty (or tasks have been reviewed and re-routed)

---

## Part 4: Submitting Tasks

### The basic API

Tasks are submitted programmatically. The simplest way during early development:

```typescript
// scripts/submit-task.ts
import { submitTask } from './packages/core/src/orchestrator.js';

const taskId = await submitTask({
  description: 'Write a blog post about how Synapse helps ANZCA candidates prepare for the primary exam',
  input: {
    targetWordCount: 800,
    targetAudience: 'ANZCA primary candidates in their first year of training',
    tone: 'informative, practical',
    projectId: 'synapse'
  }
}, {
  agent: 'marketing-executor', // optional — leave blank to auto-resolve
});

console.log('Task submitted:', taskId);
```

Run it:
```bash
npx tsx --experimental-sqlite scripts/submit-task.ts
```

### Task description — writing good ones

The risk classifier reads your task description. Word it clearly:

| Good descriptions | Why |
|---|---|
| "Write a blog post about ANZCA exam prep tips" | Clear deliverable, medium risk, auto-routes to Marketing |
| "Deploy the Stripe integration to Synapse production" | "deploy" + "production" → auto-HIGH, goes to G4 |
| "Fix the broken citation link in SAQ #4421 for CICM" | Clear bug, scoped, medium risk |
| "Review and update the pricing page copy" | Clear, medium risk |

| Vague descriptions | Problem |
|---|---|
| "Do the marketing thing" | Can't route, lands on CEO to disambiguate |
| "Fix stuff" | No classification possible |
| "Update the auth" | "auth" triggers HIGH — is that right? |

### Task fields

| Field | Required | Notes |
|---|---|---|
| `description` | Yes | Plain English. This is what the risk classifier reads. |
| `input` | Yes | Any JSON object with context for the agent |
| `input.projectId` | Yes | `'synapse'`, `'tokens-for-good'`, or `'organism'` |
| `agent` | No | Leave blank to auto-resolve from capability registry |
| `parentTaskId` | No | Link to a parent task for goal ancestry tracking |
| `loc` | No | Lines of code changed — adds to risk score |

### What happens after you submit

```
Task submitted
    ↓
Smell-test (free — looks for "deploy", "auth", "payment" etc.)
    ↓
Risk classifier (Haiku call, ~$0.001)
    → Assigns lane: LOW / MEDIUM / HIGH
    ↓
Capability registry lookup
    → Resolves owning agent
    ↓
Task appears in dashboard as "pending"
    ↓
Agent picks it up (atomic checkout — no duplicates)
    ↓
Pipeline runs for the assigned lane
    ↓
Output stored in state/tasks.db
    ↓
(If HIGH): Telegram message to you for G4 approval
```

### Handling a G4 approval (Telegram)

When a HIGH-risk task completes the full pipeline, you get a Telegram message:

```
🔴 G4 GATE — Task requires board approval

Project: Synapse
Task: Deploy Stripe integration to production
Agent: Engineering
Guardian Health Score: 87/100

Issues found:
  [HIGH] Missing error handling on webhook endpoint
  [MEDIUM] No rate limit on /api/stripe/webhook

Auto-fixed: 3 formatting issues
Needs approval: 2 items (see above)

[APPROVE] [REJECT] [ASK FOR CHANGES]
```

- **APPROVE** — task is marked complete, auto-fixes are staged for 24-hour window
- **REJECT** — task goes back to the agent with your rejection reason
- **ASK FOR CHANGES** — task is paused, you type your requested changes

You can also approve from the terminal:
```bash
# Get pending gates
node -e "const {getPendingG4Gates}=require('./packages/core/src/gates.js'); console.table(getPendingG4Gates())"

# Approve
node -e "const {resolveG4Gate}=require('./packages/core/src/gates.js'); resolveG4Gate('<gate-id>', 'approved', 'Looks good')"
```

---

## Part 5: Managing Projects

### Onboarding any project (existing or new) — 30 minutes

Run this checklist every time you bring a project under Organism:

**Step 1 — Create the project directory**
```bash
mkdir -p "knowledge/projects/<project-name>/wiki"
mkdir -p "knowledge/projects/<project-name>/raw"
```

**Step 2 — Write `knowledge/projects/<project-name>/config.json`**
```json
{
  "project": "<project-name>",
  "display_name": "Human Readable Name",
  "phase": "operate",
  "quality_standards": "STANDARD",
  "north_star_metric": "monthly_active_users",
  "north_star_target_30d": 50,
  "north_star_target_90d": 200,
  "risk_overrides": {},
  "domain_expert_reviewer": "rafael",
  "tech_stack": ["Next.js", "Supabase"],
  "repo_path": "C:/Users/rafae/OneDrive/Desktop/<project-folder>",
  "live_url": "https://your-project.vercel.app",
  "created_at": "YYYY-MM-DD"
}
```

**Step 3 — Set the phase**

| Phase | Use when | CEO behaviour |
|---|---|---|
| `build` | New project, no code yet | Co-founder: market research, PRDs, architecture |
| `operate` | Product exists, needs running | Portfolio manager: monitor, fix, maintain |
| `grow` | Product works, needs users | Growth operator: marketing, SEO, community |

**Step 4 — Set quality standards**

| Standard | Use for | Effect |
|---|---|---|
| `MEDICAL` | Synapse | Any grading content = HIGH risk. Stricter confidence thresholds. |
| `RESEARCH` | Tokens for Good | Citations required on all outputs. Research outputs = MEDIUM minimum. |
| `STANDARD` | Everything else | Default risk classification applies. |

**Step 5 — Set risk overrides** (if `MEDICAL` or `RESEARCH` isn't enough)
```json
"risk_overrides": {
  "keywords": ["patient", "dose", "drug", "contraindication"],
  "force_lane": "HIGH"
}
```

**Step 6 — Write the wiki seed** at `knowledge/projects/<name>/wiki/INDEX.md`
```markdown
# <Project Name> — Wiki Index

## Project summary
[One paragraph: what it is, who it's for, current status]

## Key documents
- [Business plan](../../../<project-folder>/tasks/business_plan.md)
- [Architecture](../../../<project-folder>/docs/architecture.md)

## Articles
(Empty — wiki compiler will populate this)

## Last updated
YYYY-MM-DD by [agent or manual]
```

**Step 7 — Register project-specific agents** in `knowledge/capability-registry.json`

Add any agents that only work on this project (see [Creating Agents](#part-6-creating-and-managing-agents)).

**Step 8 — Submit the first task**
```typescript
await submitTask({
  description: 'Summarize the current state of <project-name> and identify the top 3 priorities for this week',
  input: { projectId: '<project-name>', phase: 'operate' }
});
```

Verify it appears in the dashboard with the correct `project_id`, routes to the right agent, and completes without error. You're done.

---

### Synapse-specific setup

Synapse is in **operate + grow** phase. Add this to its `config.json`:
```json
{
  "project": "synapse",
  "display_name": "Synapse",
  "phase": "operate",
  "quality_standards": "MEDICAL",
  "north_star_metric": "monthly_active_subscribers",
  "risk_overrides": {
    "keywords": ["model_answer", "grading", "drug", "dose", "contraindication", "clinical"],
    "force_lane": "HIGH"
  },
  "repo_path": "C:/Users/rafae/OneDrive/Desktop/synapse",
  "live_url": "https://synapse.vercel.app"
}
```

### Tokens for Good-specific setup

Tokens for Good is in **operate** phase (launch blockers exist):
```json
{
  "project": "tokens-for-good",
  "display_name": "Tokens for Good",
  "phase": "operate",
  "quality_standards": "RESEARCH",
  "north_star_metric": "pilot_partners_signed",
  "risk_overrides": {
    "keywords": ["research output", "evidence synthesis", "citation"],
    "force_lane": "MEDIUM"
  },
  "repo_path": "C:/Users/rafae/OneDrive/Desktop/Tokens for Good",
  "live_url": "https://tokens-for-good-portal.vercel.app"
}
```

---

## Part 6: Creating and Managing Agents

### The agent lifecycle

```
IDEA → CLAUDE.md written → agent.ts written → registered as 'shadow'
  → 10 shadow runs → quality threshold met → shadow-promote.ts → 'active'
  → works real tasks → (eventually) Agent Lightning RL optimizes it
```

**Never skip shadow mode.** An agent that goes directly to active is an agent that will break something at 3am.

### Step-by-step: creating a new agent

**Step 1 — Create the directory**
```bash
mkdir -p "agents/<agent-name>/prompts"
```

**Step 2 — Write `agents/<agent-name>/CLAUDE.md`**

Use this template:
```markdown
---
name: <agent-name>
description: One sentence — what this agent does and why it exists.
model: claude-sonnet-4-6
tools: [Read, Glob, Grep, Write]
---

You are the **<Role>** of Organism. [One paragraph explaining the job.]

## Your responsibilities

1. [Primary responsibility]
2. [Secondary responsibility]
3. [Third responsibility]

## Session start protocol

1. Read your last 5 audit entries (loaded automatically)
2. Check pending tasks: any tasks assigned to you?
3. Check the project wiki: read knowledge/projects/<project>/wiki/INDEX.md
4. Begin work

## Output format

[Describe exactly what a completed task output looks like — structure, length, format]

## Hard rules

- [What this agent must never do]
- [What this agent must always do]
- Never exceed your model — you run on Sonnet. If a decision seems to need Opus, that means the Quality Guardian should review it.

## Required Secrets

- `ANTHROPIC_API_KEY`
```

**Step 3 — Write `agents/<agent-name>/agent.ts`**

```typescript
import { BaseAgent } from '../_base/agent.ts';
import { Task } from '../../packages/shared/src/types.ts';

export class MyAgent extends BaseAgent {
  constructor() {
    super({
      name: '<agent-name>',
      model: 'sonnet',
      capability: {
        id: '<capability-id>',
        owner: '<agent-name>',
        collaborators: [],
        reviewerLane: 'MEDIUM',
        description: '<description>',
        status: 'shadow',  // Always start as shadow
        model: 'sonnet',
        frequencyTier: 'on-demand'
      }
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    // Your agent logic here
    // Use this.name for logging
    // Call MCP sidecar for LLM calls
    return {
      output: { result: 'placeholder' },
      tokensUsed: 1000
    };
  }
}
```

**Step 4 — Register in `knowledge/capability-registry.json`**

```json
{
  "id": "<capability-id>",
  "owner": "<agent-name>",
  "collaborators": [],
  "reviewerLane": "MEDIUM",
  "description": "What this agent does",
  "status": "shadow",
  "model": "sonnet",
  "frequencyTier": "on-demand",
  "project_scope": ["synapse"]
}
```

Use `"project_scope": ["all"]` if the agent works across all projects.

**Step 5 — Run 10 shadow tasks**

Submit tasks that this agent should handle, with shadow mode enabled:
```bash
SHADOW_MODE=true npx tsx --experimental-sqlite scripts/submit-task.ts
```

Shadow runs execute the full agent logic but discard output and log to `state/shadow-runs.jsonl` instead of `tasks.db`.

Check shadow run quality:
```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('state/tasks.db');
const runs=db.prepare('SELECT agent, COUNT(*) as runs, AVG(quality_score) as avg_score FROM shadow_runs WHERE agent=? GROUP BY agent').get('<agent-name>');
console.log(runs);
"
```

**Step 6 — Promote to active**

Once you have ≥10 shadow runs with avg_score ≥ 0.7:
```bash
npm run shadow-promote -- <agent-name>
```

The agent is now live and will pick up real tasks.

### Adjusting an agent's budget cap

Edit `packages/core/src/budget.ts` and update the `DEFAULT_CAPS` object:
```typescript
const DEFAULT_CAPS: Record<string, number> = {
  'ceo': 1.50,           // $1.50/day
  '<agent-name>': 2.00,  // Add your agent
};
```

Or set via environment variable (no code change needed):
```bash
BUDGET_<AGENT_NAME_UPPERCASE>=3.00  # e.g., BUDGET_QUALITY_GUARDIAN=25.00
```

### Suspending an agent

To pause an agent without deleting it:
1. Open `knowledge/capability-registry.json`
2. Change `"status": "active"` to `"status": "suspended"`
3. The orchestrator will not assign new tasks to suspended agents

---

## Part 7: The Knowledge Base

### The two-layer structure

```
knowledge/
├── projects/<name>/
│   ├── config.json          ← project configuration
│   ├── raw/                 ← unprocessed source documents
│   │   ├── articles/        ← web clips (use Obsidian Web Clipper)
│   │   ├── papers/          ← PDFs converted to markdown
│   │   └── docs/            ← any other documents
│   └── wiki/                ← LLM-compiled articles (agents maintain this)
│       ├── INDEX.md         ← master index (auto-maintained by agents)
│       ├── concepts/        ← topic articles
│       ├── decisions/       ← decision history with outcomes
│       └── lessons/         ← what went wrong and why
│
├── business-model/          ← ROI frameworks (shared across projects)
├── marketing/               ← popularize playbook (shared across projects)
├── palate/                  ← Palate knowledge injection system
│   ├── sources.json         ← curated source registry
│   ├── sources/             ← downloaded external sources
│   └── wiki/                ← living wiki pages (auto-maintained)
├── capability-registry.json ← agent roster
└── error-taxonomy.json      ← error codes reference
```

### Adding knowledge to a project

**From a web article:**
1. Use the Obsidian Web Clipper browser extension to save as markdown
2. Move the `.md` file to `knowledge/projects/<name>/raw/articles/`
3. Submit a task: `"Compile the new raw articles in knowledge/projects/synapse/raw/articles/ into wiki articles"`

**From a PDF:**
1. Convert to markdown (use `npx repomix` or any PDF-to-markdown tool)
2. Move to `knowledge/projects/<name>/raw/papers/`
3. Submit a compile task (same as above)

**From a GitHub repo:**
```bash
# Pack the repo into a single markdown file
npx repomix <repo-url> --output knowledge/projects/<name>/raw/repos/<name>.md
```

### The wiki compile task

This is the core Karpathy-style pipeline. Submit when you have new raw documents:

```typescript
await submitTask({
  description: 'Compile all new raw documents in knowledge/projects/synapse/raw/ into wiki articles. Update INDEX.md. Cross-reference with existing wiki articles.',
  input: {
    projectId: 'synapse',
    rawPath: 'knowledge/projects/synapse/raw/',
    wikiPath: 'knowledge/projects/synapse/wiki/',
  }
});
```

The Obsidian Scribe agent handles this. It reads raw documents, writes structured concept articles, maintains the INDEX.md, and cross-links related articles.

### Wiki article format

Every article the wiki compiler writes follows this structure:
```markdown
# [Concept Name]

**Last updated:** YYYY-MM-DD by [agent-name]
**Related:** [[Article A]], [[Article B]]
**Project:** [project-name]

## Summary
[2-3 sentences — what this is and why it matters]

## Detail
[Full content]

## Evidence
[Sources, citations, confidence level]

## Open questions
[Things that are uncertain or need investigation]
```

### The INDEX.md convention

Every `wiki/` directory has an `INDEX.md`. Agents read this first to find relevant articles. Format:

```markdown
# [Project] Wiki Index

## Last updated: YYYY-MM-DD

## Articles

| Article | Summary | Last updated |
|---|---|---|
| [Opioid Pharmacology](concepts/opioid-pharmacology.md) | Mechanism, clinical use, reversal | 2026-04-04 |
| [Cardiac Output](concepts/cardiac-output.md) | Determinants, measurement, clinical implications | 2026-04-04 |

## Gaps identified
- ACEM pharmacology articles: 0 of 23 topics covered
- SAQ citation rate: 458 missing (need enrichment)

## Recent additions
- 2026-04-04: Added opioid pharmacology (from Miller's Ch. 12)
```

### The Palate (automatic knowledge injection)

The Palate (`packages/core/src/palate.ts`) automatically injects relevant knowledge sources into every task. When a task is submitted, the Palate:

1. Matches the task description against capabilities in `capability-registry.json`
2. Collects `knowledgeSources` from all matching capabilities (deduplicated)
3. Also checks `knowledge/palate/sources.json` for approved registry sources
4. Distills each source to ~30% via Haiku (cached by content hash at `state/palate-cache/`)
5. Injects the distilled content into `task.input.knowledgeSources`
6. Logs telemetry as a `source_injection` audit entry

**CLI commands:**

```bash
# View registered sources and their fitness scores
npm run organism "palate list"

# View injection telemetry (token savings, cache hits, per-capability counts)
npm run organism "palate stats"

# Add a local knowledge source (unapproved by default)
npm run organism "palate add knowledge/my-doc.md strategy,finance"

# Add from URL (fetched, sanitized, 50KB max, unapproved)
npm run organism "palate add https://example.com/article.html marketing"

# Approve a source for injection
npm run organism "palate approve my-doc"

# Remove a source
npm run organism "palate remove my-doc"

# Rate a wiki page (feeds into Darwinian source fitness)
npm run organism "rate marketing 4 solid channel strategy coverage"
```

**Source trust boundaries:**
- External URLs are fetched but never auto-approved
- HTML is stripped to plaintext (scripts/forms/iframes removed)
- Max 50KB per source (larger are truncated)
- Only `approved: true` sources enter the injection path

**Darwinian fitness:**
Sources evolve through ratings. When you rate wiki pages, scores propagate to contributing sources:
- Pages rated 4-5 stars: contributing sources get +0.05 fitness
- Pages rated 1-2 stars: contributing sources get -0.1 fitness
- Sources unused for 30+ days: -0.02/week decay
- Sources below 0.2 fitness become dormant (stop injecting)

**Living wiki:**
The `palate-wiki` agent (currently in shadow mode) writes domain-level wiki pages from approved sources at `knowledge/palate/wiki/`. Pages auto-split at 3000 words.

**Key files:**

| File | Purpose |
|---|---|
| `packages/core/src/palate.ts` | Resolution, distillation, injection |
| `packages/core/src/palate-sources.ts` | Source registry CRUD, fitness updates |
| `packages/core/src/palate-ratings.ts` | Wiki rating + fitness propagation |
| `knowledge/palate/sources.json` | Source registry data |
| `knowledge/palate/wiki/` | Wiki output directory |
| `agents/palate-wiki/agent.ts` | Wiki writer agent |

---

## Part 8: The Quality System

### The three tiers

| Tier | Agent | Model | When it fires | Cost/run |
|---|---|---|---|---|
| 1 | Quality Agent | Sonnet | All tasks in pipeline | ~$0.54 |
| 2 | Grill-Me | Sonnet | MEDIUM + HIGH lanes | ~$0.27 |
| 3 | Quality Guardian | Opus | HIGH lane + Saturday deep audit | ~$8-20 |

### The three lanes

```
LOW (50% of tasks)
  → Quality Agent → auto-ship
  Examples: internal docs, notes, research summaries

MEDIUM (35% of tasks)
  → Grill-Me → Quality Agent → Codex Review → auto-ship
  Examples: code changes, marketing content, PRDs

HIGH (15% of tasks)
  → Grill-Me → Quality Agent → Copyright → Legal → Security
  → Quality Guardian → Codex Review → G4 Gate (your Telegram)
  Examples: production deploys, pricing changes, auth changes,
            any medical grading content (Synapse)
```

### Reading a Quality Agent report

Every task's quality review is stored in `tasks.output`. When a task has LOW confidence:

```json
{
  "verdict": "REWORK",
  "confidence": "LOW",
  "issues": ["Model answer cites a retracted study", "Dosing information conflicts with current guidelines"],
  "recommendation": "Return to content-enricher for fact verification"
}
```

LOW confidence tasks are **never auto-shipped** — they go back for rework regardless of lane.

### Reading a Quality Guardian report

The Guardian's Saturday deep audit produces a full report. Find it:
```bash
cat state/guardian-history.json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const h=JSON.parse(d); console.log(h[h.length-1])"
```

The report has five sections:

**1. Platform Health Score**
```
87/100 — Moderate issues found
```
Score guide:
- 95-100: Clean — no action needed
- 90-94: Minor — note issues, no urgency
- 70-89: Moderate — address within 1 week
- 50-69: Serious — address within 48 hours
- <50: Critical — stop new work, fix immediately

**2. Issues table** — sorted by severity. Focus on CRITICAL and HIGH first.

**3. Auto-Fixed** — what the Guardian already fixed. Review to confirm fixes make sense.

**4. Needs Approval** — patches staged for your review. You have 24 hours before safe patches auto-apply. Logic/schema changes never auto-apply without your explicit approval.

**5. Feature Suggestions** — grounded in user feedback and audit findings. Feed these to the PM agent.

### The Guardian's shadow period (Weeks 5-6)

During shadow mode, the Guardian produces reports but applies **nothing**. Reports go to `state/guardian-shadow-<task-id>.json`. Review them manually to validate the Guardian's judgment before promoting it to production (Week 7).

---

## Part 9: Troubleshooting

### Error codes quick reference

| Code | Name | What happened | Fix |
|---|---|---|---|
| E001 | TASK_CHECKOUT_CONFLICT | Two agents tried the same task | Check for duplicate submissions |
| E002 | BUDGET_CAP_EXCEEDED | Agent hit daily budget ceiling | Check dashboard spend, raise cap if justified |
| E003 | GATE_BLOCKED | Quality gate rejected output | Read gate rejection reason, fix underlying issue |
| E004 | DOOM_LOOP_DETECTED | Agent retrying same action repeatedly | Check agent CLAUDE.md for stop conditions |
| E005 | MCP_CONTRACT_VIOLATION | PraisonAI tried to orchestrate | Check server.py — this should never happen |
| E101 | LOW_CONFIDENCE_FINDING | Guardian found but couldn't verify | Normal — Guardian discarded it |
| E102 | QUALITY_SCORE_BELOW_THRESHOLD | Output failed quality bar | Rework the underlying task |
| E103 | BROWSER_VERIFICATION_FAILED | Playwright test failed | Check if dev server is running |
| E104 | AUTO_FIX_REGRESSION | Guardian's fix made things worse | Revert the patch, flag to G4 |
| E201 | MCP_SIDECAR_UNREACHABLE | Python server not running | `cd packages/mcp-sidecar && python server.py` |
| E202 | SECRET_MISSING | API key not found | Add to `.env` or `.secrets.json` |
| E301 | AGENT_TIMEOUT | Agent ran >30 minutes | Break task into smaller pieces |
| E303 | SHADOW_PROMOTION_BELOW_THRESHOLD | Agent quality below bar | Fix CLAUDE.md, re-run shadow tasks |
| E304 | DEAD_LETTER_TIMEOUT | Task stuck >30 min | Review dead letter queue |

### Dead letter queue

Tasks stuck in `in_progress` for >30 minutes automatically become `dead_letter`. Check them:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('state/tasks.db');
const dead=db.prepare(\"SELECT id, agent, description, error FROM tasks WHERE status='dead_letter' ORDER BY created_at DESC\").all();
console.table(dead);
"
```

For each dead letter, decide:
- **Re-route:** Update the task's agent and set status back to `pending`
- **Cancel:** Set status to `failed` with a reason
- **Investigate:** Read the audit log for the task ID to understand what happened

### Reading the audit log

```bash
# Last 20 entries
tail -20 state/audit.log | node -e "
const readline=require('readline');
const rl=readline.createInterface({input:process.stdin});
rl.on('line', line => {
  const e=JSON.parse(line);
  console.log(new Date(e.ts).toISOString().slice(11,19), e.agent, e.action, e.outcome, e.errorCode||'');
});
"

# All entries for a specific task
grep '<task-id>' state/audit.log | node -e "
const readline=require('readline');
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>console.log(JSON.parse(line)));
"
```

### Common problems and fixes

**Problem: Dashboard shows no data / can't connect to DB**
```bash
# Re-run migrations
npm run migrate
# Restart dashboard
npm run dashboard
```

**Problem: MCP sidecar keeps crashing**
```bash
cd packages/mcp-sidecar
# Check Python version
python --version  # must be 3.11+
# Reinstall dependencies
pip install -r requirements.txt --force-reinstall
python server.py
```

**Problem: Tasks keep failing with E002 (budget exceeded)**
```bash
# Check today's spend by agent
node -e "
const {getSpendSummary}=require('./packages/core/src/budget.js');
console.table(getSpendSummary());
"
# If justified, raise the cap in .env:
# BUDGET_<AGENT_NAME>=5.00
```

**Problem: All tasks are being classified as HIGH**
- Check the smell-test in `packages/core/src/risk-classifier.ts`
- Your task descriptions may contain trigger words. Reword them.
- Example: "Update the auth flow documentation" → "Update the login documentation" (avoid "auth" if it's just docs)

**Problem: Agent keeps getting stuck (E301 AGENT_TIMEOUT)**
- The task is too large. Break it into subtasks.
- Each subtask should complete in under 10 minutes of agent work.
- Use `parentTaskId` to link subtasks back to the parent.

---

## Part 10: Cost Management

### Checking spend

```bash
# Today's spend by agent and project
node -e "
const {getSpendSummary,getSystemSpend}=require('./packages/core/src/budget.js');
console.log('System total today: \$' + getSystemSpend().toFixed(4));
console.table(getSpendSummary());
"
```

### Budget caps (defaults)

| Agent | Default daily cap | Notes |
|---|---|---|
| CEO | $1.50 | Runs once daily |
| Engineering | $4.00 | Most expensive — code is token-heavy |
| Quality Guardian | $25.00 | Opus — only fires on HIGH + Saturday |
| Quality Agent | $1.00 | Runs on every task — 3x/day typical |
| Marketing Executor | $1.50 | Daily runs |
| Risk Classifier | $0.10 | Haiku — pennies per call |
| All others | $0.30–$1.00 | See `packages/core/src/budget.ts` |

### Model routing — what each model costs

| Model | Input | Output | Use for |
|---|---|---|---|
| Haiku 4.5 | $0.80/M | $4.00/M | Risk classification, routing only |
| Sonnet 4.6 | $3.00/M | $15.00/M | All agent work (default) |
| Opus 4.6 | $15.00/M | $75.00/M | Quality Guardian only |
| GPT-4o | $2.50/M | $10.00/M | Codex Review (single API call) |

### Budget by phase (expected daily spend)

| Phase | Agents active | Expected daily |
|---|---|---|
| Week 1-2 | 5 agents | $3-7/day |
| Week 3-4 | 9 agents | $7-12/day |
| Week 5-6 | 13 agents | $12-20/day |
| Week 7-8 | 17 agents | $20-30/day |
| Week 9-10 | 23 agents | $30-45/day |
| Full steady state | All 23 agents | ~$35/day |

### If you're over budget

1. Check which agent is over: `npm run health-check` shows per-agent spend
2. Is the spend justified? (Quality Guardian doing a deep audit is expected to be expensive)
3. If not justified: suspend the agent (`"status": "suspended"` in capability-registry.json)
4. Investigate: read the audit log for that agent to see what it was doing
5. Fix the root cause (usually: task was too large, or agent was in a loop)

---

## Part 11: The 10-Week Rollout

### The core rule

**An agent only gets added when the previous week's agents are stable and within budget.**

"Stable" means:
- No dead letters in the past 3 days
- All tasks completing without E301 (timeout) or E004 (doom loop)
- Budget tracking correctly in the dashboard
- Quality scores consistently above threshold

### Week-by-week schedule

| Week | Add these agents | Cumulative | What to verify |
|---|---|---|---|
| 1 | CEO, Product Manager, Quality Agent | 3 | Smoke test passes. LOW lane works. |
| 2 | Engineering, Grill-Me | 5 | MEDIUM lane works. Feature branch created. PR created. |
| 3 | Marketing Strategist, SEO | 7 | First campaign brief produced. Keyword research done. |
| 4 | Design, Codex Review (GPT-4o) | 9 | Full MEDIUM pipeline including Codex Review. |
| 5 | Marketing Executor, Sales | 11 | Guardian in SHADOW MODE. First revenue-related tasks. |
| 6 | CFO, DevOps/SRE | 13 | Financial reporting works. Deployment automation works. |
| 7 | Quality Guardian (PRODUCTION), Copyright | 15 | First real Guardian report. G4 gate wired to Telegram. |
| 8 | Legal, Security (Offensive) | 17 | HIGH lane fully operational. |
| 9 | Competitive Intel, Community Manager, PR/Comms | 20 | Full revenue stack. Agent Lightning instrumentation starts. |
| 10 | Security (Audit + Knowledge), Obsidian Scribe, Tool Evaluator | 23 | Full Organism. Saturday deep audit running. |

### Adding an agent from the schedule

1. Write the agent's `CLAUDE.md` (use the template in [Part 6](#part-6-creating-and-managing-agents))
2. Register as `"status": "shadow"` in capability-registry.json
3. Run 10 shadow tasks
4. Check shadow quality: `npm run health-check`
5. Promote: `npm run shadow-promote -- <agent-name>`
6. Verify in dashboard: agent appears, picks up tasks, completes them
7. Check budget: spend is within cap after 2 days
8. Write entry in `knowledge/lessons.md`

### Stability gates (before adding next week's agents)

Run this check before any new agent:
```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('state/tasks.db');
const cutoff=Date.now()-3*86400000;
const deadLetters=db.prepare(\"SELECT COUNT(*) as count FROM tasks WHERE status='dead_letter' AND created_at > ?\").get(cutoff);
const failed=db.prepare(\"SELECT agent, COUNT(*) as count FROM tasks WHERE status='failed' AND created_at > ? GROUP BY agent ORDER BY count DESC LIMIT 5\").all(cutoff);
console.log('Dead letters (last 3 days):', deadLetters.count, '— must be 0 to proceed');
console.log('Failed tasks by agent:', failed);
"
```

If dead letters > 0: do not add new agents. Fix first.

---

## Part 12: Quick Reference

### All npm scripts

| Command | What it does |
|---|---|
| `npm run health-check` | Pre-flight check — run at start of every session |
| `npm run dashboard` | Start the live dashboard at localhost:7391 |
| `npm run migrate` | Initialize or update the SQLite database |
| `npm run smoke-test` | Submit a test task and verify the full pipeline |
| `npm run shadow-promote -- <name>` | Promote an agent from shadow to active |

### File locations — where everything is

| What | Where |
|---|---|
| Agent instructions | `agents/<name>/CLAUDE.md` |
| Agent code | `agents/<name>/agent.ts` |
| Agent roster | `knowledge/capability-registry.json` |
| Error codes | `knowledge/error-taxonomy.json` |
| Project configs | `knowledge/projects/<name>/config.json` |
| Project wiki | `knowledge/projects/<name>/wiki/` |
| Raw source docs | `knowledge/projects/<name>/raw/` |
| Shared ROI frameworks | `knowledge/business-model/roi-framework.md` |
| Marketing playbook | `knowledge/marketing/popularize-playbook.md` |
| Lessons log | `knowledge/lessons.md` |
| Task database | `state/tasks.db` |
| Audit log | `state/audit.log` |
| Budget per agent | `packages/core/src/budget.ts` |
| Risk classifier | `packages/core/src/risk-classifier.ts` |
| Governance spine | `packages/core/src/orchestrator.ts` |
| MCP sidecar | `packages/mcp-sidecar/server.py` |

### The 5 things to check when something feels wrong

1. **Dashboard** — is anything red? Any dead letters?
2. **Budget** — is any agent over 80% of daily cap?
3. **Audit log** — `tail -50 state/audit.log` — any E-codes?
4. **MCP sidecar** — is the Python server still running?
5. **Smoke test** — `npm run smoke-test` — does the basic pipeline still work?

### Active agents at Week 1 (right now)

| Agent | Model | Lane | Project scope | Status |
|---|---|---|---|---|
| CEO | Sonnet | LOW/MEDIUM | All | Active |
| Product Manager | Sonnet | LOW/MEDIUM | All | Active |
| Quality Agent | Sonnet | On-demand | All | Active |
| Risk Classifier | Haiku | Always | All | Active |
| Marketing Strategist | Sonnet | MEDIUM | All | Shadow |
| Engineering | Sonnet | MEDIUM | All | Shadow |
| Grill-Me | Sonnet | On-demand | All | Shadow |
| Quality Guardian | Opus | HIGH only | All | Shadow (activate Week 5) |

### The non-negotiables

1. **Dashboard must be running before any agent starts work**
2. **Never edit `state/tasks.db` directly** — use the API or scripts
3. **Never commit `.env` or `.secrets.json`** — they are in `.gitignore`
4. **Shadow mode before active** — always, no exceptions
5. **No agent merges PRs** — G4 gate only
6. **Medical content (Synapse) = MEDICAL quality standard** — any grading content is HIGH risk
7. **Add to `knowledge/lessons.md`** after any incident or unexpected behaviour

---

*Last updated: 2026-04-04*
*Manual maintained by: Organism CEO agent + Rafael*
*To update this manual: submit a task to the CEO agent with description "Update the MANUAL.md to reflect [change]"*
