# Mesa / markdownfs Adaptation Analysis for Synapse

Date: 2026-05-01
Scope: defensive, non-invasive architecture and product-design review using public Mesa website/docs plus the public `markdownfs` repository as an open-source implementation reference. No live probing, credential discovery, production mutation, exploit research, or code copying was performed.

## Sources Inspected

- Mesa launch post: https://mesa.dev/blog/introducing-mesa-filesystem-for-agents
- Mesa docs index: https://docs.mesa.dev/llms.txt
- Mesa introduction: https://docs.mesa.dev/content/getting-started/introduction
- Mesa versioning: https://docs.mesa.dev/content/core-concepts/versioning
- Mesa virtual filesystem: https://docs.mesa.dev/content/core-concepts/virtual-filesystem
- Mesa app-level virtualization: https://docs.mesa.dev/content/virtual-filesystem/application-level
- Mesa OS-level virtualization: https://docs.mesa.dev/content/virtual-filesystem/os-level
- Mesa patterns and best practices: https://docs.mesa.dev/content/core-concepts/patterns-best-practices
- Mesa auth and permissions: https://docs.mesa.dev/content/getting-started/auth-and-permissions
- Mesa limits: https://docs.mesa.dev/content/reference/limits
- markdownfs repository: https://github.com/subramanya1997/markdownfs, inspected locally at commit `1b96fda2d598e34274c759fb9fef6506bd84d96a`
- Synapse local docs only: `C:/Users/rafae/OneDrive/Desktop/synapse/README.md`, `.ai/repo-map.md`, `docs/architecture.md`, `docs/api.md`, `docs/schema.md`, `tasks/todo.md`, and selected runtime files.

## Executive Recommendation

Do not replace Synapse with Mesa, and do not move Synapse's core runtime state out of Supabase.

Mesa is best understood as an agent-oriented, versioned workspace layer. Synapse is a medical-exam learning product with relational study state, curated educational content, pgvector retrieval, RLS, attempt tracking, spaced repetition, and user-facing study surfaces. Those centers of gravity are different.

The highest-value adaptation is to bring Mesa-style versioning, proposal branches, snapshots, scoped workspaces, and diff-first review into Synapse's content pipeline and AI grading provenance. That would make processor runs, content enrichment, Ask Studia evidence, SAQ grading, Viva transcripts, and admin review more inspectable and reversible without disturbing the product database.

## What Mesa Is Optimizing For

Mesa frames agent artifacts as a versioned workspace rather than a blob bucket. Its public materials emphasize:

- durable files beyond ephemeral sandboxes
- branches/bookmarks so agents can work in parallel
- change history for review, rollback, and replay
- sparse materialization and prefetching so agents do not need full clones
- scoped API keys and repository-level access control
- app-level and OS-level virtual filesystems so agents can use normal file operations
- proposal bookmark plus diff review as a human approval workflow

The key product idea is simple and strong: agents should write into a safe session/proposal timeline first; humans or later policy gates decide when that work advances the reviewed baseline.

## Open-Source Reference: markdownfs

`markdownfs` is not Mesa, but it is a useful open-source reference for the same category. It is a Rust markdown-only virtual filesystem with:

- a shared concurrent `MarkdownDb` core
- CLI, HTTP, and MCP surfaces
- Git-style commits, history, and revert
- content-addressed storage
- users, groups, POSIX-like permissions, sticky/setgid behavior
- search, find, tree, read, write, move, delete, commit, and revert tools

The main clean-room lesson is architectural rather than code-level: keep one durable workspace core and expose it through several narrow surfaces. For Synapse, that means a shared artifact/proposal model surfaced to processor scripts, admin UI, and maybe Organism, rather than separate ad hoc logs, JSON dumps, task files, and screenshots.

## Synapse Today

Synapse is already strong where Mesa is not trying to compete:

- Next.js App Router product shell and API routes
- Supabase Postgres, pgvector, and RLS as canonical app state
- large curated content tables for MCQs, SAQs, vivas, learning objectives, sources, and document chunks
- SM-2 spaced repetition and learner attempt tables
- Ask Studia / Ask Synapse retrieval with verified evidence traces
- emerging `AttemptDossier` pattern for grounded SAQ/Viva grading
- Arki rule engine, voice hooks, Viva review scaffolding, and processor scripts

The weak spot is not product state. The weak spot is long-running content and agent work: enrichment outputs, QA runs, generated reports, candidate diffs, screenshots, handoffs, logs, and review decisions are scattered across `processor/`, `tasks/`, `.ai/`, and local dirty artifacts. That is exactly where Mesa's workspace model maps well.

