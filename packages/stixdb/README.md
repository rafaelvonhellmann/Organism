# StixDB Memory Server

Graph-based memory layer for the Organism multi-agent system. Uses KuzuDB for local storage (no Docker required) and exposes a REST API on port 4020.

## Install

```bash
cd packages/stixdb
pip install -r requirements.txt
```

## Configure

Copy `.env.example` to `.env` and fill in your Anthropic API key, or ensure `.secrets.json` exists at the project root with an `ANTHROPIC_API_KEY` entry.

## Start

```bash
# From the monorepo root
python packages/stixdb/start.py

# Or via npm script
pnpm stixdb
```

The server will:
1. Create one collection per Organism agent (read from `knowledge/capability-registry.json`)
2. Create a `system` collection for cross-agent knowledge
3. Ingest all files from `knowledge/` into the `system` collection
4. Start the REST API on port 4020 with background consolidation

## Data

KuzuDB data is stored in `state/stixdb/` (git-ignored).
