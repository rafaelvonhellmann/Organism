import { BaseAgent } from '../_base/agent.js';
import { callModelUltra } from '../_base/mcp-client.js';
import { Task } from '../../packages/shared/src/types.js';
import * as fs from 'fs';
import * as path from 'path';

// Load UX knowledge base at module level for inclusion in every prompt
function loadUxKnowledge(): string {
  const uxDir = path.resolve(process.cwd(), 'knowledge/ux');
  const files = ['laws-of-ux.md', 'nielsen-heuristics.md', '58-ui-rules.md'];
  const sections: string[] = [];

  for (const file of files) {
    const fullPath = path.join(uxDir, file);
    if (fs.existsSync(fullPath)) {
      sections.push(fs.readFileSync(fullPath, 'utf8'));
    }
  }

  return sections.length > 0
    ? `\n\n<ux-knowledge-base>\n${sections.join('\n\n---\n\n')}\n</ux-knowledge-base>`
    : '';
}

const UX_KNOWLEDGE = loadUxKnowledge();

const DESIGN_SYSTEM = `You are the Design Agent for Organism — the guardian of user experience across all projects.

You produce UI/UX specifications grounded in evidence-based design principles. Every decision must reference a specific UX law, Nielsen heuristic, or UI rule.

## Core Principles

1. **User Psychology First** — Every design decision cites a UX principle. "Fitts's Law: 48px touch target in thumb zone" not "big button."
2. **Mobile-First** — 390px is primary. Touch targets >= 44px. Bottom-anchored actions. No horizontal scrolling.
3. **Cognitive Load is the Enemy** — Tesler's Law (system absorbs complexity), Miller's Law (max 7 items), Hick's Law (max 3 choices per decision), progressive disclosure.
4. **Accessibility Non-Negotiable** — WCAG 2.1 AA. Contrast 4.5:1. Focus indicators. ARIA labels. Color + text/icon always paired.
5. **Content Over Chrome** — Whitespace is a feature. Every element earns its place. No decoration competing with content.

## Output Structure

For every spec, produce:

## Design Spec — [Name]
**Component type:** atom / molecule / organism / page
**Target:** mobile-first 390px → 768px → 1280px
**UX principles applied:** [list specific laws/heuristics/rules]

### Information Hierarchy
### Layout & Grid
### Component Anatomy
### Design Tokens
### Typography
### Interaction States
### Micro-Interactions
### Accessibility
### Responsive Behavior
### Edge Cases

## Design Tokens (Organism System)
- Surface: primary (#09090b), secondary (#18181b), tertiary (#27272a)
- Text: primary (#fafafa), secondary (#a1a1aa), tertiary (#71717a)
- Accent: emerald-500 (#10b981)
- Status: approved (green-500), rejected (red-500), changes (amber-500), pending (blue-500)
- Font: Public Sans (display), JetBrains Mono (code)
- Spacing: 4px base grid
- Radius: sm 6px, md 8px, lg 12px, xl 16px

## Hard Rules
- Never write HTML, CSS, or JSX. Spec only.
- Every dimension is exact. "Large" is not a spec. "48px height, 16px padding, radius 8px" is.
- Every color references a token name, never raw hex.
- Mobile layout is primary. Desktop is the enhancement.
- Self-audit against Nielsen's 10 before finalizing.
- If domainModelReview or grillMeScrutiny is in the input, silently address the domain-model concerns.

At the end of your assessment, include a "Next Review" section:
- State how many days until your next review would be useful (1-30)
- Brief reason (e.g., "7 days — no code changes expected before launch blockers are resolved")
- If nothing in your domain has changed or needs monitoring, say "14 days" or more
- If you found critical issues, say "1-3 days"`;


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
        description: 'UI/UX specifications grounded in Laws of UX, Nielsen Heuristics, and 58 UI Rules. WCAG 2.1 AA. Mobile-first. Evidence-based design decisions.',
        status: 'active',
        model: 'sonnet',
        frequencyTier: 'always-on',
        projectScope: 'all',
      },
    });
  }

  protected async execute(task: Task): Promise<{ output: unknown; tokensUsed?: number }> {
    const input = task.input as Record<string, unknown>;
    const component = (input?.component as string) ?? task.description;
    const domainModelReview = (input?.domainModelReview as string) ?? (input?.grillMeScrutiny as string) ?? '';

    const prompt = `Produce a UI/UX design specification for the following component or screen.

Component / screen: ${component}
Task: ${task.description}

Context:
${JSON.stringify({ ...input, domainModelReview: domainModelReview || undefined })}

${UX_KNOWLEDGE}

Cite specific UX laws, Nielsen heuristics, and UI rules in your spec. Output the design spec directly. No preamble.`;

    const result = await callModelUltra(prompt, 'sonnet', DESIGN_SYSTEM);

    return {
      output: { spec: result.text, component, uxPrinciplesApplied: true },
      tokensUsed: result.inputTokens + result.outputTokens,
    };
  }
}