## Adapt

### 1. Content Proposal Workflow

Use Mesa's "proposal bookmark plus diff" concept for content enrichment.

Clean-room Synapse version:

- every processor/enrichment run gets a `proposal/<surface>/<run-id>` identity
- output lands in a run workspace first, not directly in production tables
- the run writes a manifest containing input filters, model profile, prompt version, source hashes, row IDs, proposed field changes, verification scores, and reviewer notes
- admin UI shows before/after diffs for `model_answer`, `explanation`, `study_note`, citations, and `verification_metadata`
- approval moves the proposal into the reviewed baseline by applying a controlled DB migration/update
- rejection preserves the proposal for audit or deletes only the temporary workspace pointer

This is the single best adaptation for Synapse because it directly addresses medical-content trust.

### 2. Checkpoint Per User-Visible AI Event

Mesa recommends checkpointing after each prompt/session. Synapse should apply the same idea to higher-risk AI study events:

- Ask Studia response: query, filters, retrieval rows, evidence packet, model, prompt version, claim blocks, citations, abstain reason, and user feedback
- SAQ grading: full attempt dossier, learner answer/image metadata, expected key points, grading result, model, prompt version, and evidence hashes
- Viva session: opening station, transcript turns, follow-up tree, model outline, key points, grading dossier, score, and debrief

Synapse already has parts of this. The missing piece is a single "attempt checkpoint" abstraction that makes regrading, audit, replay, and product support straightforward.

### 3. Timeline Per Session

Mesa's timeline-per-session maps naturally to Synapse:

- one study session timeline per Viva, SAQ set, podcast, Feynman run, or Ask Studia chat
- each checkpoint records the learner's intent and the system's response
- user-facing "review this session" and "resume from here" become easier
- internal support can explain what happened without reading raw logs

Keep the canonical session state in Supabase; store large artifacts and rendered diffs outside hot tables.

### 4. Scoped Workspace For Processor Runs

Create a processor run layout inspired by markdownfs' execution roadmap:

```text
processor/runs/<run-id>/
  prompt.md
  plan.md
  input-scope.json
  stdout.md
  stderr.md
  result.md
  manifest.json
  proposed-changes.jsonl
  verification-summary.md
  artifacts/
```

This should start as a local/Supabase-backed convention before considering any external filesystem. The point is auditability and cleanup, not dependency adoption.

### 5. Permission Scopes For Internal Tools

Mesa's read/write/admin and repo-scoped API key model maps to Synapse internal operations:

- read-only content inspection
- proposal creation
- proposal approval
- production content mutation
- user-data access
- admin/API-key management

Synapse should make these scopes explicit for processor scripts, admin routes, Organism-driven tasks, and future agent tools. Do not pass service-role power into general-purpose scripts when a proposal-only token would do.

### 6. Diff-First Admin UX

Mesa's product pattern should influence Synapse's admin/product design:

- show `main` / reviewed content as the stable baseline
- show proposals as short-lived review branches
- render medical-content diffs by field, source, confidence, and verification status
- provide approve, reject, request revision, and re-run verification actions
- show lineage: source document -> extracted fact -> enriched answer -> verified claim -> user-facing study surface

This is more valuable than adding another generic dashboard.

### 7. Sparse Loading And Prefetching Ideas

Mesa's lazy materialization/prefetching maps to Synapse retrieval and content authoring:

- prefetch only the adjacent LO tree and top evidence chunks for the active exam/domain
- keep current `document_chunks`/pgvector model, but add a small "context pack" cache per session
- for content review, load directory/list metadata first, then fetch large proposed diffs or artifacts on demand

This matters because Synapse has large content tables and many generated artifacts.

## Avoid

### Do Not Replace Supabase Or pgvector

Mesa is not a better primary app database for Synapse. Supabase remains the right canonical store for users, attempts, spaced repetition, content tables, RLS, and vector retrieval.

### Do Not Mount FUSE In The Web Runtime

Mesa's OS-level mount is useful for sandbox agents and local/CI-like environments, not Vercel/Next.js serverless request paths. Keep web routes simple and database-backed.

### Do Not Give Study Agents A Broad Bash Tool

Mesa's app-level bash pattern is powerful, but Synapse is a learner-facing medical education app. User-facing AI should not receive broad shell access. If adapted, it belongs only in internal processor/admin workflows with strict command allowlists and no default network access.

