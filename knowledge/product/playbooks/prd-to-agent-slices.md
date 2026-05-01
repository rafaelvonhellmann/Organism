# PRD To Agent Slices Playbook

This playbook turns vague product intent into agent-native work slices that Paperclip can route and review.

## Contract

- Start with the user problem and the smallest useful outcome.
- Prefer vertical slices over horizontal layers.
- Each slice must have owner, acceptance criteria, evidence needed, verification method, and approval gate.
- Do not create tasks directly from the playbook. Output proposed Paperclip tasks.

## Slice Shape

```json
{
  "title": "short slice name",
  "owner": "agent name",
  "riskLane": "LOW | MEDIUM | HIGH",
  "verifiability": "HIGH | MEDIUM | LOW | NON_DELEGABLE",
  "problem": "user/business problem",
  "acceptanceCriteria": ["observable outcome"],
  "evidenceNeeded": ["source, file, metric, or user signal"],
  "verification": ["test, check, review, or approval"],
  "approvalRequired": "none | rafael | professional",
  "outOfScope": ["explicit no-gos"]
}
```

## Good Slices

- Cross a complete user-visible path.
- Can be reviewed independently.
- Have a clear rollback or non-ship path.
- Avoid shared abstractions until a second slice proves the shape.

## Bad Slices

- "Build database layer."
- "Refactor everything."
- "Improve UX."
- "Add AI."
- "Review legal" without a document, claim, jurisdiction, or playbook topic.

## Required Output

1. PRD summary.
2. Assumptions and unresolved decisions.
3. Proposed vertical slices as JSON.
4. Recommended first slice.
5. Rafael decisions needed before execution.
