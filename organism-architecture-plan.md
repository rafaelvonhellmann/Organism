# ORGANISM — Autonomous Company Orchestration System — Final Plan

## Context
Building a fully autonomous multi-agent orchestration system ("Organism") that runs ANY company independently, with Rafael as board member reviewing outputs at gates. General-purpose — not tied to a single product. Self-improving. 24/7.

## Confirmed Decisions
- **Name**: Organism
- **Language**: TypeScript-first, Python via MCP bridges
- **Orchestrator**: Merged Paperclip + PraisonAI into single unified system
- **Budget**: $50/day ($1,500/mo) cap
- **Deployment**: Local machine first, VPS later
- **Grill-me scope**: Everything major — maximum safety
- **Agent Lightning**: From the start (RL optimization from day one)
- **A2A Protocol**: Implemented from the start
- **Dashboard**: Task phrase + completion % per agent
- **Knowledge layer**: Rafael's existing Obsidian vault (dedicated `/organism/` folder)
- **Review pipeline**: Grill-me → Quality (autoresearch) → Copyright → Legal → Security → Codex Review → Board gate

---

## 1. Unified Orchestrator: Organism Core (Paperclip + PraisonAI Merger)

Instead of two competing orchestrators, we build ONE system taking the best of each.

### What Paperclip contributes (the Governance Spine — keep as-is in TS):
- Org chart hierarchy with reporting lines
- G1-G4 board gates with approval/rollback
- Per-agent budget tracking with spend throttling
- Heartbeat scheduler (wake cycles + event triggers)
- Atomic task checkout (no duplicate work)
- Immutable audit logs with tool-call tracing
- Goal ancestry (every task traces to company mission)

### What PraisonAI contributes (MCP Sidecar — Python service):
- 100+ LLM providers via litellm (model routing)
- Native MCP protocol (stdio/HTTP/WebSocket)
- RAG with quality scoring
- Graph memory (Neo4j-style knowledge persistence)
- Guardrails with policy engine
- Plan-execute-reason workflow loop with self-reflection
- Doom loop detection with auto-recovery
- Bot gateway (Telegram/Discord/WhatsApp)

### What gets dropped (redundant):
- PraisonAI's web UI (Paperclip's is better)
- PraisonAI's task persistence (Paperclip's ticket system is superior)
- PraisonAI's `praisonai-ts` package (we use Paperclip's TS)
- Paperclip's direct LLM calls (replaced by PraisonAI's 100+ providers)

### What gets ported to TypeScript (~500 LOC):
- AgentFlow patterns (route/parallel/loop/repeat)
- Plan-execute-reason loop
- Doom loop detection + auto-recovery
- Shadow Git checkpoints (as a Paperclip skill)

### Architecture:
```
┌─────────────────────────────────���───────────────────┐
│              NEXUS (Unified Orchestrator)            │
│                                                     │
│  ┌─────────────────────┐  ┌──────────────────────┐  │
│  │  PAPERCLIP CORE     │  │  PRAISONAI SIDECAR   │  │
│  │  (TypeScript)       │  │  (Python MCP Server)  │  │
│  │                     │  │                       │  │
│  │  Org chart          │◄─┤  100+ LLM providers   │  │
│  │  G1-G4 gates        │  │  RAG + quality score  │  │
│  │  Budget tracking    │  │  Graph memory          │  │
│  │  Heartbeat/scheduler│  │  Guardrails/policies  │  │
│  │  Audit logs         │  │  Doom loop detection  │  │
│  │  Ticket system      │  │  Bot gateway          │  │
│  │  Goal ancestry      │  │  Model router         │  │
│  │                     │  │  (cheapest-capable)   │  │
│  │  [Ported from Praison]│ │                       │  │
│  │  AgentFlow patterns │  │                       │  │
│  │  Plan-execute-reason│  │                       │  │
│  │  Shadow git checkpts│  │                       │  │
│  └─────────────────────┘  └──────────────────────┘  │
│              │                      │                │
│              └──────┬───────────────┘                │
│                     │ MCP Protocol                   │
│              ┌──────▼───────┐                        │
│              │  A2A Protocol │                        │
│              │  (all agents) │                        │
│              └──────────────┘                        │
└─────────────────────────────────────────────────────┘
```

---

## 2. Full Org Chart — 8 Layers, 22 Agents