### Do Not Store Sensitive Learner Or Medical-Like Data In A Hosted Workspace Without Review

Even if Synapse is education rather than clinical care, learner transcripts, grading attempts, emails, and study history are sensitive. Any hosted Mesa-style backend needs privacy, retention, data-processing, regional, and deletion review first.

### Do Not Make Every Learner Interaction Git-Like

Users should not see commits, branches, or merge vocabulary. The UX should expose study-friendly concepts: drafts, checkpoints, review history, approved content, and undo.

### Do Not Copy External Code

Mesa appears to be a hosted/private beta product; markdownfs is a separate public repo. In either case, Synapse should recreate useful patterns cleanly inside its own stack. Architecture ideas are fair game; implementation copying is unnecessary.

## Leave Unchanged

- Supabase as canonical product state.
- pgvector/document_chunks for textbook retrieval.
- RLS and route-level auth/rate limiting discipline.
- Next.js App Router API surface.
- SM-2 spaced repetition.
- The attempt-dossier/evidence-allowlist direction already underway.
- College-specific exam config and study-surface rollout gates.
- Organism as the external orchestration/control-plane path; Synapse should not become its own autonomous orchestrator.

## Proposed Migration Plan

### Phase 0: Documentation And Naming

- Define Synapse terms: `baseline`, `proposal`, `checkpoint`, `artifact`, `run manifest`, `reviewed content`.
- Document which data lives in Supabase versus artifact storage.
- Add retention rules for logs, screenshots, generated audio, transcripts, and failed enrichment outputs.

### Phase 1: Processor Run Manifests

- Add a shared `processor/lib/run_manifest.cjs` helper.
- Every long-running processor script writes `manifest.json`, `stdout.md`, `stderr.md`, and `result.md`.
- Include source hashes, row IDs, model/prompt versions, env names only, started/ended timestamps, verification metrics, and proposed outputs.
- Add a cleanup policy so `.ai/`, `tasks/`, and `processor/` do not become permanent junk drawers.

### Phase 2: Proposal Diffs For Content Enrichment

- Introduce proposal output JSONL for candidate DB updates.
- Add a review script that renders field-level diffs.
- Only approved proposals apply writes to Supabase.
- Keep direct production mutation scripts behind a deliberate override.

### Phase 3: Attempt Checkpoints

- Extend Ask Studia, SAQ grading, and Viva review to persist a structured checkpoint envelope.
- Store large raw artifacts outside hot tables; keep hashes and pointers in DB.
- Add regrade/replay tooling that can run against an old checkpoint with a new prompt/model.

### Phase 4: Admin Review UI

- Build an admin review surface for proposed content changes.
- Group by exam type, domain, surface, verification status, source quality, and model version.
- Show before/after, evidence, citation lineage, and reviewer action history.

### Phase 5: Optional Mesa Adapter

Only consider a real Mesa SDK/backend adapter after the internal model is proven. The adapter should be behind a narrow interface:

- `createWorkspace`
- `writeArtifact`
- `listArtifacts`
- `createProposal`
- `renderDiff`
- `approveProposal`
- `archiveProposal`

No user-facing feature should depend directly on Mesa-specific concepts.

## Review Items For Synapse

1. Dirty artifact policy: Synapse currently has many generated screenshots, logs, backup files, candidate files, and task outputs. Decide what belongs in Git, what belongs in ignored run workspaces, and what needs durable artifact storage.
2. Processor mutation safety: identify scripts that write directly to Supabase and split them into proposal-generation and apply-approved phases.
3. Attempt provenance: ensure SAQ/Viva/Ask Studia save enough structured evidence to explain or replay every AI decision.
4. Large payload control: adopt Mesa-like limits for inline artifacts, diffs, and API responses. Store large audio/image/transcript payloads by reference.
5. Scoped credentials: separate read, proposal-write, production-write, and admin secrets. Rotate and expire internal job keys where possible.
6. Review UX: prioritize medical-content diff review over a generic file explorer.

## Bottom Line

Mesa's most important lesson for Synapse is not "use a filesystem." It is "treat agent work as versioned, reviewable, reversible state."

For Synapse, that means:

- Supabase remains the product database.
- Content and AI work gain proposals, checkpoints, manifests, and diffs.
- Internal agents get scoped, auditable workspaces.
- Humans approve sensitive educational-content changes before they become baseline.

That is a clean adaptation with high upside and low architectural risk.
