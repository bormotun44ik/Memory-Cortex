# Memory Cortex

Brain-like memory daemon for AI agents.

Memory Cortex gives your AI agent persistent, structured long-term memory. Raw observations flow through a four-level hierarchy (L0 raw events → L1 episodic summaries → L2 semantic facts → L3 crystallized rules), backed by an entity graph with spreading-activation retrieval. The retrieval hot path is zero-LLM — pure SQLite + graph activation in 5–15 ms. Works with any MCP-compatible agent: Claude Code, Hermes, OpenClaw, or your own.

## Architecture

```
   Agent (Claude Code / Hermes / any MCP client)
          │
          ▼
   ┌──────────────┐
   │  MCP Server   │  memory_search, memory_remember,
   │  (stdio)      │  memory_observe, memory_prefetch
   └──────┬───────┘
          │ HTTP
          ▼
   ┌──────────────┐     ┌─────────────┐
   │  Cortex       │────▶│ Entity Graph │
   │  Daemon       │     │ (spreading   │
   │  :7100        │     │  activation) │
   └──────┬───────┘     └─────────────┘
          │
          ▼
   ┌──────────────┐
   │  SQLite       │  L0 → L1 → L2 → L3
   │  (single file)│  FTS5 full-text search
   └──────────────┘
```

## Quick Start

```bash
git clone https://github.com/bormotun44ik/Memory-Cortex.git
cd Memory-Cortex

cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY (or OPENROUTER_API_KEY)

npm install
npx cortex init
npx cortex seed      # optional: populate with demo data
npx cortex start
```

The daemon is now running on `http://127.0.0.1:7100`.

## MCP Integration

Add Memory Cortex to Claude Code (or any MCP client) in your settings:

```json
{
  "mcpServers": {
    "memory-cortex": {
      "command": "npx",
      "args": ["cortex", "mcp"],
      "env": {
        "CORTEX_SECRET": "your-secret",
        "CORTEX_URL": "http://127.0.0.1:7100"
      }
    }
  }
}
```

Your agent now has access to six memory tools:

| Tool | Description |
|------|-------------|
| `memory_search` | Search facts by query (graph activation + BM25) |
| `memory_remember` | Store a new fact in long-term memory |
| `memory_observe` | Record a raw observation (consolidated later) |
| `memory_prefetch` | Get a formatted memory block for prompt injection |
| `memory_timeline` | Chronological fact history for an entity |
| `memory_status` | System health and record counts |

## CLI Reference

| Command | Description |
|---------|-------------|
| `cortex init` | Initialize database and run migrations |
| `cortex start` | Start the daemon (HTTP server + background jobs) |
| `cortex status` | Show daemon status and memory stats |
| `cortex import <path>` | Import data to L0 (json, jsonl, markdown, chat logs) |
| `cortex consolidate [module]` | Run consolidation (l0l1, l1l2, or all) |
| `cortex export [level]` | Export data as JSON (l0, l1, l2, graph) |
| `cortex seed` | Populate with demo data |
| `cortex mcp` | Start MCP server (stdio transport) |
| `cortex hooks install` | Install push/pull/compress hooks into Claude Code |
| `cortex hooks status` | Show installed Cortex hooks |
| `cortex hooks remove` | Remove Cortex hooks from Claude Code |

### Import examples

```bash
npx cortex import ./docs/                      # Markdown files (chunked automatically)
npx cortex import data.json                     # JSON array of records
npx cortex import conversations/ --format chat  # Chat logs
npx cortex import events.jsonl                  # JSONL (one record per line)
```

## Memory Hierarchy