### Layer 0: Infrastructure
| Component | Source | Purpose |
|---|---|---|
| **Organism Core** | `paperclipai/paperclip` (modified) | Governance spine — org chart, budgets, tickets, gates |
| **Organism AI** | `MervinPraison/PraisonAI` (MCP sidecar) | LLM routing, RAG, guardrails, graph memory |
| **A2A Protocol** | `a2aproject/A2A` | Inter-agent communication |
| **GNHF** | `kunchenguid/gnhf` | 24/7 autonomous loops with rollback + caps |
| **ARIS** | `wanshuiyin/Auto-claude-code-research-in-sleep` | Overnight cross-model adversarial review |
| **OpenSessions** | `ataraxy-labs/opensessions` | Live dashboard — task + % per agent |
| **Agent Lightning** | `microsoft/agent-lightning` | RL optimization from day one |
| **Huginn** | `huginn/huginn` | Real-world event triggers (webhooks, RSS, email) |
| **nono** | GitHub security tools | Kernel-enforced sandbox for code-executing agents |
| **Repomix** | `yamadashy/repomix` | Pack codebases into AI-friendly context bundles |
| **Obsidian Skills** | `kepano/obsidian-skills` | Read/write Obsidian vault — human knowledge layer |
| **LangChain** | `langchain-ai/langchain` | Tool/retrieval abstraction for Python MCP bridges |

### Layer 1: C-Suite
| Agent | Source | Capabilities |
|---|---|---|
| **CEO** | `agency-agents` + `alirezarezvani/claude-skills` | Strategy, delegation, report compilation |
| **CFO** | `FinRobot` + `TaxHacker` + `meteroid` (via MCP) | Financial analysis, expenses, billing, pricing |
| **Product Manager** | `deanpeters/Product-Manager-Skills` | PRDs, user stories, RICE, roadmaps |

### Layer 2: Revenue & Growth
| Agent | Source | Capabilities |
|---|---|---|
| **Marketing Strategist** | `agency-agents` (marketing division) | Brand, campaigns, growth strategy |
| **Marketing Executor** | `marketingskills` + `kostja94/marketing-skills` + copywriting skill | CRO, email, paid ads, retention, copy |
| **SEO** | `schwepps/skills` + marketingskills | Technical audits, GEO/AEO, programmatic SEO |
| **Sales** | `agency-agents` (sales division) | Outreach, pipeline, lead qualification |
| **Competitive Intel** | `brightdata/competitive-intelligence` + `browser-use` (MCP) | Web scraping, SWOT, CI reports |
| **Community Manager** | `langchain-ai/social-media-agent` | Content curation, scheduling, social (HITL) |
| **PR/Comms** | `Product-Manager-Skills` (press-release) + `ALwrity` | Press releases, media, content |

### Layer 3: Product & Engineering
| Agent | Source | Capabilities |
|---|---|---|
| **Design** | `awesome-design-md` + `shadcn/ui` + `emilkowalski/skill` + `frontend-design` + `ui-ux-pro-max` | Full design stack — 50+ styles, 161 palettes |
| **Design Feedback** | `agentation` | Visual annotation overlay for UI |
| **Engineering** | `agency-agents` + `superpowers` + `get-shit-done` | Socratic design, TDD, wave-based delivery |
| **DevOps/SRE** | `agenticsorg/devops` + Claude SRE cookbook | Multi-cloud, incident response, monitoring |

### Layer 4: Customer-Facing
| Agent | Source | Capabilities |
|---|---|---|
| **Customer Support** | Pattern from `openai/openai-cs-agents-demo` | Triage, sub-agents, escalation |

### Layer 5: Compliance & Security
| Agent | Source | Capabilities |
|---|---|---|
| **Copyright** | Custom + `alirezarezvani/claude-skills` (compliance) | Plagiarism, license checking, DMCA prevention |
| **Legal/Compliance** | Custom + `agent-governance-toolkit` | GDPR, FTC, AHPRA, terms review |
| **Security (Offensive)** | `CAI` + `strix` (via MCP/Docker) | Pen testing, vuln scanning, CI/CD gates |
| **Security (Knowledge)** | `Anthropic-Cybersecurity-Skills` (753 skills) | MITRE ATT&CK + NIST CSF knowledge |
| **Security (Audit)** | `agent-audit` + `hexstrike-ai` (MCP) | OWASP scanning, static analysis |

