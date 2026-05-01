"""
PraisonAI MCP Sidecar — Organism LLM Tool Provider

IMPORTANT: This server exposes EXACTLY 5 tools. No more.
Paperclip (packages/core/) is the only orchestrator.
This server NEVER creates tasks, schedules work, or calls other agents.
Any attempt to do so must be rejected here at the MCP layer.

Tools:
  1. route_model       — Route a prompt to the best available LLM
  2. rag_retrieve      — Retrieve ranked context chunks from the knowledge base
  3. check_policy      — Check an action against the policy engine (guardrails)
  4. detect_doom_loop  — Detect infinite retry loops in a call sequence
  5. persist_memory    — Persist a fact to graph memory (knowledge base)
"""

import json
import os
import sys
import hashlib
from typing import Any
import anthropic
import openai
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types as mcp_types

app = Server("organism-mcp-sidecar")

# Model routing — Paperclip specifies model_preference, we route to the right provider
MODEL_MAP = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "gpt4o": "gpt-4o",
    "gpt5.4": "gpt-5.4",
}

anthropic_client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

# In-memory call sequence tracker for doom loop detection
_call_sequences: dict[str, list[str]] = {}

# Simple in-memory knowledge store (replace with Neo4j/vector DB in production)
_memory_store: list[dict[str, Any]] = []


