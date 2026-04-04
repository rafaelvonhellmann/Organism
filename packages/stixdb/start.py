"""
StixDB Memory Server for Organism
Start: python packages/stixdb/start.py
"""
import asyncio
import json
import os
import sys
from pathlib import Path

# Add project root
ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(ROOT))

async def main():
    from stixdb import StixDBEngine, StixDBConfig, LLMProvider, StorageMode

    # Load Organism secrets
    secrets_path = ROOT / ".secrets.json"
    secrets = {}
    if secrets_path.exists():
        secrets = json.loads(secrets_path.read_text())

    api_key = secrets.get("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_API_KEY", "")

    config = StixDBConfig(
        llm_provider=LLMProvider.ANTHROPIC,
        anthropic_api_key=api_key,
        anthropic_model="claude-sonnet-4-6",
        storage_mode=StorageMode.KUZU,
        kuzu_db_dir=str(ROOT / "state" / "stixdb"),
        api_port=4020,
        api_key=os.getenv("STIXDB_API_KEY", "organism-stixdb-local"),
    )

    engine = StixDBEngine(config)
    await engine.start()

    # Load agent names from capability registry
    registry_path = ROOT / "knowledge" / "capability-registry.json"
    registry = json.loads(registry_path.read_text())
    agent_names = list(set(c["owner"] for c in registry["capabilities"]))
    agent_names.append("system")  # Cross-agent knowledge

    print(f"[StixDB] Creating {len(agent_names)} collections...")
    for name in sorted(agent_names):
        try:
            await engine._ensure_collection(name)
            print(f"  ✓ {name}")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    # Ingest knowledge/ directory into system collection
    knowledge_dir = ROOT / "knowledge"
    if knowledge_dir.exists():
        print(f"\n[StixDB] Ingesting knowledge/ into 'system' collection...")
        for md_file in knowledge_dir.rglob("*.md"):
            try:
                content = md_file.read_text(encoding="utf-8")
                await engine.store(
                    collection="system",
                    content=content[:2000],  # Chunk large files
                    node_type="fact",
                    importance=0.7,
                    tags=["knowledge", md_file.stem],
                    metadata={"source_file": str(md_file.relative_to(ROOT))},
                )
                print(f"  ✓ {md_file.relative_to(ROOT)}")
            except Exception as e:
                print(f"  ✗ {md_file.relative_to(ROOT)}: {e}")

        # Also ingest JSON configs
        for json_file in knowledge_dir.rglob("*.json"):
            try:
                content = json_file.read_text(encoding="utf-8")
                await engine.store(
                    collection="system",
                    content=content[:2000],
                    node_type="fact",
                    importance=0.8,
                    tags=["config", json_file.stem],
                    metadata={"source_file": str(json_file.relative_to(ROOT))},
                )
                print(f"  ✓ {json_file.relative_to(ROOT)}")
            except Exception as e:
                print(f"  ✗ {json_file.relative_to(ROOT)}: {e}")

    print(f"\n[StixDB] Memory server ready on port 4020")
    print(f"[StixDB] {len(agent_names)} agent collections initialized")
    print(f"[StixDB] Background consolidation running (30s cycle)")

    # Keep running
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        print("\n[StixDB] Shutting down...")
        await engine.stop()

if __name__ == "__main__":
    asyncio.run(main())
