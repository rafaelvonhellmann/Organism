# Decisions

- Paperclip in `packages/core/` is the only orchestrator.
- PraisonAI in `packages/mcp-sidecar/` is a restricted MCP tool provider only.
- OpenAI is the default runtime; Anthropic paths are opt-in only.
- Review lanes, launch guards, and project policies outrank agent initiative.
