# Organism Dashboard — UX Design Specification

## Design Philosophy

The Organism dashboard is Rafael's **G4 gate** — the interface where a solo founder governing two AI-powered companies makes decisions that drive the system forward. It must work on a phone between hospital cases.

## UX Principles Applied

### From Laws of UX
- **Doherty Threshold**: <400ms for all interactions. Decisions must feel instant.
- **Fitts's Law**: Approve/Reject buttons large (48px+), near thumb zone on mobile.
- **Hick's Law**: Maximum 3 actions per task: Approve, Request Changes, Skip.
- **Jakob's Law**: Email inbox triage pattern — familiar to everyone.
- **Goal-Gradient Effect**: "3 of 7 reviewed" progress bar drives completion.
- **Peak-End Rule**: Empty-state celebration when queue is cleared.
- **Serial Position Effect**: Most important task first. Summary at the end.
- **Von Restorff Effect**: HIGH-risk items visually distinct (red accent border).
- **Tesler's Law**: System absorbs complexity — raw JSON, pipeline internals, task IDs hidden.

### From Nielsen Heuristics
- **H1 Visibility**: Always show queue count, current position, system status.
- **H2 Match Real World**: Agent names → human roles (CTO, PM, Security). Assessments in readable prose.
- **H3 User Control**: Skip, undo, go back — always available. Never trap in a flow.
- **H4 Consistency**: Every task card identical pattern. Every decision identical interaction.
- **H5 Error Prevention**: Require comment for "reject". Confirm batch operations.
- **H6 Recognition > Recall**: Full assessment visible while deciding. Context always present.
- **H7 Flexibility**: Keyboard shortcuts for power users (J/K/A/R).
- **H8 Minimalism**: Only primary agent outputs. No pipeline noise. No raw data unless toggled.
- **H9 Error Recovery**: Failed agents show human message + "Rerun" button, not error codes.
- **H10 Help**: Tooltips on first visit. Self-evident after that.

### From 58 UI Rules
- **Rule 5**: Generous negative space. Cards breathe.
- **Rule 7**: Clear hierarchy — task title > assessment body > metadata > actions.
- **Rule 9**: One focal point per screen — the current task assessment.
- **Rule 13**: Don't make users think. The flow is: read → decide → next.
- **Rule 15**: Break review into individual tasks, not a wall of content.
- **Rule 20**: Progressive disclosure — summary first, full assessment on expand/click.
- **Rule 22**: Immediate feedback on every action. Button confirms visually before advancing.
- **Rule 24**: Body text 16px+. Line height 1.5. Max line length 75ch.
- **Rule 29**: WCAG AA contrast. 4.5:1 for body text minimum.
- **Rule 31**: 60-30-10 color rule. Dark surface dominant, zinc secondary, emerald accent.
- **Rule 33**: Semantic status colors. Green = approved. Red = rejected. Amber = changes requested. Blue = pending.
- **Rule 38**: Micro-interactions on approve/reject — subtle confirmation animation.
- **Rule 47**: Design system tokens, not ad-hoc colors. Everything references the system.
- **Rule 51**: Cross-device consistency. Same flow on phone and desktop.
- **Rule 56**: Visual progress display. "Reviewed 5/12" with progress bar.

## Information Architecture

### Pages

1. **Review Queue** (`/` — default)
   - THE primary interface. Triage inbox.
   - Shows only tasks needing Rafael's decision (HIGH-risk gate tasks)
   - Current task expanded with full rendered assessment
   - Queue list visible but secondary
   - Progress indicator: "X of Y reviewed"
   - Empty state: celebration + summary of decisions made

2. **Perspectives** (`/perspectives`)
   - Grid of domain perspectives with task counts
   - Click to filter review queue by perspective
   - Shows fitness scores, agent activity
   - Entry point for exploration, not the primary workflow

3. **History** (`/history`)
   - Past decisions with filters
   - Approved / Changes Requested / Rejected
   - Search by agent, perspective, date
   - Audit trail for governance

4. **Budget** (`/budget`)
   - Spend tracking, agent caps, system cap
   - Visual indicators for budget health

5. **Settings** (`/settings`)
   - Polling interval, notification preferences
   - Pipeline visibility toggles

### Removed Pages
- Tasks (raw task list — replaced by Review Queue)
- Evolution (merged into Perspectives)
- Guide (first-run onboarding tooltip flow instead)

## Review Queue — Detailed Spec

### Task Card (The Core Component)

```
┌─────────────────────────────────────────────┐
│  CTO · Technology Strategy         HIGH     │
│  ─────────────────────────────────────────  │
│                                             │
│  ## BLOCKER: Python missing in Docker       │
│                                             │
│  `services/control-plane/Dockerfile` builds │
│  on `node:22-alpine` and never installs     │
│  Python. The runner stage contains no       │
│  `apk add python3`. Yet `python-worker-     │
│  client.ts:76` calls `execFileAsync(...)`   │
│  ...                                        │
│                                             │
│  ### Solution                               │
│  ```dockerfile                              │
│  RUN apk add --no-cache python3 py3-pip     │
│  ```                                        │
│                                             │
│  ─────────────────────────────────────────  │
│  [✓ Approve]  [✎ Request Changes]  [Skip →] │
│                                     2 of 7  │
└─────────────────────────────────────────────┘
```