### Layer 6: Quality & Review Pipeline
| Agent | Source | Capabilities |
|---|---|---|
| **Grill-Me Gate** | `mattpocock/skills` (grill-me) | Socratic interrogation on ALL major decisions |
| **Quality Agent** | Synapse project + autoresearch | Multi-approach generation, comparison, best pick |
| **Quality Guardian** | `quality-guardian-agent.md` (custom, Opus 4.6) | Autonomous quality investigator — 6-phase audit with Playwright browser verification, autoresearch methodology (hypothesis→test→disprove→cross-validate→confirm), parallel subagents (data integrity, derived outputs, pages/UX, auth/security, user feedback, browser), self-evaluation metrics, auto-fix safe issues, Platform Health Score. Project-agnostic — copy to `.claude/agents/` and customize audit scope per project. Runs AFTER Quality Agent, BEFORE Codex Review. |
| **Codex Review** | Codex CLI | Final code/content review + sign-off |
| **Tool Evaluator** | Claude cookbook (tool-evaluation) | Benchmark tools before deploying |

### Layer 7: Knowledge & Learning
| Agent | Source | Capabilities |
|---|---|---|
| **Obsidian Scribe** | `kepano/obsidian-skills` | Writes decisions, learnings, meeting notes to vault |
| **Best Practices** | `shanraisshan/claude-code-best-practice` | Pattern library for agent topology |

---

## 3. Report Pipeline (Board Member Workflow)

```
 Agents work autonomously (24/7 via GNHF + ARIS overnight)
         │
         ▼
 Grill-Me Gate — Socratic challenge on EVERY major decision
         │
         ▼
 CEO compiles division reports → writes to Obsidian vault
         │
         ▼
 Organism G1 Gate — automated checks (budget, compliance, tests)
         │
         ▼
 Quality Agent (autoresearch)
   → generates 3+ alternatives
   → compares quality scores
   → picks best iteration
         │
         ▼
 Copyright Agent — originality + license check
         │
         ▼
 Legal Agent — regulatory compliance review
         │
         ▼
 Security Audit — OWASP + vuln scan
         │
         ▼
 Quality Guardian (autonomous quality investigator)
   → 6-phase audit: baseline → area-by-area → browser verify → cross-validate → root cause → act
   → Autoresearch: hypothesis → test → disprove → cross-validate → confirm
   → Parallel subagents: data, outputs, pages, auth/security, feedback, browser
   → Auto-fixes safe issues, proposes risky ones
   → Platform Health Score: X/100
   → Only HIGH/MEDIUM confidence findings reported
         │
         ▼
 Codex Review — code correctness + final polish (reviews Guardian's fixes too)
         │
         ▼
 Organism G4 Gate — BOARD REVIEW
         │
         ▼
 Rafael reviews in Obsidian + dashboard, approves/rejects
         │
         ▼
 Deploy / Publish / Execute
```

---

## 4. Dashboard

OpenSessions (`:7391`) + Paperclip ticket system:

```
┌──────────────────────────────────────────────────────────┐
│  NEXUS COMPANY DASHBOARD                    Live │ 24/7  │
├─────────────────────────────────────────────────────��────┤
│                                                          │
│  CEO          "Compiling Q2 growth report"        [87%]  │
│  Marketing    "A/B testing landing page copy"     [45%]  │
│  SEO          "Technical audit: sitemap gaps"     [92%]  │
│  Design       "Homepage redesign v3"              [30%]  │
│  Sales        "Qualifying 12 inbound leads"       [60%]  │
│  Security     "Weekly vuln scan — 0 critical"     [✓]    │
│  DevOps       "Deploying staging build #847"      [78%]  │
│  Support      "3 open tickets, 0 escalated"       [idle] │
│  Obsidian     "Syncing 4 new decisions to vault"  [90%]  │
│                                                          │
│  ── REVIEW PIPELINE ──                                   │
│  Grill-Me     "Challenging marketing strategy"    [active]│
│  Quality      "Reviewing marketing report v2"     [40%]  │
│  Copyright    "Checking 3 new blog posts"         [15%]  │
│  Codex        "Waiting for quality gate"          [queue]│
│                                                          │
│  ── LEARNING ──                                          │
│  Agent Lightning: 47 outcomes tracked, 3 policies updated│
│                                                          │
│  Tokens today: 847K / 2M cap  │  Cost: $12.40 / $50 cap │
│  Overnight (GNHF): 3 tasks done, 0 rolled back          │
│  LLM routing: Claude 68% │ GPT 22% │ Gemini 10%         │
└──────────────────────────────────────────────────────────┘
```

