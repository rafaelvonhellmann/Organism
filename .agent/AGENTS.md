# Portable Agent Brain

This folder applies the core `agentic-stack` ideas to Organism's agents without replacing Paperclip orchestration.

## Read order
- `memory/personal/PREFERENCES.md`
- `memory/working/WORKSPACE.md`
- `memory/working/REVIEW_QUEUE.md`
- `memory/semantic/DECISIONS.md`
- `memory/semantic/LESSONS.md`
- `protocols/permissions.md`
- `skills/_manifest.jsonl`

## Intent
- Keep a portable memory surface that survives harness changes.
- Stage reusable lessons before promoting them into durable semantic memory.
- Give every agent one shared permissions contract and one shared workspace view.
- Let Paperclip remain the controller while the portable brain improves continuity and judgment.

## Rules
1. Paperclip stays the only orchestrator.
2. Agents can write portable memory, but not bypass controller safety gates.
3. Repeated failures and meaningful review feedback should land in the review queue.
4. Distilled lessons belong in semantic memory only after review.
