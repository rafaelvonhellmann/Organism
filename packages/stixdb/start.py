"""
StixDB Memory Server for Organism
Start: python packages/stixdb/start.py
Serves REST API on port 4020.
"""
import os

# Configure StixDB via env vars — all secrets must be set in the environment,
# not loaded from files on disk.
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