@app.list_tools()
async def list_tools() -> list[mcp_types.Tool]:
    return [
        mcp_types.Tool(
            name="route_model",
            description="Route a prompt to the specified LLM. Returns the model response.",
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "The prompt to send"},
                    "model_preference": {
                        "type": "string",
                        "enum": ["haiku", "sonnet", "opus", "gpt4o", "gpt5.4"],
                        "description": "Which model to use. Default: sonnet.",
                    },
                    "system": {"type": "string", "description": "Optional system prompt"},
                    "max_tokens": {"type": "integer", "description": "Optional response token cap"},
                    "task_id": {"type": "string", "description": "Organism task ID for audit"},
                },
                "required": ["prompt"],
            },
        ),
        mcp_types.Tool(
            name="rag_retrieve",
            description="Retrieve the top-k most relevant context chunks from the knowledge base.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "default": 5, "description": "Number of chunks to return"},
                },
                "required": ["query"],
            },
        ),
        mcp_types.Tool(
            name="check_policy",
            description="Check whether an action is permitted by the policy engine. Returns pass/fail + reason.",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "description": "The action being attempted"},
                    "context": {"type": "object", "description": "Relevant context (agent, task, etc.)"},
                },
                "required": ["action", "context"],
            },
        ),
        mcp_types.Tool(
            name="detect_doom_loop",
            description="Detect infinite retry loops in an agent's call sequence. Returns signal + evidence.",
            inputSchema={
                "type": "object",
                "properties": {
                    "call_sequence": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Ordered list of recent tool/action calls",
                    },
                    "agent_id": {"type": "string"},
                },
                "required": ["call_sequence", "agent_id"],
            },
        ),
        mcp_types.Tool(
            name="persist_memory",
            description="Persist a fact or insight to the knowledge graph for future retrieval.",
            inputSchema={
                "type": "object",
                "properties": {
                    "fact": {"type": "string", "description": "The fact to persist"},
                    "graph_context": {
                        "type": "object",
                        "description": "Optional metadata: agent, task_id, tags, related_entities",
                    },
                },
                "required": ["fact"],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[mcp_types.TextContent]:
    result = await dispatch_tool(name, arguments)
    return [mcp_types.TextContent(type="text", text=json.dumps(result))]


async def dispatch_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    # Contract enforcement: reject any attempt to orchestrate
    FORBIDDEN_PATTERNS = ["create_task", "schedule", "assign_agent", "write_audit", "update_budget"]
    for pattern in FORBIDDEN_PATTERNS:
        if pattern in json.dumps(arguments):
            return {
                "error": "MCP_CONTRACT_VIOLATION",
                "code": "E005",
                "message": f"PraisonAI sidecar cannot perform orchestration actions. Pattern: {pattern}",
            }

    if name == "route_model":
        return await _route_model_json(arguments)
    elif name == "rag_retrieve":
        return _rag_retrieve_json(arguments)
    elif name == "check_policy":
        return _check_policy_json(arguments)
    elif name == "detect_doom_loop":
        return _detect_doom_loop_json(arguments)
    elif name == "persist_memory":
        return _persist_memory_json(arguments)
    else:
        return {"error": f"Unknown tool: {name}"}


async def _route_model_json(args: dict[str, Any]) -> dict[str, Any]:
    model_key = args.get("model_preference", "sonnet")
    model_id = MODEL_MAP.get(model_key, MODEL_MAP["sonnet"])
    prompt = args["prompt"]
    system = args.get("system", "")
    max_tokens = int(args.get("max_tokens", 4096) or 4096)

    try:
        if model_key in ("gpt4o", "gpt5.4"):
            messages = [{"role": "user", "content": prompt}]
            if system:
                messages.insert(0, {"role": "system", "content": system})
            request_kwargs = {
                "model": model_id,
                "messages": messages,
            }
            if model_key == "gpt5.4":
                request_kwargs["max_completion_tokens"] = max_tokens
            else:
                request_kwargs["max_tokens"] = max_tokens
            resp = openai_client.chat.completions.create(**request_kwargs)
            content = resp.choices[0].message.content or ""
            tokens_in = resp.usage.prompt_tokens if resp.usage else 0
            tokens_out = resp.usage.completion_tokens if resp.usage else 0
        else:
            messages = [{"role": "user", "content": prompt}]
            resp = anthropic_client.messages.create(
                model=model_id,
                max_tokens=max_tokens,
                system=system or "You are a helpful assistant.",
                messages=messages,
            )
            content = resp.content[0].text if resp.content else ""
            tokens_in = resp.usage.input_tokens
            tokens_out = resp.usage.output_tokens

        return {
            "content": content,
            "model": model_id,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }

    except Exception as e:
        return {
            "error": str(e),
            "model": model_id,
        }


def _rag_retrieve_json(args: dict[str, Any]) -> dict[str, Any]:
    query = args["query"]
    k = args.get("k", 5)

    # Simple keyword-based retrieval from in-memory store.
    # TODO: Replace with vector embeddings (OpenAI/Voyage) + FAISS/Pinecone.
    query_words = set(query.lower().split())
    scored = []
    for entry in _memory_store:
        fact_words = set(entry["fact"].lower().split())
        overlap = len(query_words & fact_words)
        if overlap > 0:
            scored.append((overlap, entry))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = [entry for _, entry in scored[:k]]

    return {
        "results": results,
        "total_in_store": len(_memory_store),
    }


def _check_policy_json(args: dict[str, Any]) -> dict[str, Any]:
    action = args["action"]

    # Policy rules — expand as Organism grows
    BLOCKED_ACTIONS = [
        ("delete user data", "E001: User data deletion requires explicit human approval"),
        ("drop table", "E001: Database destructive operations are blocked"),
        ("push --force", "Engineering agent git rules: force push is blocked"),
        ("git reset --hard", "Engineering agent git rules: hard reset is blocked"),
    ]

    action_lower = action.lower()
    for pattern, reason in BLOCKED_ACTIONS:
        if pattern in action_lower:
            return {
                "result": "FAIL",
                "reason": reason,
                "action": action,
            }

    return {
        "result": "PASS",
        "reason": "No policy violations detected",
        "action": action,
    }


def _detect_doom_loop_json(args: dict[str, Any]) -> dict[str, Any]:
    sequence = args["call_sequence"]
    agent_id = args["agent_id"]

    # Store recent sequences per agent
    _call_sequences[agent_id] = (_call_sequences.get(agent_id, []) + sequence)[-50:]

    # Doom loop heuristics:
    # 1. Same action repeated 3+ times consecutively
    if len(sequence) >= 3:
        for i in range(len(sequence) - 2):
            if sequence[i] == sequence[i+1] == sequence[i+2]:
                return {
                    "signal": True,
                    "code": "E004",
                    "evidence": f"Action '{sequence[i]}' repeated 3 times consecutively",
                    "recommendation": "Break the loop: add a stop condition or escalate to CEO",
                }

    # 2. Sequence fingerprint seen before (cycle detection)
    if len(sequence) >= 4:
        fingerprint = hashlib.md5(json.dumps(sequence[-4:]).encode()).hexdigest()
        history = _call_sequences.get(f"{agent_id}_fingerprints", [])
        if fingerprint in history:
            return {
                "signal": True,
                "code": "E004",
                "evidence": f"Sequence fingerprint {fingerprint[:8]} seen before (cycle)",
                "recommendation": "Agent is cycling — stop and report to orchestrator",
            }
        _call_sequences[f"{agent_id}_fingerprints"] = (history + [fingerprint])[-20:]

    return {
        "signal": False,
        "evidence": "No doom loop detected",
    }


def _persist_memory_json(args: dict[str, Any]) -> dict[str, Any]:
    fact = args["fact"]
    graph_context = args.get("graph_context", {})

    entry = {
        "fact": fact,
        "context": graph_context,
        "id": hashlib.sha256(fact.encode()).hexdigest()[:16],
    }

    # Deduplicate by fact hash
    existing_ids = {e["id"] for e in _memory_store}
    if entry["id"] not in existing_ids:
        _memory_store.append(entry)

    return {
        "status": "persisted",
        "id": entry["id"],
        "total_in_store": len(_memory_store),
    }


if __name__ == "__main__":
    import asyncio
    if len(sys.argv) >= 3 and sys.argv[1] == "--cli":
        tool_name = sys.argv[2]
        raw_args = sys.stdin.read().strip()
        tool_args = json.loads(raw_args) if raw_args else {}
        print(json.dumps(asyncio.run(dispatch_tool(tool_name, tool_args))))
    else:
        asyncio.run(stdio_server(app))
