"""
StixDB Memory Server for Organism
Start: python packages/stixdb/start.py
Serves REST API on port 4020.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent.parent

# Set env vars BEFORE importing stixdb (it reads them at import time)
secrets_path = ROOT / ".secrets.json"
if secrets_path.exists():
    secrets = json.loads(secrets_path.read_text())
    os.environ.setdefault("ANTHROPIC_API_KEY", secrets.get("ANTHROPIC_API_KEY", ""))
    os.environ.setdefault("OPENAI_API_KEY", secrets.get("OPENAI_API_KEY", ""))

# Configure StixDB via env vars
os.environ.setdefault("STIXDB_STORAGE_MODE", "memory")
os.environ.setdefault("STIXDB_API_PORT", "4020")
os.environ.setdefault("STIXDB_API_KEY", "organism-stixdb-local")
os.environ.setdefault("STIXDB_LOG_LEVEL", "INFO")

if __name__ == "__main__":
    import uvicorn
    print("[StixDB] Starting memory server on port 4020...")
    uvicorn.run(
        "stixdb.api.server:app",
        host="0.0.0.0",
        port=4020,
        log_level="warning",
    )
