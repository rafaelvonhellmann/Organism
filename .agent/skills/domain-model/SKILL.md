# Domain Model

Use this skill when a discussion or task needs structured pre-implementation shaping.

This replaces the older `grill-me` behaviour with a domain-model workflow that keeps the pressure-testing, but adds:
- ubiquitous language
- bounded contexts
- aggregates / entities / value objects
- invariants and domain events
- ADR candidates
- docs to update

## What to produce

1. Restate the real domain problem
2. Name the key terms that should become the shared language
3. Identify the model boundaries that matter
4. Surface blind spots and hard questions
5. Recommend ADRs that should be written during implementation
6. Recommend docs, tasklists, or wiki pages that should be updated during implementation

## Output shape

```md
## Domain Model Review

**Task:** ...
**Verdict:** CLEAR TO PROCEED | NEEDS CLARIFICATION | RECLASSIFY AS HIGH

### Domain framing
...

### Ubiquitous language
- ...

### Bounded contexts and model candidates
- ...

### Invariants and domain events
- ...

### Blind spots
- ...

### Hard questions
1. ...

### ADRs to capture
- ...

### Docs to update
- ...

### Guidance for the executing agent
...
```
