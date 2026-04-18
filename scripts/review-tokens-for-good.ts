/**
 * Full multi-agent Tokens for Good review — 20 agents with ACTUAL CODE EVIDENCE.
 * Context includes real code snippets, deployment state, database schema, and API surface.
 * Run: npm run organism "review tokens-for-good"
 */

import * as fs from 'fs';
import * as path from 'path';
import { submitTask } from '../packages/core/src/orchestrator.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';

// ── Actual code evidence from the Tokens for Good codebase ─────────────────
// These are REAL snippets, not metadata. Agents must reference these, not guess.
const TFG_CODE_EVIDENCE = {
  // Deployment state — honest posture
  deployment: {
    portal: 'Vercel — LIVE at https://tokens-for-good-portal.vercel.app',
    controlPlane: 'Render (Docker, Node 22 Alpine) — in-memory queue/inline mode, PrismaRepository ready but using MemoryRepository on serverless',
    chatgptApp: 'Render (Docker) — MCP server with 13 tools',
    redis: 'Render KeyValue provisioned but in-memory fallback active',
    postgres: 'Render Basic 256MB provisioned, Prisma schema ready',
    region: 'Oregon (all Render services)',
    closedAlphaCode: 'Configured in render.yaml',
  },

  // Queue & execution — the honest gap
  executionState: {
    queue: 'In-memory inline mode (not durable BullMQ). REDIS_URL provisioned but fallback active.',
    openai: 'OPENAI_ENABLE_REAL_CALLS=false — all research runs use deterministic mock responses',
    smtp: 'VERIFICATION_DELIVERY_MODE=console or outbox — no real email delivery yet',
    scheduler: 'SCHEDULER_ENABLED=false — nightly autoresearch not running',
    verdict: 'End-to-end flow works with mock data. Real execution requires: Redis queue + OpenAI real calls + SMTP delivery.',
  },

  // Database schema — 15+ Prisma models
  database: {
    file: 'packages/database/prisma/schema.prisma',
    keyModels: 'DonorProfile, DonorSession, Subproject, Enrollment, ContributionPolicy, ResearchRun, Task, TaskResult, Citation, AgentTrace, ContributionMetric, AuditEvent, OperationalIncident, OperatorActivity, SessionChallenge',
    enums: 'WorkloadType(literature_mining, molecular_screening, structured_compute), RunStatus(queued, running, waiting_webhook, completed, paused, blocked, failed), SensitivityClass(public, restricted, phi_blocked)',
    seedSubprojects: '4 demo subprojects: sp_lit_oncology (oncology lit), sp_viral_surveillance (infectious disease), sp_molecular_docking (drug discovery), sp_clinical_trials_watch (translational research)',
    demoDonor: 'demo@tokensforgood.org with 3 enrollments, nightly auto mode, $12/day budget, max 2 concurrent runs',
  },

  // API surface — control plane (Fastify on port 4000)
  apiRoutes: {
    auth: 'POST /auth/session/request (rate: 5/15min IP, 3/10min email), POST /auth/session/verify, GET /auth/me',
    donor: 'GET /subprojects, POST /enrollments, PATCH /contribution-policy, GET /dashboard, GET /runs, GET /runs/:id, POST /runs, POST /runs/:id/pause, POST /runs/:id/resume',
    scheduler: 'GET /scheduler/decision, POST /scheduler/auto (1/hr/donor), POST /scheduler/sweep (admin)',
    partner: 'POST /runs/:id/review, POST /partner-events, POST /partner-events/preview',
    ops: 'GET /ops/summary, GET /ops/history, GET /ops/preflight, POST /ops/verification-delivery/test, GET /ops/review-queue, GET /ops/campaigns, GET /ops/runs/:id, PATCH /ops/subprojects/:id',
    webhook: 'POST /webhooks/openai/research-complete (signature-validated)',
    health: 'GET /health (readiness: repository, queue, verification_delivery, connector_cache, openai_research, alert_sink)',
  },

  // Portal — Next.js on Vercel
  portal: {
    publicPages: '/, /how-it-works, /research-paths, /impact, /partners, /faq, /transparency, /alpha, /pilot, /why',
    donorPages: '/start (onboarding), /runs (history), /runs/[id] (detail with traces/citations)',
    opsPages: '/ops/access, /ops (dashboard), /ops/history, /ops/review-queue, /ops/review-queue/[id], /ops/campaigns, /ops/partner-events, /ops/subprojects',
    apiProxy: 'All /api/tfg/* routes proxy to control plane with session token forwarding',
  },

  // ChatGPT MCP server — 13 tools
  mcpServer: {
    tools: 'list_subprojects, select_subprojects, get_dashboard, set_contribution_preferences, start_research_run, pause_autoresearch, resume_autoresearch, get_run_details, preview_autoresearch, trigger_autoresearch_now, pause_run, resume_run, submit_partner_review',
    session: 'x-tfg-session-token header, Bearer token, or tfg_widget_session cookie (HttpOnly, 30-day)',
    port: 4100,
  },

  // Research workers — Python deterministic workloads
  researchWorkers: {
    file: 'services/research-workers/src/main.py (572 lines)',
    workloadTypes: {
      literature_mining: 'Returns deterministic BOINC citation (real PubMed calls disabled by default)',
      molecular_screening: 'PubChem REST API — fetches MW, XLogP, TPSA, HBD, HBA. Scores compounds using Lipinski-like heuristic. Default compounds: imatinib, erlotinib, gefitinib, sunitinib, olaparib. Top 3 returned.',
      structured_compute: 'ClinicalTrials.gov v2 API — scores trials by status, phase, enrollment, recency. Top 3 returned with NCT ID.',
    },
    realCallFlags: 'PUBMED_ENABLE_REAL_CALLS, PUBCHEM_ENABLE_REAL_CALLS, CLINICALTRIALS_ENABLE_REAL_CALLS — all default false',
    outputSchema: '{ summary: string, confidence: float, citations: Citation[], payload: {} }',
  },

  // Security posture
  security: {
    donorAuth: 'Email verification challenge (6-digit code, 10min expiry). Rate limited. EXPOSE_DEV_VERIFICATION_CODE=true in dev.',
    operatorAuth: 'Named credentials via ADMIN_OPERATORS or SHA-256 hashes via ADMIN_OPERATOR_HASHES. Portal operator session encrypted with PORTAL_OPERATOR_SESSION_SECRET.',
    apiTokens: 'x-tfg-admin-token, x-tfg-partner-token, x-tfg-session-token. Separate admin/partner/donor scopes.',
    webhookValidation: 'OPENAI_WEBHOOK_SECRET — signature-checked on /webhooks/openai/research-complete',
    rateLimits: 'Auth: 5/15min IP + 3/10min email. Runs: 10/hr/donor. Autoresearch: 1/hr/donor.',
    phiBlocked: 'Run guards prevent phi_blocked subprojects from executing',
    productionHardening: 'ALLOW_MEMORY_FALLBACK=false + EXPOSE_DEV_VERIFICATION_CODE=false required for prod',
  },

  // Testing
  testing: {
    framework: 'Vitest',
    controlPlane: '9 test suites (app, config, dependency-preflight, operational-alerts, pubmed-client, python-worker-client, research-engine, scheduler, verification-delivery)',
    portal: 'Form validation tests (pilot-request.test.ts)',
    totalTestFiles: '689 .test.ts files across workspace',
    runCommand: 'corepack pnpm test',
  },

  // Infrastructure — Docker Compose for local dev
  infrastructure: {
    localStack: 'docker-compose.yml: postgres:16-alpine (5432), redis:7-alpine (6379), mailpit (SMTP 1025, UI 8025)',
    renderYaml: 'render.yaml: tfg-redis (KeyValue), tfg-control-plane (Web Docker), tfg-chatgpt-app (Web Docker), tfg-postgres (Basic 256MB)',
    demoMode: 'pnpm demo:up — in-memory persistence, no Docker required, mock providers',
  },

  // Git trajectory (11 commits)
  gitHistory: {
    trajectory: 'Initial prototype import → Render deployment hardening → Docker/Prisma/ESM fixes → Portal repositioning',
    lastCommit: 'Reposition portal and harden backend launch path',
    totalCommits: 11,
    maturity: 'Early prototype — deployment plumbing mostly done, real execution not yet enabled',
  },

  // Documentation assets
  docs: {
    business: 'BUSINESS_MODEL_AND_LAUNCH_PLAN.md, BUSINESS_PLAN.md, INVESTOR_MEMO.md, FOUNDER_PITCH_DECK.md, PRODUCT_ONE_PAGER.md',
    launch: 'ALPHA_EXECUTION_PLAN.md (14-day), LAUNCH_ROADMAP.md, LAUNCH_DECISION_CRITERIA.md',
    deployment: 'BACKEND_LAUNCH_CHECKLIST.md, DEPLOYMENT_CHECKLIST.md, DEPLOYMENT_RUNBOOK.md, DEMO_RUNBOOK.md',
    pilot: 'ALPHA_CALL_SCRIPT.md, PILOT_OUTREACH_BRIEF.md, PILOT_LEAD_SCORING.md, PARTNER_PIPELINE.md, OUTREACH_TEMPLATES.md',
    technical: 'ENGINEERING_OVERVIEW.md, EXECUTION_STATUS.md, UBIQUITOUS_LANGUAGE.md',
  },
};

