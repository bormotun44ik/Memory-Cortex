# Setup Guide

From zero to working memory in 5 minutes.

## 1. Install

```bash
git clone https://github.com/bormotun44ik/Memory-Cortex.git
cd Memory-Cortex
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env` — the minimum you need:

```env
CORTEX_SECRET=pick-a-secret-string
CORTEX_LLM_FORMAT=anthropic
CORTEX_LLM_URL=https://api.anthropic.com/v1/messages
CORTEX_LLM_KEY=sk-ant-your-key-here
```

Or if you use OpenRouter / Kimi / GLM / Groq / Ollama — any OpenAI-compatible API:

```env
CORTEX_LLM_FORMAT=openai
CORTEX_LLM_URL=https://openrouter.ai/api/v1/chat/completions
CORTEX_LLM_KEY=sk-or-your-key-here
CORTEX_WORKER_MODEL=anthropic/claude-haiku-4-5-20251001
CORTEX_JUDGE_MODEL=anthropic/claude-sonnet-4-6
```

## 3. Initialize

```bash
npx cortex init
```

This creates the SQLite database and runs all migrations.

## 4. Start the daemon

```bash
npx cortex start
```

Daemon runs on `http://127.0.0.1:7100`. Verify:

```bash
curl http://127.0.0.1:7100/health
# → {"status":"ok","schema_version":8,"graph_nodes":0,"uptime_ms":...}
```

## 5. Connect your agent

### Option A: Claude Code (recommended)

```bash
npx cortex hooks install
```

This installs three hooks into `.claude/settings.json`:

| Hook | When | What |
|------|------|------|
| **prefetch** | Before each turn | Injects relevant memory into context (push) |
| **sync** | After each response | Records the exchange to L0 |
| **precompact** | Before context compression | Saves full context to L0 before it's lost |

Plus MCP tools for explicit memory operations:

Add to your Claude Code MCP config (`.claude/settings.json` or global):

```json
{
  "mcpServers": {
    "memory-cortex": {
      "command": "npx",
      "args": ["cortex", "mcp"],
      "cwd": "/path/to/memory-cortex",
      "env": {
        "CORTEX_SECRET": "your-secret",
        "CORTEX_URL": "http://127.0.0.1:7100"
      }
    }
  }
}
```

Restart Claude Code. You now have push + pull + compress.

### Option B: Any MCP client (Hermes, OpenClaw, custom)

Same MCP config — add the server to your agent's MCP settings. The 6 tools (`memory_search`, `memory_remember`, `memory_observe`, `memory_prefetch`, `memory_timeline`, `memory_status`) work with any MCP-compatible client.

### Option C: HTTP API directly

Any language, any framework:

```bash
# Search memory
curl -X POST http://127.0.0.1:7100/mcp/query \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"query": "server configuration", "limit": 10}'

# Remember something
curl -X POST http://127.0.0.1:7100/mcp/remember \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"content": "The database is on port 5432"}'
```

See [API Reference](api-reference.md) for all 22 endpoints.

## 6. Populate memory

### From existing data

```bash
# Markdown documents (auto-chunked by headers)
npx cortex import ./docs/

# JSON array of records
npx cortex import knowledge.json

# Chat logs (OpenAI format: [{role, content}])
npx cortex import conversations/ --format chat

# JSONL (one record per line)
npx cortex import events.jsonl

# Specify trust level
npx cortex import notes.md --source-type user_authored
npx cortex import agent-logs.jsonl --source-type agent_internal
```

Source types matter — they determine trust level:
- `user_authored` — human-written content (highest usable trust)
- `tool_result` — output from tools/APIs (highest trust)
- `agent_internal` — agent's own reasoning (lowest trust, capped at 0.4 confidence)

### Demo data

```bash
npx cortex seed
```

Creates sample L0 records and runs consolidation so you can see the pipeline working.

### From another Cortex instance

```bash
# Export from old instance
npx cortex export --level l2 > facts.json

# Import to new instance
npx cortex import facts.json --source-type user_authored
```

## 7. Enable background consolidation

By default, consolidation is manual. To enable automatic background processing:

```env
CRONER_ENABLED=true
```

Or enable specific modules:

```env
CRON_L0L1=true        # L0→L1 every 30 min
CRON_L1L2=true        # L1→L2 every 6 hours
CRON_L2L3=true        # L2→L3 daily at 03:00
CRON_CONTRADICTION=true  # Contradiction scan daily at 03:30
CRON_MAINTENANCE=true    # Graph maintenance daily at 04:00
```

Restart the daemon after changing `.env`.

## 8. Teach your agent about memory

Add to your project's CLAUDE.md (or system prompt):

```markdown
## Memory

You have access to persistent long-term memory via Memory Cortex.

**Automatic**: relevant memories are injected before each turn. Use them naturally.

**Explicit tools**:
- `memory_search` — search for specific facts ("what port is the database on?")
- `memory_remember` — save important information for future sessions
- `memory_observe` — record a raw observation or event

**When to search**: before answering questions about project state, configuration, 
past decisions, or anything that might have been discussed in previous sessions.

**When to remember**: after learning something new that future sessions should know —
configuration changes, architectural decisions, user preferences.
```

This tells the agent that memory tools exist AND when to use them. Without this, the agent has the tools but doesn't know to reach for them proactively.

## Verify it works

1. Start a Claude Code session in your project
2. Say something memorable: "The database password is stored in /etc/secrets/db.env"
3. End the session
4. Start a new session
5. Ask: "Where is the database password stored?"
6. The prefetch hook should inject the fact, or the agent should find it via `memory_search`

## Troubleshooting

**Daemon not starting**: check `CORTEX_DB_PATH` directory exists, and `PORT` is free.

**LLM errors**: verify `CORTEX_LLM_KEY` is valid. Try `curl` to the LLM URL directly.

**Hooks not firing**: restart Claude Code after `cortex hooks install`. Check `.claude/settings.json`.

**Empty prefetch**: memory needs time to consolidate. Run `npx cortex consolidate` manually, or enable `CRON_L0L1=true`.

**Memory not persisting**: check that the `sync` hook (Stop event) is installed and the daemon is running.
