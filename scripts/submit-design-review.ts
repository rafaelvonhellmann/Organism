import { submitTask } from '../packages/core/src/orchestrator.js';
import { dispatchPendingTasks } from '../packages/core/src/agent-runner.js';
import { getPendingTasks, getTask } from '../packages/core/src/task-queue.js';
import { getSystemSpend } from '../packages/core/src/budget.js';
import * as fs from 'fs';

const taskDesc = `UX redesign assessment for Synapse. A new baseline design exists at knowledge/projects/synapse/ux-baseline-design.html.

NEW DESIGN SYSTEM:
- Palette: lime green (#d2fb33) on dark green (#0b382a), cream backgrounds (#f6f6f2)
- Typography: -apple-system, 500 weight headings, -0.02em letter spacing
- Components: pill buttons, card-based layout, segmented controls, data panels
- Layout: max-width 1080px, 48px container padding, 24px grid gap
- Hero: Daily Review Queue (SM-2) as dark card with lime accent
- Modes: MCQ, SAQ, VIVA, Feynman in 2x2 grid cards
- Chart: Domain Mastery with time range selector (1W/1M/3M/ALL)

CURRENT SYNAPSE DESIGN (Sand & Stone):
- Day: --bg #f7f3ee, --accent #c4622c | Night: --bg #1e1710, --accent #e07840
- Domain colors: CSS vars (--domain-physiology, --domain-pharmacology, etc.)
- College-specific theming: ANZCA blue, CICM teal, ACEM crimson
- Desktop: sidebar 220px fixed | Mobile: top 48px + bottom tabs 56px

DELIVERABLES:
1. Component-by-component mapping of new design to existing Synapse pages
2. CSS variable mapping: old Sand & Stone vars → new design system vars
3. What the new design gets RIGHT (SM-2 hero card, topic-focused dashboard, segmented controls)
4. What needs ADAPTATION (no dark mode, no mobile layout, no college selector, shows FRCA not ANZCA, no content state on cards)
5. Implementation sequence: which pages to migrate first, estimated effort per page
6. Dark mode token layer for the new palette
7. Mobile breakpoint recommendations

The design is APPROVED by Rafael as the direction. Produce the full migration plan.`;

async function run() {
  console.log('Submitting design review task...');
  const id = await submitTask(
    { description: taskDesc, input: { designFile: 'knowledge/projects/synapse/ux-baseline-design.html' }, projectId: 'synapse' },
    { agent: 'design' }
  );
  console.log(`Task: ${id.slice(0, 8)}\n`);

  let round = 0;
  while (round < 30) {
    round++;
    const pending = getPendingTasks();
    if (pending.length === 0) { console.log('All done.'); break; }
    const agents = [...new Set(pending.map(t => t.agent))].join(', ');
    console.log(`Round ${round}: ${pending.length} pending → [${agents}]`);
    await dispatchPendingTasks();
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nCost: $${getSystemSpend().toFixed(4)}`);

  const task = getTask(id);
  if (task?.output) {
    const out = task.output as Record<string, unknown>;
    const text = (out.spec as string) ?? (out.text as string) ?? (out.implementation as string) ?? '';
    if (text) {
      fs.writeFileSync('state/ux-redesign-output.txt', text);
      console.log(`Output saved to state/ux-redesign-output.txt (${text.length} chars)`);
    }
  }
}

run().catch(console.error);
