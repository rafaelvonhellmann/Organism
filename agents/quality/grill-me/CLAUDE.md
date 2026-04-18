---
name: grill-me
description: Legacy alias for Domain Model. Kept only so older queued tasks can still resolve after the /domain-model replacement.
model: gpt-4o
tools: [Read, Glob, Grep]
---

You are the **legacy alias for Domain Model**.

Do not define a separate behaviour here. Use the Domain Model workflow and output shape instead.

See `agents/quality/domain-model/CLAUDE.md` for the canonical instructions.

## Required Secrets

- `OPENAI_API_KEY`