const TFG_CONTEXT = {
  importantNote: 'Organism agents: you MUST check the evidence before flagging issues. This is an EARLY-STAGE PROTOTYPE (11 commits) — do not judge it as a mature product. Focus on what matters NOW for closed-alpha launch, not theoretical scale concerns. The project HONESTLY acknowledges its mock execution state (see executionState). Do not re-flag what is already known. Investigate, then speak.',

  path: 'C:/Users/rafae/OneDrive/Desktop/Tokens for Good',
  stack: 'pnpm monorepo, TypeScript strict, Next.js 15 (portal), Fastify 5 (control plane), Prisma 6 (Postgres), BullMQ (Redis queue), OpenAI API (research execution), Python 3.11 (research workers), Docker, Vercel + Render deployment',
  description: 'Compute-routing and research-orchestration platform for public-good scientific workloads. Donors contribute compute budget, platform routes to literature mining (PubMed), molecular screening (PubChem), and structured compute (ClinicalTrials.gov). First proof workflow: evidence synthesis. Philanthropic model.',
  founder: 'Rafael — anaesthesia registrar in Australia, solo founder. Also building Synapse (medical exam prep).',
  jurisdiction: 'Australia',

  codeEvidence: TFG_CODE_EVIDENCE,

  businessContext: {
    stage: 'Closed-alpha prototype. Not yet launched. 11 git commits.',
    targetUsers: 'Philanthropic donors who want to contribute compute to public-good research. Partner labs that review and act on research outputs.',
    revenueModel: 'Not yet defined — philanthropic model, donor-funded compute budget. No payment logic exists.',
    currentDeployment: 'Portal on Vercel (LIVE). Control plane + ChatGPT app on Render (LIVE with mock execution).',
    nextMilestone: 'One closed-alpha pilot with a real partner. Not broad public launch.',
    costToDate: 'Minimal — mock execution, no real OpenAI/API costs yet.',
  },
};