| Level | What | Retention | Created by |
|-------|------|-----------|------------|
| **L0** | Raw events (messages, tool calls, observations) | 14–90 days | sync_turn / observe / import |
| **L1** | Episodic summaries (grouped by session + topic) | Permanent | Background consolidation (every 30 min) |
| **L2** | Semantic facts (atomic, deduplicated, confidence-scored) | Permanent | Background consolidation (every 6 hours) |
| **L3** | Crystallized rules (procedures, patterns) | Permanent | Daily promotion (requires approval) |

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DB_PATH` | `./data/cortex.db` | SQLite database path |
| `BIND_HOST` | `127.0.0.1` | Bind address (loopback only by default) |
| `PORT` | `7100` | HTTP port |
| `CORTEX_SECRET` | — | Shared secret for API authentication |
| `CORTEX_LLM_BACKEND` | `anthropic` | LLM provider: `anthropic`, `openrouter`, or `openai` |
| `CORTEX_DEFAULT_AGENT` | `default` | Default agent identity |
| `CRONER_ENABLED` | `false` | Enable all background consolidation jobs |

See `.env.example` for the full list including per-module cron toggles and Telegram integration.

## LLM

LLMs are used for background consolidation only (never on the retrieval hot path). Two API formats — covers everything:

| Format | `CORTEX_LLM_FORMAT` | Works with |
|--------|---------------------|------------|
| **Anthropic Messages API** | `anthropic` (default) | Anthropic direct |
| **OpenAI Chat Completions** | `openai` | OpenRouter, Kimi, GLM, Groq, Ollama, vLLM, anything |

```env
CORTEX_LLM_FORMAT=openai
CORTEX_LLM_URL=https://openrouter.ai/api/v1/chat/completions
CORTEX_LLM_KEY=sk-or-...
CORTEX_WORKER_MODEL=anthropic/claude-haiku-4-5-20251001
CORTEX_JUDGE_MODEL=anthropic/claude-sonnet-4-6
```

Any model on any role — Kimi as judge, Ollama as worker, whatever you want:
```env
CORTEX_LLM_FORMAT=openai
CORTEX_LLM_URL=https://api.moonshot.cn/v1/chat/completions
CORTEX_LLM_KEY=sk-...
CORTEX_JUDGE_MODEL=kimi-k2-0711-preview
CORTEX_WORKER_MODEL=qwen3:8b
```

## Claude Code Integration (Push + Pull + Compress)

Full Hermes-like memory integration for Claude Code via hooks:

```bash
npx cortex hooks install
```

This installs three hooks:

| Hook | Event | What it does |
|------|-------|-------------|
| **Prefetch** | `UserPromptSubmit` | Injects relevant memory before each turn (push) |
| **Sync** | `Stop` | Records exchanges to L0 after each response |
| **Precompact** | `PreCompact` | Saves full context to L0 before compression |

Combined with MCP tools (pull), your Claude Code agent gets the same memory experience as Hermes:
- **Push**: relevant facts auto-injected before every turn
- **Pull**: `memory_search` / `memory_remember` for explicit queries
- **Compress**: context saved to Cortex before Claude Code compacts, so details survive long sessions

## Docker

```bash
cp .env.example .env
# Edit .env with your API key

docker compose up -d
```

The database is persisted in a Docker volume. Access the API at `http://localhost:7100`.

## Key Design Decisions

- **Zero LLM on retrieval hot path** — prefetch completes in 5–15 ms using pure SQLite + graph spreading activation. No network calls, no embeddings.
- **L0 raw events never exposed to agents** — only L2 semantic facts are visible through MCP/API endpoints. Privacy by design.
- **Writes are non-blocking** — sync_turn appends to L0 in < 1 ms. All distillation happens in background jobs.
- **No embeddings in v0** — retrieval uses BM25 full-text search + entity graph overlap + temporal proximity. Embedding column exists but stays empty (escape hatch for future).
- **Shadow-mode confidence** — confidence adjustments are logged but not applied until proven safe (ECE < 0.20 on two consecutive runs).
- **Source trust hierarchy** — `tool_result` > `user_authored` > `tool_result_external` > `agent_internal`. Consolidated records inherit the lowest trust class.

## Documentation

- [Setup Guide](docs/setup-guide.md) — from zero to working memory in 5 minutes
- [Architecture](docs/architecture.md) — memory hierarchy, consolidation pipeline, graph, retrieval
- [API Reference](docs/api-reference.md) — all HTTP endpoints with curl examples
- [Plugin Guide](docs/plugin-guide.md) — MCP, HTTP, and custom plugin integration

## Support

If Memory Cortex is useful to you:

| Network | Address |
|---------|---------|
| **BTC** | `bc1qvdntyatzya2xl7j37r6zm8lrxtcvam5kqp8jmr` |
| **ETH** | `0xF07A0C1C7d2061192C0866185C72e9258dA412Fc` |
| **SOL** | `A81rfV4T6f9AAG29iXSxJtexarDHxoheAHQ9YUJB23aS` |
| **BSC (BEP-20)** | `0xF07A0C1C7d2061192C0866185C72e9258dA412Fc` |

## License

BSL 1.1 (Business Source License). Free for personal, educational, and non-commercial use. Commercial use is not permitted — see [LICENSE](LICENSE). Becomes MIT on 2034-06-25.
