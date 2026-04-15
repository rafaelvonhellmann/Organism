# Innovation Radar Playbook

## Purpose

The innovation radar exists to answer one question:

What changed recently outside the project that is worth testing inside the project now?

It is not a trend collector. It is a project-scoped filter for recent external change.

## Run Contract

Every run starts from internal need first:

1. Read the project tasklist, roadmap, blockers, support pain, and recent findings
2. Form 3-5 candidate hypotheses about external changes that could help
3. Investigate and try to disprove each one
4. Discard weak, generic, or mistimed ideas
5. Report at most 3 opportunities

If nothing survives, output `NO_ACTION`.

## Evidence Hierarchy

Use evidence in this order:

1. Primary: official docs, release notes, changelogs, GitHub releases, papers, vendor announcements
2. Secondary: GitHub issues, benchmarks, case studies, implementation writeups
3. Tertiary: Reddit, X/Twitter, HN, forums, community chatter

Tertiary sources can suggest a lead. They cannot justify a recommendation by themselves.

## Output Schema

Use this exact shape:

```md
## Innovation Radar Brief

**Project:** <project>
**Focus:** <focus area or General product leverage>
**Decision:** APPROVED | NO_ACTION
**Why now:** <1-2 sentences>
**Feedback applied:** <how prior feedback changed this run, or None>

### Opportunity 1: <title>
- What changed: <the recent change>
- Why it matters here: <specific project fit>
- Evidence: <primary sources first>
- Effort: <S | M | L + one-sentence explanation>
- Risk: <main downside or failure mode>
- Suggested experiment: <bounded next step>
- Kill criteria: <clear stop condition>
- Confidence: <HIGH | MEDIUM>

**Next Review:** <days + reason>
```

Rules:

- Maximum 3 opportunities
- No generic backlog ideas
- Every opportunity must map to a live project problem, bottleneck, or strategic goal
- Every opportunity must include a bounded experiment and kill criteria

## Feedback Codes

Use these codes when Rafael or a reviewer responds to a radar output:

| Code | Meaning | Agent adaptation on next run |
| --- | --- | --- |
| `APPROVED` | The idea was worth considering now | Preserve the source mix and framing pattern that produced it |
| `REJECTED_IRRELEVANT` | The idea did not map to a real project need | Tighten project-fit filters and require a clearer bottleneck match |
| `REJECTED_NOT_NOVEL` | The idea was already obvious or already known | Raise novelty threshold and avoid repeated categories |
| `REJECTED_WEAK_EVIDENCE` | The claim was under-supported | Require stronger primary evidence before recommending |
| `REJECTED_TOO_COSTLY` | The upside may exist, but cost/complexity was too high | Bias toward smaller experiments and lower implementation cost |
| `REJECTED_NOT_NOW` | The idea may be valid, but timing is wrong | Suppress until a trigger condition changes |

## Learning Guardrails

The innovation radar may adapt:

- source weighting
- novelty threshold
- effort ceiling
- project-fit threshold
- evidence threshold

The innovation radar may not adapt:

- its governance rules
- its reviewer lane
- its maximum opportunity count
- its requirement for evidence
- its prohibition on direct implementation task creation

## Review Cadence

Default cadence is weekly.

Shorten cadence only when:

- the project is actively evaluating infrastructure or AI vendor choices
- the space is moving unusually fast
- recent approved outputs are producing concrete experiments

Lengthen cadence when:

- the project is execution-heavy and not exploring new capabilities
- recent outputs were rejected as mistimed or low signal