---

## 5. Skills Installation

```bash
# Core methodology
npx skills add mattpocock/skills                         # grill-me, prd-to-plan, tdd
npx skills add obra/superpowers                           # engineering methodology
npx skills add gsd-build/get-shit-done                    # feature delivery

# Marketing & Content
npx skills add coreyhaines31/marketingskills              # CRO, SEO, copywriting
npx skills add kostja94/marketing-skills                  # 160+ marketing skills
npx skills add schwepps/skills                            # SEO + GEO/AEO

# Design
npx skills add shadcn/ui                                  # Component patterns
npx skills add emilkowalski/skill                         # UI/UX principles
npx skills add anthropics/skills --skill frontend-design  # Quality gate
npx skills add nextlevelbuilder/ui-ux-pro-max-skill       # Design system data

# Product
npx skills add deanpeters/Product-Manager-Skills          # PRD, RICE, roadmaps

# Business & Compliance
npx skills add alirezarezvani/claude-skills                # 220+ skills

# Security
npx skills add mukul975/Anthropic-Cybersecurity-Skills     # 753 cybersec skills

# Knowledge & Meta
npx skills add kepano/obsidian-skills                      # Obsidian vault integration
npx skills add vercel-labs/skills --skill find-skills      # Skill discovery
```

---

## 6. MCP Bridge Architecture (Python tools)

Each Python tool runs as an MCP server, called natively by TS agents:

```
Organism Core (TS)
  │
  ├─► browser-use MCP server (Python) ── web research
  ├─► CAI MCP server (Python) ────────── offensive security
  ├─► FinRobot MCP server (Python) ───── financial analysis
  ├─► PraisonAI MCP server (Python) ──── LLM routing, RAG, guardrails
  ├─► Agent Lightning (Python) ────────── RL optimization
  └─► LangChain (Python) ─────────────── tool/retrieval abstraction
```

Strix runs as a Docker container triggered by Organism tickets (heavier, needs isolation).

---

## 7. Phased Deployment

### Phase 1: Foundation (Week 1)
- Clone Paperclip + `paperclipai/companies` templates
- Deploy PraisonAI as MCP sidecar
- Port AgentFlow + plan-execute-reason + doom loop to TS (~500 LOC)
- Set up A2A protocol
- Install ALL skills (npx skills add)
- Configure GNHF for 24/7 loops
- Set up OpenSessions dashboard
- Wire Agent Lightning from day one
- Set up Obsidian Skills for vault integration
- Deploy: CEO, PM, Quality Agent, Grill-Me
- Budget cap: $50/day

### Phase 2: Revenue Team (Week 2)
- Marketing Strategist + Executor, SEO, Sales, Copywriting
- Competitive Intel (browser-use MCP bridge)
- Community Manager, PR/Comms
- Grill-me active on all major decisions

### Phase 3: Engineering & Design (Week 3)
- Design agent (full stack)
- Engineering (Superpowers + GSD)
- DevOps/SRE
- Codex Review pipeline
- Repomix for codebase context

### Phase 4: Compliance & Security (Week 4)
- Copyright, Legal agents
- Security stack (CAI MCP + Strix Docker + 753 cybersec skills)
- agent-audit + hexstrike-ai
- nono sandbox

### Phase 5: Optimization (Week 5+)
- ARIS cross-model adversarial review
- Feedback loops (analytics → CEO)
- Token cost optimization from real burn data
- Tune Agent Lightning policies from outcome data

---

## 8. All Repos — Final Verdict