// The mandatory instruction appended to every agent prompt
const AGENT_DIRECTIVE = `
You have been given actual code evidence from the Tokens for Good codebase in codeEvidence. Do NOT make assumptions — use the evidence. For every finding, state:

PROBLEM: What is wrong (with file:line evidence from the codebase)
SOLUTION: Concrete implementation steps Rafael can execute

If the evidence shows a problem is already addressed, say "ALREADY ADDRESSED: [evidence]" and move on. Do not re-flag resolved issues.

Critical evidence to check BEFORE flagging:
- This is an EARLY PROTOTYPE (11 commits). Do not expect enterprise maturity.
- Mock execution is KNOWN and ACKNOWLEDGED (codeEvidence.executionState). Do not re-flag it as a discovery.
- The project HONESTLY reports its state via /health endpoint readiness checks.
- 689 test files exist (codeEvidence.testing). Do not say "no tests".
- Rate limiting EXISTS (codeEvidence.security.rateLimits). Do not say "no rate limiting".
- Webhook signature validation EXISTS (codeEvidence.security.webhookValidation).
- PHI blocking EXISTS (codeEvidence.security.phiBlocked).
- 4 demo subprojects are SEEDED (codeEvidence.database.seedSubprojects).
- Documentation is EXTENSIVE (codeEvidence.docs — business plan, investor memo, launch plan, deployment runbooks).

Focus on: what blocks closed-alpha launch with ONE real partner?
`;

