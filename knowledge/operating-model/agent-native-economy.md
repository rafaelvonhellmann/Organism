# Organism Agent-Native Operating Model

This document applies Andrej Karpathy's framing to Organism: some work should be classical software, some should be LLM-native skills and knowledge, and the safest system is the one that knows which mode it is in.

## Core Thesis

Organism should not treat LLMs only as a faster way to do old software work. It should make the company legible to LLMs and then use deterministic software as the coprocessor that routes, records, verifies, and applies bounded actions.

## Three Computing Modes

### Software 1.0: deterministic coprocessors

Use code for:
- task routing
- audit logs
- budgets and gates
- tests, builds, linting, type checks
- database writes
- redline application
- PR creation and deployment mechanics

Rule: if correctness can be cheaply checked by code, let code check it.

### Software 2.0: model judgement

Use LLMs for:
- synthesizing ambiguous context
- reviewing unstructured documents
- writing plans, briefs, and explanations
- challenging assumptions
- extracting operations from fuzzy source material

Rule: model judgement should emit evidence and structured outputs, not silently mutate reality.

### Software 3.0: markdown skills and knowledge

Use `.md` files for:
- agent skills
- legal, medical, security, growth, and product playbooks
- domain language and ADRs
- checklists and operating principles

Rule: many Organism "features" should start as markdown playbooks. Add code only when a deterministic runtime boundary, verification step, or actuator is needed.

## Sensors, Logic, Actuators

### Sensors

Sensors make reality visible to agents:
- task queue
- git watcher
- audit log
- project review context
- source registries
- test/build logs
- browser verification
- dashboard feedback
- prior decisions and run memory

### Logic

Logic turns context into decisions:
- LLM agents
- skills
- playbooks
- risk classifier
- verifiability matrix
- review pipeline
- Shape Up bet boundaries

### Actuators

Actuators change the world:
- code edits
- database migrations
- commits, pushes, PRs
- deployments
- emails/messages
- legal redline proposals
- task creation

Rule: actuators must be narrow, logged, reversible where possible, and gated based on risk and verifiability.

## Verifiability Principle

LLM reliability is jagged. Organism should classify every agent run by verifiability:

| Class | Examples | Runtime behavior |
| --- | --- | --- |
| HIGH | code, tests, builds, SQL, deploy logs | run deterministic checks, auto-ship LOW risk |
| MEDIUM | PRDs, UX, analytics, product plans | require evidence, assumptions, acceptance criteria |
| LOW | strategy, legal, medical, market timing | require citations, uncertainty, review gates |
| NON_DELEGABLE | legal reliance, clinical safety, major spend, brand-defining decisions | Rafael/professional approval required |

## Practical Rule

The less verifiable a domain is, the more Organism must demand:
- source citations
- playbook topic mappings
- structured uncertainty
- explicit approval requirements
- deterministic operation proposals instead of direct mutation

## Current Application

Organism already has the skeleton:
- Paperclip is the orchestrator.
- Agents are specialist judgement layers.
- Palate injects knowledge sources.
- Skills install operational behavior as markdown.
- Legal Agent now emits structured redline proposals rather than applying legal edits.

The next step is making verifiability visible at runtime for every agent.
