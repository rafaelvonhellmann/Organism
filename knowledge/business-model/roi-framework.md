# Business ROI & Model Framework

**Source:** https://github.com/topics/business-model (curated), https://github.com/dorinabrle/business-roi-framework-ai
**Used by:** CEO agent, CFO agent, Product Manager agent
**Purpose:** Translate technical decisions into business language. Justify investment. Evaluate vendors and tools.

---

## The 3-Question ROI Framework

For every technical decision or tool evaluation, answer these three questions before spending time or money:

**Q1: What specific business outcome does this enable?**
- Not "it's faster" — but "it reduces customer churn by X% because Y"
- Not "it's secure" — but "it eliminates the risk of a $50K fine under GDPR"
- Frame in revenue gained, cost avoided, or risk reduced

**Q2: What does failure cost?**
- If this doesn't work, what's the downside?
- Time lost, money spent, agent hours, opportunity cost
- Is the failure recoverable? How long does recovery take?

**Q3: What does success look like in 30 / 90 / 180 days?**
- Define the metric before you start, not after
- If you can't measure it, you can't manage it
- Attach a number: conversion rate, task completion rate, cost per output

---

## Business Model Canvas — Agent Reference Template

Use this whenever defining a new product, revenue stream, or agent's value proposition.

```
## Business Model Canvas: [Product/Feature Name]

### Value Propositions
What problem are we solving? For whom?
- Customer segment: [Who exactly]
- Pain: [What frustrates them now]
- Our solution: [How we relieve it]
- Gain: [What they get that they didn't before]

### Customer Segments
- Primary: [Main segment]
- Secondary: [Adjacent segments]
- Who NOT to target: [Anti-segments — keeps focus]

### Channels
How do customers discover, evaluate, and access the product?
- Awareness: [SEO, word of mouth, content]
- Evaluation: [Free trial, demo, case study]
- Purchase: [Direct, partner, marketplace]
- Delivery: [SaaS, download, API]

### Customer Relationships
- Self-serve (low-touch, scales without headcount)
- Assisted (support, onboarding)
- Community (users help each other)
- Automated (agents handle it)

### Revenue Streams
- Freemium → paid conversion
- Subscription (monthly/annual)
- Usage-based (pay per API call, per agent run)
- One-time license
- Enterprise contract

### Key Resources
What do we need to execute this?
- Technical: [Infrastructure, models, data]
- Human: [Which agents handle this]
- IP: [Proprietary algorithms, datasets, brand]

### Key Activities
What must work for the value proposition to hold?
- [Critical activity 1]
- [Critical activity 2]

### Key Partners
Who else is needed?
- [Partner type and why they're critical]

### Cost Structure
What are the main costs?
- LLM tokens: [Model × estimated calls × rate]
- Infrastructure: [Hosting, storage, tools]
- Agent time: [Hours × cost per agent run]

### Unit Economics (for any revenue stream)
- CAC (Customer Acquisition Cost): $X
- LTV (Lifetime Value): $X
- LTV:CAC ratio target: ≥ 3:1
- Payback period: X months
```

---

## Vendor & Tool Evaluation Rubric

Use before adopting any new library, framework, or service into the Organism stack.

| Criterion | Questions to ask | Weight |
|---|---|---|
| Problem fit | Does this solve our specific problem, or do we need to bend our problem to fit it? | High |
| Maintenance health | Last commit? Open issues? Response time on PRs? | High |
| Integration cost | How long to wire in? What breaks? | Medium |
| Exit cost | How hard is it to remove later? Are we locked in? | High |
| Cost at scale | What does this cost at 10x current usage? | Medium |
| Security | Does it handle our data? What's the breach surface? | High |
| Community | Is there a real community to ask for help? | Low |

**Red flags:**
- "We'll figure out the business model later" (founders haven't thought about sustainability)
- GitHub stars as the primary evaluation criterion (popularity ≠ fit)
- No migration path out (lock-in without leverage)
- Last commit > 12 months ago with open critical issues
- No LICENSE file or ambiguous licensing

---

## ROI Decision Log Format

Every significant investment decision (>$50/month, >1 week agent time, or >HIGH-risk) should be logged:

```
## Decision: [Short title]
Date: YYYY-MM-DD
Decided by: [CEO agent | G4 gate | Rafael]

### The 3 Questions
Q1 (Business outcome): [Answer]
Q2 (Failure cost): [Answer]
Q3 (Success metric at 30/90/180 days): [Answer]

### Options considered
1. [Option A] — [Why rejected or chosen]
2. [Option B] — [Why rejected or chosen]

### Chosen approach: [Option]
### Estimated cost: $X / month
### Review date: [When to re-evaluate]
```

---

## Key Books (referenced by the business-model topic resources)

- *Business Model Generation* — Osterwalder & Pigneur (the BMC framework origin)
- *The Startup Owner's Manual* — Blank & Dorf (customer discovery)
- *Lean Startup* — Ries (build-measure-learn)
- *Zero to One* — Thiel (monopoly vs competition thinking)

These are references for the CEO agent when making strategic decisions. Not required reading — but useful framing for decisions about market positioning.