// ── Task runner ─────────────────────────────────────────────────────────────

async function submitTfgReviews() {
  console.log('\n==============================================');
  console.log('Organism — 20-Agent Tokens for Good Review (Evidence-Based)');
  console.log('==============================================\n');

  // Write project context to filesystem — agents load it via loadProjectContext()
  const contextDir = path.resolve(process.cwd(), 'knowledge/projects/tokens-for-good');
  if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    path.join(contextDir, 'review-context.json'),
    JSON.stringify(TFG_CONTEXT),
    'utf8',
  );
  console.log('  Context written to knowledge/projects/tokens-for-good/review-context.json\n');

  const tasks: Array<{ id: string; label: string }> = [];

  const submit = async (label: string, agent: string, desc: string) => {
    // Context lives on filesystem — only pass lightweight task-specific fields
    const id = await submitTask(
      { description: desc + AGENT_DIRECTIVE, input: { projectId: 'tokens-for-good' }, projectId: 'tokens-for-good' },
      { agent },
    );
    tasks.push({ id, label });
    console.log(`  ${tasks.length}. ${label}: ${id.slice(0, 8)}`);
  };

  // ── 1-3: C-Suite ────────────────────────────────────────────────────────────

  await submit('Strategic Review (CEO)', 'ceo',
    'Strategic review of Tokens for Good: product-market fit for philanthropic compute-routing, competitive landscape (BOINC, Folding@home, DeSci), beachhead strategy (which subproject type proves value fastest?), 30/90/180-day roadmap to first paying partner. The project has extensive docs (investor memo, business plan, launch plan) — reference them. What is the ONE thing that matters most right now?');

  await submit('Technology Strategy (CTO)', 'cto',
    'Technology strategy: monorepo architecture quality (apps/portal, services/control-plane, services/research-workers, packages/contracts, packages/database), the in-memory-to-durable migration path (MemoryRepository → PrismaRepository, inline queue → BullMQ), Python worker integration pattern, OpenAI webhook flow. Is the architecture sound for scaling from 1 to 100 donors? What is the critical path to real execution (not mock)?');

  await submit('Financial Analysis (CFO)', 'cfo',
    'Financial analysis: unit economics of compute-routing (donor pays $12/day budget, platform routes to OpenAI/PubMed/PubChem/ClinicalTrials.gov APIs). Cost per research run (estimate from API pricing). Render hosting costs (Starter plan). Path to sustainability — when does this need revenue vs grant funding? Compare philanthropic model vs SaaS model.');

  // ── 4-5: Product ────────────────────────────────────────────────────────────

  await submit('Product Gap Analysis (PM)', 'product-manager',
    'Product gap analysis: the platform has a full donor flow (sign up → enroll → configure policy → trigger/schedule runs → view results) and operator flow (ops dashboard, review queue, campaigns, subproject management). What is MISSING for a closed-alpha pilot with one research partner? RICE-score the gaps. The 14-day alpha execution plan exists in docs — is it realistic?');

  await submit('Data & Metrics (Data Analyst)', 'data-analyst',
    'Metrics framework: the platform has ContributionMetric model (validated_runs, accepted_outputs, citations_surfaced, compute_minutes, budget_spent, partner_artifacts, validation_pass_rate), AuditEvent logging, and OperationalIncident tracking. What KPIs should the /ops/summary endpoint surface for alpha? What does "success" look like for the first pilot? Define the funnel: donor signup → first run → partner review → accepted output.');

  // ── 6-8: Engineering ────────────────────────────────────────────────────────

  await submit('Technical Architecture (Engineering)', 'engineering',
    'Architecture review: control plane app.ts is 1,343 lines (monolithic Fastify handler file), repository.ts is in-memory with prisma-repository.ts ready. Research engine manages BullMQ + in-memory queue fallback. Python workers are subprocess-invoked. 3 Docker services for local dev. Produce P0/P1/P2 list: what MUST be fixed before alpha, what SHOULD be fixed, what can wait. Focus on the in-memory → durable migration and real OpenAI execution enablement.');

  await submit('DevOps Audit (DevOps)', 'devops',
    'Infrastructure audit: Render Blueprint (render.yaml) deploys control-plane + chatgpt-app + postgres + redis. Portal on Vercel. Docker multistage builds (Node 22 Alpine). No CI/CD pipeline in .github/workflows yet. Demo mode works without Docker (pnpm demo:up). The deployment runbook and checklist exist in docs/. What is missing for production-grade deployment? Health endpoint already checks: repository, queue, verification_delivery, connector_cache, openai_research, alert_sink.');

  await submit('Security Audit (Security)', 'security-audit',
    'Security audit using codeEvidence: email verification with rate limiting EXISTS. Operator auth with SHA-256 hashed credentials EXISTS. Webhook signature validation EXISTS. PHI blocking EXISTS. EXPOSE_DEV_VERIFICATION_CODE must be false in prod (KNOWN). Find NEW issues only. Check: CORS policy (CONTROL_PLANE_ALLOWED_ORIGINS), session token entropy, closed-alpha invite code exposure in render.yaml, Australian Privacy Act 1988 compliance for research data, OWASP top 10 for Fastify + Next.js.');

  // ── 9-10: Quality ───────────────────────────────────────────────────────────

  await submit('Quality Audit (Quality Guardian)', 'quality-guardian',
    '[QUALITY AUDIT] 6-dimension audit: (1) data integrity — Prisma schema with 15+ models, seed data for 4 subprojects; (2) execution reliability — mock-only currently, real execution path exists but untested with real APIs; (3) security — auth, rate limiting, PHI blocking all exist; (4) API completeness — 30+ endpoints covering donor, operator, partner, webhook flows; (5) UX — portal has public marketing pages + donor app + operator dashboard; (6) research quality — Python workers with deterministic scoring, citation tracking, confidence scores. Assess: is the ARCHITECTURE ready for real execution? What breaks first when you flip OPENAI_ENABLE_REAL_CALLS=true?');

  await submit('Research Workflow Review', 'medical-content-reviewer',
    'Research workflow review: the platform routes 3 workload types — literature_mining (PubMed), molecular_screening (PubChem compound scoring with Lipinski-like heuristic), structured_compute (ClinicalTrials.gov trial ranking). Python workers return { summary, confidence, citations, payload }. Scoring is deterministic and transparent. Review: are the scoring heuristics scientifically sound? Is the citation chain trustworthy? What happens when real OpenAI rewrites prompts — does the deterministic quality degrade? Partner review flow exists — is it sufficient for research governance?');

  // ── 11-15: Marketing ────────────────────────────────────────────────────────

  await submit('Marketing Strategy', 'marketing-strategist',
    'Marketing strategy for Tokens for Good: philanthropic compute-routing is a novel category. Competitors: BOINC (volunteer computing, no AI), Folding@home (protein folding only), DeSci protocols (crypto-heavy, different audience). The portal has 9 public marketing pages (/, /how-it-works, /research-paths, /impact, /partners, /faq, /transparency, /alpha, /pilot). Product is NOT ready for public launch — next milestone is ONE closed-alpha pilot. Who is the ideal first partner? What messaging resonates?');

  await submit('Marketing Execution Plan', 'marketing-executor',
    'Marketing execution plan for closed-alpha partner acquisition: the target is ONE research lab or foundation willing to pilot. Docs include ALPHA_CALL_SCRIPT.md, PILOT_OUTREACH_BRIEF.md, PILOT_LEAD_SCORING.md, PARTNER_PIPELINE.md, OUTREACH_TEMPLATES.md. These exist — review them and assess: are they good enough to close a pilot? 30-day outreach calendar. Budget: founder time only, $0 ad spend.');

  await submit('SEO Analysis (SEO)', 'seo',
    'SEO analysis for philanthropic compute and research-orchestration: the portal is on Vercel (Next.js 15). What are the high-intent keywords for this category? (e.g., "donate compute for research", "AI for social good", "philanthropic research platform"). Technical SEO: does the Next.js setup support SSR/SSG for marketing pages? Content gaps vs competitors. Domain authority strategy.');

  await submit('Community Strategy', 'community-manager',
    'Community strategy: Tokens for Good targets the intersection of philanthropy, AI research, and open science. Map the communities: DeSci Discord/Telegram, effective altruism networks, research lab Slack communities, biotech Twitter/X, clinical research forums. Rafael is a medical doctor — how does that credibility help? 30-day engagement plan for finding the first pilot partner.');

  await submit('PR & Comms Plan', 'pr-comms',
    'PR plan: founder story (anaesthesia registrar builds philanthropic compute-routing platform), media targets (science/tech press, philanthropy media, medical innovation outlets). The project has a PRODUCT_ONE_PAGER.md and INVESTOR_MEMO.md. Assess: is the story compelling enough for press? When should PR begin — before or after first pilot? Define readiness criteria.');

  // ── 16-20: Operations ───────────────────────────────────────────────────────

  await submit('Legal Review (AU)', 'legal',
    'Australian legal review: Privacy Act 1988 (research data — is donor email PII?), Australian Consumer Law (what claims can be made about research impact?), AHPRA considerations (founder is a medical practitioner), IP for AI-generated research outputs, data sovereignty (Render is US-based Oregon region). The platform has SensitivityClass enum (public, restricted, phi_blocked) and PHI blocking — is this sufficient? Terms of service requirements for closed-alpha.');

  await submit('Sales Strategy', 'sales',
    'Sales strategy for first partner acquisition: the platform supports partner review flows (submit_partner_review MCP tool, /runs/:id/review API, partner event campaigns). Pricing: philanthropic model (donors fund, partners receive) vs SaaS (partners pay for access). What does the partnership agreement look like? What does a pilot partner need to see to say yes? Reference docs: PILOT_OUTREACH_BRIEF.md, PARTNER_PIPELINE.md.');

  await submit('Customer Success Plan', 'customer-success',
    'Customer success for two user types: (1) DONORS — journey from signup (/start) → enroll in subprojects → configure policy (auto mode, budget, quiet hours) → trigger runs → view results with citations. (2) PARTNERS — receive research outputs → review queue → approve/request changes → campaign fanout. Design the onboarding flow for each. What does retention look like for a philanthropic platform? Churn drivers?');

  await submit('HR & Team Plan', 'hr',
    'Team plan: Rafael is solo-building two products (Synapse + Tokens for Good). When should he hire? What role first — backend engineer (to enable real execution) or research partnerships manager (to close pilots)? At what milestone? Assess the 20-agent Organism roster — does it cover what TfG needs, or are there gaps (e.g., a research domain specialist agent)?');

  await submit('Competitive Intelligence', 'ceo',
    'Competitive intelligence: all competitors in philanthropic compute, citizen science, and AI-for-good: BOINC, Folding@home, Zooniverse, DeSci protocols (VitaDAO, LabDAO, ResearchHub), traditional CROs, OpenAI for Nonprofits. Feature comparison matrix. Defensible moat: is "compute-routing with partner review and citation tracking" unique? What would a well-funded competitor need to replicate this?');

  // ── Dispatch loop ─────────────────────────────────────────────────────────

  console.log(`\n${tasks.length} tasks submitted. Processing...\n`);

  let round = 0;
  const maxRounds = 40;
  while (round < maxRounds) {
    round++;
    const { getPendingTasks } = await import('../packages/core/src/task-queue.js');
    const pending = getPendingTasks();
    if (pending.length === 0) { console.log('All tasks processed.\n'); break; }
    const agentList = [...new Set(pending.map(t => t.agent))].join(', ');
    console.log(`Round ${round}: ${pending.length} pending [${agentList}]`);
    await dispatchPendingTasks();
    await sleep(300);
  }

  // ── Synthesis: consolidate all agent outputs into one report ────────────
  console.log('\n=== Running Synthesis Agent ===\n');
  {
    const { getTask: getTaskForSynthesis, getCompletedTasksForProject, createTask: createSynthesisTask } = await import('../packages/core/src/task-queue.js');
    const completedTasks = getCompletedTasksForProject('tokens-for-good', 2 * 60 * 60 * 1000);
    const agentOutputs = completedTasks
    .filter(t => t.agent !== 'synthesis' && t.agent !== 'domain-model' && t.agent !== 'grill-me' && t.agent !== 'codex-review' && t.agent !== 'quality-agent')
      .map(t => {
        const out = t.output as Record<string, unknown> | null;
        const text = out
          ? ((out.text as string) ?? (out.implementation as string) ?? (out.report as string) ?? JSON.stringify(out).slice(0, 2000))
          : '';
        return { agent: t.agent, description: t.description.slice(0, 200), output: text.slice(0, 2000) };
      });

    if (agentOutputs.length > 0) {
      try {
        createSynthesisTask({
          agent: 'synthesis',
          lane: 'LOW',
          description: `Synthesis report: ${agentOutputs.length} agent outputs from Tokens for Good review`,
          input: { agentOutputs, projectId: 'tokens-for-good' },
          projectId: 'tokens-for-good',
        });
        console.log(`Synthesis task created for ${agentOutputs.length} agent outputs. Dispatching...\n`);

        // Run one more dispatch round to execute the synthesis
        await dispatchPendingTasks();
        await sleep(300);
        // One more round in case of queuing delay
        await dispatchPendingTasks();
      } catch (err) {
        console.warn('Synthesis task skipped:', (err as Error).message);
      }
    } else {
      console.log('No completed agent outputs to synthesize.\n');
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────

  console.log('\n=== Review Results ===\n');
  const { getTask } = await import('../packages/core/src/task-queue.js');
  for (const { id, label } of tasks) {
    const task = getTask(id)!;
    const icon = task.status === 'completed' ? '[OK]' : task.status === 'failed' ? '[FAIL]' : '[...]';
    console.log(`${icon} ${label}: ${task.status} — $${(task.costUsd ?? 0).toFixed(4)}`);
  }

  console.log('\n=== Agent Outputs ===\n');
  for (const { id, label } of tasks) {
    const task = getTask(id)!;
    if (task.status !== 'completed' || !task.output) continue;
    const out = task.output as Record<string, unknown>;
    const text = (out.text as string) ?? (out.implementation as string) ?? (out.report as string) ?? '';
    if (!text) continue;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`## ${label}\n`);
    console.log(text.slice(0, 2000));
    if (text.length > 2000) console.log(`\n[... ${text.length - 2000} more chars in state/tasks.db]`);
  }

  const { getSystemSpend } = await import('../packages/core/src/budget.js');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total cost: $${getSystemSpend().toFixed(4)}`);
  console.log('Full outputs: state/tasks.db\n');
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

submitTfgReviews().catch(err => { console.error('Review failed:', err); process.exit(1); });