### USE (core system) — 38 repos/skills
| Repo | Role | Priority |
|---|---|---|
| paperclipai/paperclip | Governance spine | P0 |
| paperclipai/companies | Agent templates | P0 |
| MervinPraison/PraisonAI | MCP sidecar (LLM/RAG/guardrails) | P0 |
| kunchenguid/gnhf | 24/7 engine | P0 |
| a2aproject/A2A | Inter-agent protocol | P0 |
| msitarzewski/agency-agents | Agent persona definitions | P0 |
| mattpocock/skills | Grill-me + methodology | P0 |
| alirezarezvani/claude-skills | 220+ business skills | P0 |
| ataraxy-labs/opensessions | Dashboard | P0 |
| microsoft/agent-lightning | RL optimization | P0 |
| kepano/obsidian-skills | Knowledge layer | P0 |
| yamadashy/repomix | Codebase context packing | P0 |
| coreyhaines31/marketingskills | Marketing execution | P1 |
| kostja94/marketing-skills | Marketing depth (160+) | P1 |
| deanpeters/Product-Manager-Skills | PM skills | P1 |
| VoltAgent/awesome-design-md | Design context | P1 |
| browser-use/browser-use | Web research (MCP) | P1 |
| vercel-labs/agent-browser | Browser for TS agents | P1 |
| obra/superpowers | Engineering methodology | P1 |
| gsd-build/get-shit-done | Feature delivery | P1 |
| wanshuiyin/Auto-claude-code-research-in-sleep | Overnight patterns | P1 |
| anthropics/skills (frontend-design) | Design quality gate | P1 |
| nextlevelbuilder/ui-ux-pro-max-skill | Design data | P1 |
| schwepps/skills | SEO + GEO/AEO | P1 |
| shanraisshan/claude-code-best-practice | Pattern library | P1 |
| langchain-ai/langchain | Python tool abstraction | P1 |
| usestrix/strix | Security testing (Docker) | P2 |
| aliasrobotics/CAI | Offensive security (MCP) | P2 |
| mukul975/Anthropic-Cybersecurity-Skills | Security knowledge | P2 |
| microsoft/agent-governance-toolkit | Compliance | P2 |
| agentation | Visual UI feedback | P2 |
| vas3k/TaxHacker | Expense tracking | P2 |
| meteroid-oss/meteroid | SaaS billing | P2 |
| huginn/huginn | Event triggers | P2 |
| langchain-ai/social-media-agent | Community management | P2 |
| AJaySi/ALwrity | Content platform | P2 |
| hexstrike-ai | 150+ security MCP tools | P2 |
| agent-audit | OWASP scanning | P2 |

### REFERENCE ONLY
| Repo | Value |
|---|---|
| santosomar/AI-agents-for-cybersecurity | Security agent cookbook |
| NVISOsecurity/cyber-security-llm-agents | SOC automation patterns |
| openai/openai-cs-agents-demo | Customer support reference |
| affaan-m/everything-claude-code | Config bootstrap reference |
| sickn33/antigravity-awesome-skills | 1,340 skill catalog |
| platform.claude.com cookbooks (3) | Multimodal, tool eval, SRE patterns |
| brightdata/competitive-intelligence | CI reference |

### SKIP
| Repo | Why |
|---|---|
| OpenBMB/ChatDev | Software-only, not full company |
| FoundationAgents/MetaGPT | Software-only, not full company |

---

## 9. Self-Improvement Stack (6 layers)

1. **Grill-Me** — Socratic challenge on ALL major decisions (prevents bad decisions)
2. **Quality Agent + Autoresearch** — Multi-approach comparison (ensures best output)
3. **Quality Guardian** — Autonomous 6-phase audit with browser verification, auto-fix, Platform Health Score (catches what autoresearch misses — runs Playwright, spawns parallel subagents, cross-validates findings)
4. **Codex Review** — Final code/content gate (catches remaining errors, also reviews Guardian's fixes)
5. **ARIS cross-model review** — Different model reviews overnight work (prevents blindness)
6. **Agent Lightning RL** — Agents genuinely improve from outcome data over time
7. **Tool Evaluator** — Benchmark new tools before deploying to agents

---

## 10. Verification Plan

### How to test end-to-end:
1. **Smoke test**: Start Organism → verify dashboard shows all agents idle
2. **Single agent**: Assign CEO a "write company mission" task → verify ticket created, heartbeat fires, output generated
3. **Pipeline test**: Push a task through full review pipeline (grill-me → quality → copyright → legal → security → codex → G4 gate)
4. **Overnight test**: Set GNHF to run 3 tasks overnight → verify morning dashboard shows completions/rollbacks
5. **MCP bridge test**: Trigger browser-use via TS agent → verify web research returns
6. **Budget test**: Set $1 cap → verify agents stop at limit
7. **Obsidian test**: Verify decisions written to vault, readable in Obsidian
8. **RL test**: Run 10 tasks → verify Agent Lightning tracks outcomes and updates policies
