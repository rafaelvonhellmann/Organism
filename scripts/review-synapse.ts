/**
 * Full multi-agent Synapse review — 20 agents with ACTUAL CODE EVIDENCE.
 * Context includes real code snippets, audit file references, and pipeline state.
 * Run: npm run review-synapse
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { submitTask } from '../packages/core/src/orchestrator.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { filterDueAgents } from '../packages/core/src/review-scheduler.js';
import { createCycle, completeCycle } from '../packages/core/src/task-queue.js';

// ── Actual code evidence from the Synapse codebase ──────────────────────────
// These are REAL snippets, not metadata. Agents must reference these, not guess.
const SYNAPSE_CODE_EVIDENCE = {
  // BYPASS_AUTH — ACTUALLY hardcoded false, NOT an env var
  bypassAuth: {
    file: 'components/auth/AuthGate.tsx',
    line6: 'const BYPASS_AUTH = false;',
    line25: 'if (BYPASS_AUTH) return <>{children}</>;',
    verdict: 'HARDCODED FALSE in code. Not an env var. Auth is ACTIVE.',
  },

  // Middleware — rate limiting on API routes only
  middleware: {
    file: 'middleware.ts',
    scope: 'Rate limits on /api/* routes only (60/min saqs, 30/min others). Auth handled by AuthGate client-side + Supabase RLS.',
  },

  // Copyright — ALREADY AUDITED in tasks/copyright_audit.md
  copyrightAudit: {
    file: 'tasks/copyright_audit.md',
    exists: true,
    keyFinding: 'Topics are NOT copyrightable. Specific wording IS. Safe harbour: same topic + different wording = SAFE. Audit script exists: processor/audit_copyright_risk.cjs',
    actions: 'Rewrite flagged questions (verbatim recalls with exam codes). Strip exam year references. Add originality review to enrichment pipeline.',
  },

  // Security audit — ALREADY DONE in tasks/security_audit.md
  securityAudit: {
    file: 'tasks/security_audit.md',
    exists: true,
  },

  // CI pipeline — EXISTS
  ciPipeline: {
    file: '.github/workflows/ci.yml',
    steps: 'typecheck + lint + tests + build',
  },

  // Enrichment state from master_tasklist.md
  enrichmentPipeline: {
    status: 'IN PROGRESS',
    order: 'LOs (DONE) → SAQ re-enrichment (458 need citations, ~$85, NEXT) → VIVA model_answer (1,764, ~$380) → then CICM/ACEM',
    totalSpent: '~$1,039 USD',
    remaining: '~$815-1,005 USD',
  },

  // Rate limiting — Upstash Redis DEPLOYED
  rateLimiting: {
    middleware: 'Upstash Redis in production, in-memory fallback for dev',
    limits: '/api/saqs 60/min, /api/learning-objectives 30/min, /api/mcq-meta 30/min',
  },

  // Tests — 133 unit + 19 Playwright e2e
  testing: {
    unit: '133 tests across 15 files',
    e2e: '19 Playwright specs',
    sm2: '18 unit tests on sm2.ts alone',
  },
};

const SYNAPSE_CONTEXT = {
  importantNote: 'Organism agents: you MUST check the evidence before flagging issues. Previous reviews incorrectly flagged BYPASS_AUTH as a live risk (it is hardcoded false), incorrectly said no copyright audit existed (tasks/copyright_audit.md is thorough), and incorrectly said no CI pipeline exists (GitHub Actions CI runs typecheck+lint+tests+build). Do not repeat these errors. Investigate, then speak.',

  path: 'C:/Users/rafae/OneDrive/Desktop/synapse',
  stack: 'Next.js 16, React 19, TypeScript strict, Tailwind v4, Supabase (Postgres + pgvector), Claude API (Sonnet/Opus), OpenAI (Whisper/TTS/embeddings), Vercel, Upstash Redis, Sentry',
  description: 'AI-powered exam preparation platform for anaesthesia and emergency medicine primary exams. ANZCA, ACEM, CICM colleges. Modes: MCQ, SAQ (photo grading via Claude vision), VIVA (voice examiner role-play).',
  founder: 'Rafael — anaesthesia registrar in Australia, solo founder.',
  jurisdiction: 'Australia',

  codeEvidence: SYNAPSE_CODE_EVIDENCE,

  database: {
    learning_objectives: '1,186 rows. ANZCA 330/330 DONE. CICM 76/247 (31%). ACEM 0/609.',
    saqs: '1,208 rows. ANZCA 551 enriched, 458 missing citations — re-enrichment queued (~$85). CICM 558/657 (85%).',
    mcq_questions: '3,234 rows. ANZCA 1,427 DONE. CICM 264 DONE. ACEM 1,161/1,543 (75%).',
    viva_questions: '1,881 rows. ANZCA 0/1,764 model_answer (outlines only, ~$380). ACEM 0/117.',
    document_chunks: '~333,804 rows (301K ANZCA + 32K ACEM).',
    sources: '57 books (47 ANZCA + 10 ACEM).',
  },

  keyFiles: {
    mcqPage: 'app/mcq/page.tsx (2,258 lines)',
    saqPage: 'app/saq/page.tsx (2,576 lines)',
    vivaPage: 'app/viva/page.tsx (1,983 lines)',
    examConfig: 'lib/exam-config.ts',
    sm2: 'lib/sm2.ts (18 unit tests)',
    enrichmentScripts: 'processor/enrich_*.cjs',
    qualityAudit: 'processor/quality_audit.cjs (18 checks)',
    copyrightAudit: 'tasks/copyright_audit.md',
    securityAudit: 'tasks/security_audit.md',
    tasklist: 'tasks/master_tasklist.md (GROUND TRUTH)',
  },

  businessContext: {
    targetUsers: 'Medical trainees: ANZCA (anaesthesia), ACEM (emergency), CICM (intensive care)',
    revenueModel: 'Not yet defined — no paywall or payment logic exists.',
    currentDeployment: 'Vercel. GitHub Actions CI. Sentry + Vercel Analytics live.',
    competition: 'No direct competitor does MCQ+SAQ+VIVA with AI for AU colleges.',
    costToDate: '~$1,039 in enrichment API costs',
  },
};

// The mandatory instruction appended to every agent prompt
const AGENT_DIRECTIVE = `
You have been given actual code evidence from the Synapse codebase in codeEvidence. Do NOT make assumptions — use the evidence. For every finding, state:

PROBLEM: What is wrong (with file:line evidence from the codebase)
SOLUTION: Concrete implementation steps Rafael can execute

If the evidence shows a problem is already addressed, say "ALREADY ADDRESSED: [evidence]" and move on. Do not re-flag resolved issues.

Critical evidence to check BEFORE flagging:
- BYPASS_AUTH is hardcoded FALSE (components/auth/AuthGate.tsx line 6). Auth is active.
- Copyright audit EXISTS (tasks/copyright_audit.md). Audit script exists at processor/audit_copyright_risk.cjs.
- Security audit EXISTS (tasks/security_audit.md).
- CI pipeline EXISTS (.github/workflows/ci.yml — typecheck+lint+tests+build).
- Rate limiting DEPLOYED (Upstash Redis, middleware.ts).
- Tests EXIST (133 unit + 19 e2e Playwright).
`;

// ── Task runner ─────────────────────────────────────────────────────────────

async function submitSynapseReviews() {
  console.log('\n==============================================');
  console.log('Organism — Synapse Review with Self-Scheduling (Evidence-Based)');
  console.log('==============================================\n');

  // Write project context to filesystem — agents load it via loadProjectContext()
  const contextDir = path.resolve(process.cwd(), 'knowledge/projects/synapse');
  if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    path.join(contextDir, 'review-context.json'),
    JSON.stringify(SYNAPSE_CONTEXT),
    'utf8',
  );
  console.log('  Context written to knowledge/projects/synapse/review-context.json\n');

  // ── Self-scheduling: filter to only agents due for review ──────────────
  const allAgents = [
    'ceo', 'cto', 'cfo', 'product-manager', 'data-analyst',
    'engineering', 'devops', 'security-audit', 'quality-guardian',
    'medical-content-reviewer', 'marketing-strategist', 'marketing-executor',
    'seo', 'community-manager', 'pr-comms', 'legal', 'sales',
    'customer-success', 'hr',
  ];
  const dueAgents = filterDueAgents(allAgents, 'synapse');
  const dueSet = new Set(dueAgents);
  console.log(`  ${dueAgents.length}/${allAgents.length} agents due for review (${allAgents.length - dueAgents.length} skipped by self-scheduling)\n`);

  const tasks: Array<{ id: string; label: string }> = [];
  let skipped = 0;

  const submit = async (label: string, agent: string, desc: string) => {
    // Skip agents that self-scheduled themselves out of this review
    if (!dueSet.has(agent)) {
      skipped++;
      console.log(`  [SKIP] ${label} (${agent} not due yet)`);
      return;
    }
    // Context lives on filesystem — only pass lightweight task-specific fields
    const id = await submitTask(
      { description: desc + AGENT_DIRECTIVE, input: { projectId: 'synapse' }, projectId: 'synapse' },
      { agent },
    );
    tasks.push({ id, label });
    console.log(`  ${tasks.length}. ${label}: ${id.slice(0, 8)}`);
  };

  // ── 1-3: C-Suite ────────────────────────────────────────────────────────────

  await submit('Strategic Review (CEO)', 'ceo',
    'Strategic review: product-market fit for ANZCA Primary beachhead, 80/20 analysis of remaining work, revenue model gap (no paywall exists), 30/90/180-day roadmap. Enrichment is IN PROGRESS (see codeEvidence.enrichmentPipeline). Focus on what to do AFTER enrichment completes.');

  await submit('Technology Strategy (CTO)', 'cto',
    'Technology strategy: architecture decisions (2,000-2,500 line page components need splitting), scalability ceiling with Supabase + Vercel, build-vs-buy for remaining features, when to hire. Reference codeEvidence for testing/CI/rate-limiting state.');

  await submit('Financial Analysis (CFO)', 'cfo',
    'Financial analysis: enrichment cost tracking (codeEvidence.enrichmentPipeline — $1,039 spent, ~$815-1,005 remaining), unit economics for AUD $49/mo SaaS, burn rate, 90-day forecast. Model: what MRR covers the remaining enrichment cost?');

  // ── 4-5: Product ────────────────────────────────────────────────────────────

  await submit('Product Gap Analysis (PM)', 'product-manager',
    'Product gap analysis: RICE-scored backlog across all 3 colleges. SAQ re-enrichment is NEXT ($85), then VIVA model_answers ($380). What remains AFTER enrichment? Auth redesign, payment, CICM/ACEM content. Prioritise by user impact.');

  await submit('Data & Metrics (Data Analyst)', 'data-analyst',
    'Metrics framework: define pre-launch KPIs, analytics funnel (signup → first question → session depth → retention), SQL queries for Supabase. Note: Vercel Analytics + Sentry already deployed (codeEvidence.ciPipeline). What is measurable TODAY vs what needs instrumentation?');

  // ── 6-8: Engineering ────────────────────────────────────────────────────────

  await submit('Technical Architecture (Engineering)', 'engineering',
    'Architecture review of actual codebase: app/mcq/page.tsx (2,258 lines), app/saq/page.tsx (2,576 lines), app/viva/page.tsx (1,983 lines) — all monolithic. Tests exist (codeEvidence.testing: 133 unit + 19 e2e). CI exists (codeEvidence.ciPipeline). Produce P0/P1/P2 refactor list with file:line evidence. Do NOT flag missing tests/CI — they exist.');

  await submit('DevOps Audit (DevOps)', 'devops',
    'Infrastructure audit: Vercel deployment, GitHub Actions CI (codeEvidence.ciPipeline), Supabase (no staging — Branching available on Pro plan), Sentry + Vercel Analytics. Rate limiting via Upstash Redis DEPLOYED (codeEvidence.rateLimiting). What is the gap between current infra and production-ready for 500 concurrent users?');

  await submit('Security Audit (Security)', 'security-audit',
    'Security audit using codeEvidence: BYPASS_AUTH is HARDCODED FALSE (codeEvidence.bypassAuth — line 6 of AuthGate.tsx). Auth IS active. RLS hardened in sessions 3+7. Rate limiting DEPLOYED (codeEvidence.rateLimiting). Security audit EXISTS (codeEvidence.securityAudit). Find NEW issues only — do not re-flag resolved items. Check: CSP headers, service role key exposure, Australian Privacy Act 1988 compliance for medical study data.');

  // ── 9-10: Quality ───────────────────────────────────────────────────────────

  await submit('Quality Audit (Quality Guardian)', 'quality-guardian',
    '[QUALITY AUDIT] 6-dimension audit using codeEvidence: (1) data integrity — 458 SAQs missing citations, re-enrichment queued; (2) grading accuracy; (3) security — auth ACTIVE per codeEvidence.bypassAuth; (4) college completeness; (5) UX; (6) AI safety. Assess risk AFTER planned enrichment completes, not before.');

  await submit('Medical Content Review', 'medical-content-reviewer',
    'Medical content review: validate enrichment quality for ANZCA SAQs (551 enriched, 458 need citation re-enrichment), VIVA outlines (1,764 have outlines, no model_answer yet), MCQ explanations (1,427 enriched). Check medical accuracy, Bloom\'s taxonomy alignment, safety of AI examiner role-play. Reference codeEvidence for actual state.');

  // ── 11-15: Marketing ────────────────────────────────────────────────────────

  await submit('Marketing Strategy', 'marketing-strategist',
    'Marketing strategy for ANZCA Primary beachhead: Rafael is a registrar (insider credibility), zero budget, tight-knit community. Product NOT ready for public launch (enrichment in progress, no paywall). When should marketing begin? What can be done NOW vs post-launch?');

  await submit('Marketing Execution Plan', 'marketing-executor',
    'Marketing execution plan: 30-day content calendar for post-enrichment launch. Channels: ANZCA Facebook groups, organic SEO, registrar network. Budget: 5-7 hrs/week of founder time, $0 ad spend. Include specific post templates.');

  await submit('SEO Analysis (SEO)', 'seo',
    'SEO analysis: top 20 high-intent keywords for ANZCA/ACEM/CICM exam prep in Australia. Technical SEO for Next.js (sitemap.ts, robots.ts, OpenGraph already deployed). Content gaps. Competitor keyword analysis.');

  await submit('Community Strategy', 'community-manager',
    'Community strategy in Australian medical trainee networks: map ANZCA/ACEM/CICM communities (Facebook groups, hospital networks, college forums). 30-day engagement calendar. Rafael is inside the community as a registrar — leverage that.');

  await submit('PR & Comms Plan', 'pr-comms',
    'PR plan: founder story (registrar builds exam prep tool while studying), media targets (ANZCA Bulletin, MJA InSight+), launch sequence. Define readiness criteria — when is Synapse ready to pitch?');

  // ── 16-20: Operations ───────────────────────────────────────────────────────

  await submit('Legal Review (AU)', 'legal',
    'Australian legal review: Privacy Act 1988 (medical study data), Australian Consumer Law (incomplete college content risk), AHPRA considerations, TGA SaMD assessment, IP for AI-generated content. Copyright audit EXISTS (codeEvidence.copyrightAudit) — do not duplicate, review and extend. Terms of service requirements.');

  await submit('Sales Strategy', 'sales',
    'Sales strategy: pricing model (competitors charge $150-300/yr for MCQ-only), institutional angle (hospital training programs), referral mechanics. No paywall exists yet — propose the pricing architecture and Stripe integration sequence.');

  await submit('Customer Success Plan', 'customer-success',
    'Customer success: user journey from first visit to exam day, retention metrics for seasonal medical exam prep (users study in bursts), onboarding flow design, NPS for medical trainees, churn prevention.');

  await submit('HR & Team Plan', 'hr',
    'Team plan: when should Rafael hire engineer #1? What role? At what MRR milestone? Assess the 20-agent Organism roster — gaps or redundancies?');

  await submit('Competitive Intelligence', 'ceo',
    'Competitive intelligence: all competitors in Australian medical exam prep (ANZCA/ACEM/CICM), global medical ed-tech, adjacent markets. Defensible moat of AI VIVA + SAQ grading. Feature comparison matrix.');

  // ── Dispatch loop ─────────────────────────────────────────────────────────

  console.log(`\n${tasks.length} tasks submitted (${skipped} skipped by self-scheduling). Processing...\n`);

  // ── Record review cycle ──────────────────────────────────────────────────
  const cycleId = crypto.randomUUID();
  try {
    createCycle(cycleId, 'synapse', tasks.length, dueAgents.length);
    console.log(`  Cycle ${cycleId.slice(0, 8)} created (${tasks.length} tasks, ${dueAgents.length} agents)\n`);
  } catch (err) {
    console.warn('Cycle creation skipped:', (err as Error).message);
  }

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
    const completedTasks = getCompletedTasksForProject('synapse', 2 * 60 * 60 * 1000);
    const agentOutputs = completedTasks
      .filter(t => t.agent !== 'synthesis' && t.agent !== 'grill-me' && t.agent !== 'codex-review' && t.agent !== 'quality-agent')
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
          description: `Synthesis report: ${agentOutputs.length} agent outputs from Synapse review`,
          input: { agentOutputs, projectId: 'synapse' },
          projectId: 'synapse',
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

  // ── Complete the review cycle ──────────────────────────────────────────
  try {
    completeCycle(cycleId);
    console.log(`  Cycle ${cycleId.slice(0, 8)} completed.\n`);
  } catch (err) {
    console.warn('Cycle completion skipped:', (err as Error).message);
  }

  const { getSystemSpend } = await import('../packages/core/src/budget.js');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Total cost: $${getSystemSpend().toFixed(4)}`);
  console.log('Full outputs: state/tasks.db\n');

  // Auto-sync to Turso so dashboard sees results
  try {
    const { execSync } = await import('child_process');
    console.log('Syncing to Turso...');
    execSync('npx tsx --experimental-sqlite scripts/sync-to-turso.ts', { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit' });
    console.log('Synced to Turso.\n');
  } catch { console.warn('Turso sync skipped (non-critical).\n'); }
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

submitSynapseReviews().catch(err => { console.error('Review failed:', err); process.exit(1); });