### Layout Spec
- **Mobile (390px)**: Full-width card, vertically stacked actions
- **Desktop (1280px)**: Centered 720px max-width card, inline actions
- **Card padding**: 24px (mobile 16px)
- **Body text**: 15px/1.6 line height, max-width 65ch
- **Action buttons**: 48px height, 16px horizontal padding
- **Spacing between cards**: 16px

### Assessment Rendering
- Parse output JSON → extract `text`, `report`, `scrutiny`, `analysis`, `plan`, `spec` fields
- Render as **markdown**: headers, bullets, tables, code blocks, bold/italic
- Strip escaped `\n` → real newlines
- Nested JSON → recursive field extraction
- Domain Model review → render as structured interrogation (not raw JSON)
- Code blocks with syntax highlighting
- Tables properly formatted

### Decision Actions
- **Approve** (green): Writes `decision: 'approved'` to gates table. Auto-advances to next.
- **Request Changes** (amber): Opens comment textarea. Writes `decision: 'changes_requested'` with reason. Advances after submit.
- **Skip** (neutral): Moves to next without deciding. Task stays in queue.
- **Keyboard**: `A` = approve, `C` = request changes, `→` or `J` = skip/next, `←` or `K` = previous

### Progress Bar
- Top of queue: `Reviewed 3 of 7 · 4 remaining`
- Thin progress bar (4px) across full width
- Color transitions: blue → green as completion increases

### Empty State (Queue Cleared)
```
  ✓ All caught up

  You reviewed 7 tasks today
  5 approved · 1 changes requested · 1 skipped

  Total spend: $16.27

  [Run another review]  [View history]
```

### Queue Filtering
- By project: tokens-for-good / synapse / all
- By risk: HIGH only (default) / all
- By perspective domain
- "Show pipeline tasks" toggle (off by default) — reveals domain-model, codex-review, quality-agent

## Design Tokens

```css
/* Surface */
--surface-primary: #09090b;      /* zinc-950 */
--surface-secondary: #18181b;    /* zinc-900 */
--surface-tertiary: #27272a;     /* zinc-800 */
--surface-hover: #3f3f46;        /* zinc-700 */

/* Text */
--text-primary: #fafafa;         /* zinc-50 */
--text-secondary: #a1a1aa;       /* zinc-400 */
--text-tertiary: #71717a;        /* zinc-500 */
--text-muted: #52525b;           /* zinc-600 */

/* Accent */
--accent-primary: #10b981;       /* emerald-500 */
--accent-primary-hover: #34d399; /* emerald-400 */

/* Semantic Status */
--status-approved: #22c55e;      /* green-500 */
--status-rejected: #ef4444;      /* red-500 */
--status-changes: #f59e0b;       /* amber-500 */
--status-pending: #3b82f6;       /* blue-500 */
--status-in-progress: #6366f1;   /* indigo-500 */

/* Risk Lanes */
--lane-low: #22c55e;             /* green-500 */
--lane-medium: #f59e0b;          /* amber-500 */
--lane-high: #ef4444;            /* red-500 */

/* Borders */
--border-default: #27272a;       /* zinc-800 */
--border-hover: #3f3f46;         /* zinc-700 */
--border-focus: #10b981;         /* emerald-500 */

/* Spacing (4px base) */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-6: 24px;
--space-8: 32px;
--space-12: 48px;

/* Radii */
--radius-sm: 6px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-xl: 16px;

/* Typography */
--font-sans: 'Public Sans', system-ui, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
--text-xs: 12px;
--text-sm: 14px;
--text-base: 15px;
--text-lg: 18px;
--text-xl: 20px;
--text-2xl: 24px;
--leading-tight: 1.25;
--leading-normal: 1.5;
--leading-relaxed: 1.6;
```

## Accessibility Requirements

- WCAG 2.1 AA compliance
- Contrast ratios: 4.5:1 body text, 3:1 large text/UI components
- Touch targets: >= 44px on all interactive elements
- Keyboard navigation: full tab order, arrow keys in queue, Enter to confirm
- Screen reader: ARIA labels on all interactive elements, live regions for status updates
- Focus indicators: visible 2px emerald ring on all focusable elements
- Reduced motion: respect `prefers-reduced-motion` media query
- Color is never the only indicator — always paired with text/icon

## Mobile-First Requirements

Rafael checks this on his phone between hospital cases. Mobile is the PRIMARY platform.

- Touch-friendly: 48px minimum action targets
- Swipe gestures: right = approve, left = request changes (optional, button always available)
- Bottom-anchored action bar (thumb zone)
- Card scrolls vertically, actions fixed at bottom
- No horizontal scrolling ever
- Content readable without zooming: 15px+ body text
- Queue counter visible without scrolling
