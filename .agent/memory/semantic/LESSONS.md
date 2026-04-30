# Lessons

Portable semantic lessons for Organism agents live here after review.

Use the review queue first for recurring failures, repeated review feedback, and useful portable patterns.

## OpenAI model routing via Claude CLI (2026-04-18)

**Pattern:** codex-review and any agent using `gpt4o`/`gpt5.4` models fails when `codex-cli` is unavailable because the fallback path hits `claude-cli`, which rejects GPT model names. The `shouldFallbackFromClaudeCliToApi` check didn't match model-not-found errors so the fallback never triggered.

**Fix landed:** `agents/_base/mcp-client.ts`
- `callClaude` now throws `UNSUPPORTED_MODEL:` immediately for any `gpt*` model
- `shouldFallbackFromClaudeCliToApi` now matches `UNSUPPORTED_MODEL` so the error triggers the OpenAI-API fallback

**Rule:** Any new model variant that isn't a Claude model must be guarded in `callClaude` before the spawn call, not after. The guard must throw with a string matched by `shouldFallbackFromClaudeCliToApi`.
