# Autoresearch Methodology

Source: Adapted from Karpathy's autoresearch (github.com/karpathy/autoresearch) for non-GPU, general-purpose use in Organism.

## Core Loop

Every Organism agent that produces analysis, recommendations, or findings MUST follow this tight experiment loop:

```
1. HYPOTHESIZE  → Form a clear, falsifiable claim
2. INVESTIGATE  → Gather evidence (read code, check files, research internet)
3. TEST         → Verify the hypothesis against real evidence
4. DISPROVE     → Actively try to prove yourself wrong
5. CROSS-CHECK  → Validate from a second independent angle
6. DECIDE       → Keep (HIGH/MEDIUM confidence) or Discard (LOW confidence)
7. REPEAT       → Move to next hypothesis
```

## Key Principles from Karpathy

### Fixed-Budget Experiments
Every investigation is time-boxed. An agent shouldn't spend 30 minutes on one finding when it could produce 6 findings in the same time. Budget per finding:
- Quick check: 30 seconds (file exists? config set?)
- Standard investigation: 2-3 minutes (read code, trace flow, verify)
- Deep dive: 5 minutes max (cross-reference multiple files, research)

### Single-File Focus
Karpathy's agents only modify `train.py`. Organism agents should similarly scope their investigation:
- One finding per hypothesis cycle
- Don't try to review everything at once
- Depth over breadth on each individual finding

### Comparable Results
All findings use the same evaluation framework:
- PROBLEM: with file:line evidence
- SOLUTION: concrete implementation steps
- CONFIDENCE: HIGH / MEDIUM / LOW (LOW = discard, don't report)
- IMPACT: P0 (blocks milestone) / P1 (should fix) / P2 (nice to have)

### Keep or Discard
Not every investigation produces a finding. If the hypothesis is disproven (the code already handles it, the issue doesn't exist), DISCARD and move on. Don't pad reports with "non-issues confirmed."

## Application to Organism Agents

### Quality Agent
```
For each approach being evaluated:
1. HYPOTHESIZE: "Approach X will be better because..."
2. INVESTIGATE: Read the relevant code/context
3. TEST: Score on quality dimensions
4. DISPROVE: Find the weakness in this approach
5. CROSS-CHECK: Compare against known best practices
6. DECIDE: Score ≥ threshold? Keep. Otherwise discard.
```

### Quality Guardian (6-Phase Audit)
```
For each audit dimension:
1. HYPOTHESIZE: "This area has issue X because..."
2. INVESTIGATE: Read code, check config, browser-verify
3. TEST: Does the issue actually manifest?
4. DISPROVE: Check if it's already addressed
5. CROSS-CHECK: Verify from second angle (different file, different test)
6. DECIDE: HIGH/MEDIUM confidence? Report. LOW? Discard silently.
```

### Engineering Agent
```
For each code change:
1. HYPOTHESIZE: "This change will fix X because..."
2. INVESTIGATE: Read surrounding code, understand the full context
3. TEST: Does the fix actually work? Type-check? Tests pass?
4. DISPROVE: Does this break anything else?
5. CROSS-CHECK: Is there a simpler/better way?
6. DECIDE: Ship or iterate.
```

### Design Agent
```
For each design decision:
1. HYPOTHESIZE: "This layout serves users because [UX law]..."
2. INVESTIGATE: Check user context, device, task flow
3. TEST: Does it satisfy the UX principle cited?
4. DISPROVE: What if the user does X instead? What about edge cases?
5. CROSS-CHECK: Verify against Nielsen Heuristic + 58 UI Rules
6. DECIDE: Spec it or revise.
```

## The Discard Discipline

**Most findings should be discarded.** If an agent reports 10 findings and 0 were discarded, the agent isn't being rigorous enough. The ratio should be roughly:

- 3-5 hypotheses investigated per finding reported
- LOW confidence findings: silently discarded, never shown to Rafael
- Only HIGH and MEDIUM confidence survive to the review queue

This prevents noise. Rafael's review queue should contain only findings that survived rigorous self-testing.

## Integration with G4 Gate

The autoresearch loop runs BEFORE Rafael sees anything. By the time a finding reaches the dashboard review queue:
1. The agent formed the hypothesis
2. Investigated with real evidence
3. Tried to disprove it
4. Cross-validated
5. Rated it HIGH or MEDIUM confidence
6. The finding earned its place in Rafael's attention

Rafael should never see a finding that says "I think maybe this could be an issue." Every finding in the queue should be "This IS an issue, here's the evidence, here's the fix."
