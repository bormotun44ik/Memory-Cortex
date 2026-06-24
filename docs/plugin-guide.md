# Plugin Guide

Three ways to integrate Memory Cortex with your agent.

## Option A: MCP (Recommended)

The simplest integration. Memory Cortex ships an MCP server that any MCP-compatible client can use directly.

### Claude Code

Add to your project's `.claude/settings.json` or global settings:

```json
{
  "mcpServers": {
    "memory-cortex": {
      "command": "npx",
      "args": ["cortex", "mcp"],
      "env": {
        "CORTEX_URL": "http://127.0.0.1:7100",
        "CORTEX_SECRET": "your-secret"
      }
    }
  }
}
```

Your agent now has access to `memory_search`, `memory_remember`, `memory_observe`, `memory_prefetch`, `memory_timeline`, and `memory_status`.

### Any MCP Client

Start the MCP server as a stdio process:

```bash
CORTEX_URL=http://127.0.0.1:7100 CORTEX_SECRET=your-secret npx cortex mcp
```

Connect your MCP client to its stdin/stdout.

## Option B: HTTP API

Call the Cortex daemon directly over HTTP. No MCP required.

### Search memory

```bash
curl -X POST http://127.0.0.1:7100/mcp/query \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"query": "database configuration", "limit": 10}'
```

### Store a fact

```bash
curl -X POST http://127.0.0.1:7100/mcp/remember \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"fact_text": "PostgreSQL runs on port 5432", "source_type": "user_authored"}'
```

### Get memory context for a prompt

```bash
curl -X POST http://127.0.0.1:7100/provider/prefetch \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent": "my-agent", "messages": ["What port is Postgres on?"], "context_remaining": 500}'
```

See [API Reference](api-reference.md) for the full endpoint list.

## Option C: Custom Plugin

For frameworks with a plugin/provider system (like Hermes), write a thin HTTP wrapper.

### Python

```python
import httpx

class CortexMemory:
    def __init__(self, url="http://127.0.0.1:7100", secret=""):
        self.url = url
        self.headers = {"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}

    def search(self, query, limit=20):
        r = httpx.post(f"{self.url}/mcp/query", json={"query": query, "limit": limit}, headers=self.headers)
        return r.json()

    def remember(self, content, source_type="user_authored"):
        r = httpx.post(f"{self.url}/mcp/remember", json={"fact_text": content, "source_type": source_type}, headers=self.headers)
        return r.json()

    def prefetch(self, messages, agent="default", budget=500):
        r = httpx.post(f"{self.url}/provider/prefetch", json={
            "agent": agent, "messages": messages, "context_remaining": budget
        }, headers=self.headers)
        return r.json()

    def observe(self, content, agent="default", session=None):
        r = httpx.post(f"{self.url}/mcp/observe", json={
            "agent": agent, "session": session or f"plugin_{id(self)}", "content": content,
            "type": "exchange", "source_type": "agent_internal"
        }, headers=self.headers)
        return r.json()
```

### Node.js

```javascript
const CORTEX_URL = process.env.CORTEX_URL || 'http://127.0.0.1:7100';
const SECRET = process.env.CORTEX_SECRET || '';

async function cortexSearch(query, limit = 20) {
  const res = await fetch(`${CORTEX_URL}/mcp/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  return res.json();
}

async function cortexRemember(factText, sourceType = 'user_authored') {
  const res = await fetch(`${CORTEX_URL}/mcp/remember`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fact_text: factText, source_type: sourceType }),
  });
  return res.json();
}

async function cortexPrefetch(messages, agent = 'default', budget = 500) {
  const res = await fetch(`${CORTEX_URL}/provider/prefetch`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, messages, context_remaining: budget }),
  });
  return res.json();
}
```

### Integration Pattern

A typical agent loop with Memory Cortex:

```
1. Before agent turn:
   prefetch(last_3_messages) → memory_block
   Prepend memory_block to system prompt

2. During agent turn:
   Agent runs, produces response

3. After agent turn:
   observe(user_message + response)  # → L0 for background consolidation
   sync utilization data              # → C1 measures what was used

4. On session end:
   POST /provider/session_end         # → triggers dreaming pipeline
```

The background pipeline handles everything else: L0 → L1 → L2 → L3 consolidation, contradiction detection, graph maintenance, and L0 cleanup.
