/**
 * Full multi-agent review of the Synapse UX redesign.
 * Agents assess: design migration, code implementation, UX impact, medical UX safety.
 * Pipeline: Agent (8192 tokens) → Quality Agent → Codex Review (GPT-5.4)
 */

import { submitTask } from '../packages/core/src/orchestrator.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { getPendingTasks, getTask } from '../packages/core/src/task-queue.js';
import { getSystemSpend } from '../packages/core/src/budget.js';
import * as fs from 'fs';

const REDESIGN_CONTEXT = {
  importantNote: 'The baseline design at knowledge/projects/synapse/ux-baseline-design.html is APPROVED by Rafael. Do not question whether to do the redesign — assess HOW to do it well. For every finding, state PROBLEM + SOLUTION.',

  baselineDesign: 'knowledge/projects/synapse/ux-baseline-design.html',

  newDesignSystem: {
    palette: { page: '#f6f6f2', panel: '#efefe6', card: '#ffffff', dark: '#0b382a', lime: '#d2fb33', limeHover: '#c4ec2a', text: '#1a201d', textSecondary: '#78827d', border: '#e4e4df' },
    typography: { family: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, sans-serif', headingWeight: 500, headingTracking: '-0.02em' },
    radii: { sm: '4px', md: '8px', lg: '12px', pill: '999px' },
    layout: { maxWidth: '1080px', containerPadding: '48px', gridGap: '24px' },
    components: ['SM-2 hero card (dark green, lime badge)', '2x2 mode grid (MCQ/SAQ/VIVA/Feynman)', 'Segmented controls (Learn/Simulate/Review)', 'Domain Mastery chart panel', 'Pill buttons', 'Card-based layout'],
  },

  currentDesignSystem: {
    name: 'Sand & Stone',
    dayMode: { bg: '#f7f3ee', surface: '#f0ebe4', card: '#ffffff', accent: '#c4622c', text: '#3d2e22', textSecondary: '#9a8878' },
    nightMode: { bg: '#1e1710', surface: '#161209', card: '#2a2018', accent: '#e07840', text: '#f0e8dc' },
    colleges: { ANZCA: '#1e3a5f', CICM: '#0d7377', ACEM: '#8b1a1a' },
    domains: '8 medical domains with --domain-X, --domain-X-bg, --domain-X-border CSS vars',
    layout: 'Sidebar 220px fixed (desktop), top 48px + bottom tabs 56px (mobile)',
    buttons: '11px 22px padding, 9px radius (NOT pills)',
    responsive: '768px and 480px breakpoints',
    themeSwitch: 'data-theme="dark" on html element, localStorage synapse-theme',
    collegSwitch: 'data-college="anzca|cicm|acem" on html element, localStorage synapse-college',
  },

  codebaseFacts: {
    styling: 'Pure CSS variables in globals.css + Tailwind 4 via PostCSS. No tailwind.config.ts — all tokens are CSS vars.',
    pages: 'MCQ 2,258 lines, SAQ 2,576 lines, VIVA 1,983 lines — all client components with inline styles using CSS vars',
    uiComponents: 'Breadcrumbs, ContentComingSoon, Navigation, NavigationWrapper, Skeleton, UserTagManager, useTabKeyboard',
    domainColors: 'Referenced as var(--domain-physiology) etc in component code — NOT hardcoded hex',
    mcqStructure: 'Screens: home → quiz → exam_review → finish. Uses ExamContext for college/type. SM-2 integrated.',
    accessibility: 'ARIA tabs, skip-to-content, focus-visible, prefers-reduced-motion, hover guards (all added Session 8)',
  },

  designAgentOutput: 'state/ux-redesign-output.txt (25,751 chars) — contains full component mapping, CSS variable migration, dark mode tokens, mobile breakpoints, implementation sequence (5 phases, 17-25 days)',
};

async function run() {
  console.log('\n==============================================');
  console.log('Organism — UX Redesign Full Review');
  console.log('==============================================\n');

  const tasks: Array<{ id: string; label: string }> = [];

  const submit = async (label: string, agent: string, desc: string) => {
    const id = await submitTask(
      { description: desc, input: { context: REDESIGN_CONTEXT }, projectId: 'synapse' },
      { agent },
    );
    tasks.push({ id, label });
    console.log(`  ${tasks.length}. ${label}: ${id.slice(0, 8)}`);
  };

  // Design deep-dive
  await submit('Design System Migration (Design)', 'design',
    'Detailed design system migration plan: map every CSS variable from Sand & Stone to the new lime/green system. Include: (1) exact CSS variable rename table with old→new values, (2) dark mode token layer (the new design has no night mode — design one using #0b382a as the dark base), (3) college accent survival strategy (ANZCA blue, CICM teal, ACEM crimson must coexist with lime green), (4) domain color tokens (8 medical domains) — do they change or stay?, (5) component-by-component migration for Navigation, Breadcrumbs, Skeleton, buttons, cards, grids. Reference codebaseFacts for how styles are currently applied.');

  // Engineering implementation plan
  await submit('Implementation Plan (Engineering)', 'engineering',
    'Engineering implementation plan for the UX redesign. The design agent produced a 25K-char spec at state/ux-redesign-output.txt with 5 phases (17-25 days). Your job: (1) assess feasibility for a solo founder working evenings/weekends, (2) identify the riskiest migration steps (which files touch the most shared state?), (3) produce a file-by-file change list for Phase 1 (CSS token layer), (4) identify what can be done WITHOUT touching the 2,258/2,576/1,983 line page files, (5) recommend a feature flag strategy so the redesign can be shipped incrementally. Reference codebaseFacts — styles are CSS vars in globals.css + Tailwind 4.');

  // CTO architecture assessment
  await submit('Architecture Assessment (CTO)', 'cto',
    'Architecture assessment for the UX redesign migration. Key questions: (1) Should the redesign be done as a CSS-variable-only swap (change globals.css, pages adapt automatically) or does it require component rewrites?, (2) The current pages are 2,000-2,500 lines — should the redesign be combined with the component decomposition (extract hooks) or kept separate?, (3) Is a design system library (e.g., a shared components/ package with the new system) worth building, or is CSS vars + Tailwind sufficient?, (4) What is the rollback strategy if the redesign breaks something?, (5) Build vs buy: should we use a component library like shadcn/ui adapted to the new palette?');

  // Product impact
  await submit('Product Impact (PM)', 'product-manager',
    'Product impact assessment of the UX redesign. (1) Which features are most at risk during migration (SM-2, SAQ photo grading, VIVA voice)?, (2) What user-facing changes will ANZCA trainees notice immediately?, (3) Should the redesign ship all-at-once or page-by-page?, (4) What is the risk of changing the visual identity mid-enrichment-pipeline (users who started with Sand & Stone see a completely different app)?, (5) Prioritise: which single page should be redesigned first for maximum user impact with minimum risk?');

  // Customer Success — user impact
  await submit('User Experience Impact (Customer Success)', 'customer-success',
    'User experience impact of the redesign on medical trainees. (1) The SM-2 hero card makes due items the first thing users see — what is the expected retention impact?, (2) Changing from warm (terracotta) to cool (lime/green) — does this affect study mood/focus for late-night sessions?, (3) The new design removes the sidebar navigation — what is the impact on users who learned the current nav?, (4) Card-based mode selection vs current approach — faster or slower to start a study session?, (5) The college selector is hidden — will CICM/ACEM users feel the product is ANZCA-first?');

  // Medical content UX safety
  await submit('Medical UX Safety (Medical Content)', 'medical-content-reviewer',
    'Medical UX safety review of the redesign. (1) The SM-2 hero card shows "42 Items Due" — is the number anxiety-inducing for stressed exam candidates? Should it show encouragement instead?, (2) Domain Mastery chart shows a score trajectory — could a downward trend discourage a trainee from studying?, (3) The "Feynman Mode" card is given equal visual weight to MCQ/SAQ/VIVA — is this appropriate or does it confuse trainees who expect only exam formats?, (4) Color psychology: lime green on dark green for a medical exam tool — does this feel trustworthy to medical professionals?, (5) The segmented control (Learn/Simulate/Review) — does this map to how ANZCA trainees actually think about study modes?');

  // SEO impact
  await submit('SEO Impact (SEO)', 'seo',
    'SEO impact of the UX redesign. (1) URL structure — does the redesign change any routes?, (2) The new design uses system fonts — any web font loading benefit?, (3) Will the new CSS reduce first contentful paint?, (4) If we add a landing page with the new design, what content structure maximizes ANZCA exam prep search intent?, (5) Meta tags and OpenGraph — does the new green/lime branding need new OG images?');

  // DevOps — deployment strategy
  await submit('Deployment Strategy (DevOps)', 'devops',
    'Deployment strategy for the UX redesign. (1) Feature flag approach: how to ship the new design incrementally on Vercel (preview vs production), (2) A/B testing: can we run Sand & Stone and the new design simultaneously for different users?, (3) Rollback plan: if the redesign causes issues, how fast can we revert?, (4) CSS-only deployment: can Phase 1 (token swap) be deployed without code changes?, (5) Preview URL strategy: should each phase get its own preview deployment for Rafael to review?');

  console.log(`\n${tasks.length} tasks submitted. Processing pipeline...\n`);

  let round = 0;
  while (round < 40) {
    round++;
    const pending = getPendingTasks();
    if (pending.length === 0) { console.log('All tasks processed.'); break; }
    const agents = [...new Set(pending.map(t => t.agent))].join(', ');
    console.log(`Round ${round}: ${pending.length} pending → [${agents}]`);
    await dispatchPendingTasks();
    await new Promise(r => setTimeout(r, 2000));
  }

  // Results
  console.log('\n=== Results ===\n');
  for (const { id, label } of tasks) {
    const task = getTask(id)!;
    const icon = task.status === 'completed' ? '[OK]' : task.status === 'failed' ? '[FAIL]' : '[...]';
    console.log(`${icon} ${label}: ${task.status} — $${(task.costUsd ?? 0).toFixed(4)}`);
  }

  // Save full output
  const outputLines: string[] = [`UX Redesign Review — ${new Date().toISOString()}\nCost: $${getSystemSpend().toFixed(4)}\n`];
  for (const { id, label } of tasks) {
    const task = getTask(id)!;
    if (task.status !== 'completed' || !task.output) continue;
    const out = task.output as Record<string, unknown>;
    const text = (out.spec as string) ?? (out.text as string) ?? (out.implementation as string) ?? '';
    if (!text) continue;
    outputLines.push(`\n${'='.repeat(60)}\n## ${label}\n${'='.repeat(60)}\n${text}`);
  }
  fs.writeFileSync('state/ux-redesign-review.txt', outputLines.join('\n'));
  console.log(`\nFull output: state/ux-redesign-review.txt (${outputLines.join('\n').length} chars)`);
  console.log(`Total cost: $${getSystemSpend().toFixed(4)}\n`);
}

run().catch(console.error);
