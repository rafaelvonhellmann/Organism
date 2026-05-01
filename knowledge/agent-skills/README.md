# Agent Skills

Organism vendors selected external agent skills here and exposes them to every agent through `agents/_base/agent-skills.ts`.

## Runtime Contract

- Paperclip remains the only orchestrator.
- Skills are operating methods for an agent's current function, not permission to create tasks, schedule work, or call other agents.
- Each run gets a compact skill profile based on the agent name, capability, and task description.
- Interactive skills are adapted for autonomy: agents self-grill first, inspect available evidence, and ask Rafael only for blocking decisions.

## Sources

- `mattpocock/skills` at `b843cb5ea74b1fe5e58a0fc23cddef9e66076fb8`

The executable mapping lives in `manifest.json`; vendored source docs live under `mattpocock/`.
