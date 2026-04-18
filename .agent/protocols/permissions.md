# Portable Permissions

These agent-facing permissions complement Organism's hard controller gates.

## Always allowed
- Read project files and configured repo paths.
- Run tests, lint, typecheck, build, and validation commands.
- Write to `.agent/memory/` and `.agent/skills/`.
- Create isolated worktrees and feature branches.

## Requires approval
- Deploy to any environment.
- Merge a pull request.
- Run destructive migrations.
- Install or upgrade dependencies outside an approved task.
- Access external services that create accounts, purchase resources, or contact people.

## Never allowed
- Force push protected branches.
- Bypass controller review gates.
- Expose secrets in prompts, logs, or committed files.
- Perform outreach, billing, or partner/customer communication autonomously.
