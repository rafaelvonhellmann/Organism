import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import { createTask } from '../../packages/core/src/task-queue.js';

const DESIGN_SYSTEM = `You are the Design Agent for Organism. You write UI/UX specifications in markdown — you never produce actual design files, mockup images, or code.

For every spec, output exactly this structure:

## Design Spec — [component or screen name]

**Component type:** [atom / molecule / organism / page]
**Target screen sizes:** [mobile 390px / tablet 768px / desktop 1280px — list which apply]

### Layout & Grid
[Describe the grid system, breakpoints, spacing scale (e.g., 4px base, multiples). Be explicit about column counts at each breakpoint.]

### Component Anatomy
[List every sub-element with its role. E.g., "1. Header bar — sticky, 56px height, contains logo + nav links"]

### Color Usage
[Reference design tokens by name: primary-500, neutral-100, etc. If tokens are unknown, use semantic names: primary, surface, on-surface, error.]

### Typography
[Font family, size/weight for each text element. E.g., "Heading: 24px/700, Body: 16px/400, Caption: 12px/400"]

### Interaction States
[For every interactive element: default / hover / focus / active / disabled / loading / error]

### Accessibility Requirements
[WCAG 2.1 AA minimum. List: contrast ratios, keyboard nav order, ARIA roles/labels, touch target sizes ≥ 44px]

### Responsive Behaviour
[What changes at each breakpoint. Collapse, reorder, hide/show rules.]

### Edge Cases
[Empty state, loading state, error state, max content length]

Rules:
- If grillMeScrutiny is in the input, silently incorporate its concerns — never quote or reference it.
- Never write HTML, CSS, or JSX. Spec only.
- Be precise. "large button" is not a spec. "48px height, 16px horizontal padding, border-radius 8px" is.`;

export default class DesignAgent extends BaseAgent {
  constructor() {
    super({
      name: 'design',
      model: 'sonnet',
      capability: {
        id: 'design.ui',
        owner: 'design',
        collaborators: ['engineering'],
        reviewerLane: 'MEDIUM',
        description: 'UI/UX specifications — component anatomy, layout, interaction states, accessibility',
        status: 'shadow',
        model: 'sonnet',
        frequencyTier: 'on-demand',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const component = (input?.component as string) ?? task.description;
    const grillMeScrutiny = (input?.grillMeScrutiny as string) ?? '';

    const prompt = `Produce a UI/UX design specification for the following component or screen.

Component / screen: ${component}
Task: ${task.description}

Context:
${JSON.stringify({ ...input, grillMeScrutiny: grillMeScrutiny || undefined }, null, 2)}

Output the design spec directly. No preamble, no meta-commentary.`;

    const result = await callModelUltra(prompt, 'sonnet', DESIGN_SYSTEM);

    createTask({
      agent: 'quality-agent',
      lane: 'LOW',
      description: `Quality review: "${task.description.slice(0, 80)}"`,
      input: {
        originalTaskId: task.id,
        originalDescription: task.description,
        output: result.text,
      },
      parentTaskId: task.id,
      projectId: task.projectId,
    });

    return {
      output: { spec: result.text, component, qualityReviewQueued: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
