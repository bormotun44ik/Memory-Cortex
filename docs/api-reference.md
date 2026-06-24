# API Reference

All endpoints require the `Authorization: Bearer <CORTEX_SECRET>` header unless noted otherwise.

Base URL: `http://127.0.0.1:7100` (default)

## Provider Endpoints

Used by agent frameworks (Hermes, OpenClaw) for automatic memory injection.

### POST /provider/prefetch

Get a formatted memory context block for prompt injection. Zero-LLM, 5–15 ms.

```bash
curl -X POST http://127.0.0.1:7100/provider/prefetch \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","messages":["What port is the proxy running on?"],"context_remaining":500}'
```

**Request body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| agent | string | yes | Agent identity |
| messages | string[] | yes | Recent conversation messages for context extraction |
| context_remaining | number | no | Max tokens for memory block (default: 500) |

**Response:** Memory block with HOT facts (full text) and WARM stubs (recall IDs).

### POST /provider/sync

Record an agent turn as an L0 event. Non-blocking (< 1 ms).

```bash
curl -X POST http://127.0.0.1:7100/provider/sync \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","session":"sess_123","content":"User asked about Redis config","type":"exchange","source_type":"user_authored"}'
```

### POST /provider/compress

Get L1 summaries for in-session context window compaction.

```bash
curl -X POST http://127.0.0.1:7100/provider/compress \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","turns":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}'
```

### POST /provider/session_end

Signal end of session. Triggers dreaming pipeline (background insight extraction).

```bash
curl -X POST http://127.0.0.1:7100/provider/session_end \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","session":"sess_123"}'
```

## MCP Endpoints

Agent-facing pull retrieval. All serve **L2 facts only** (L0/L1 never exposed).

### POST /mcp/query

Search memory with full graph activation + count-rule gate.

```bash
curl -X POST http://127.0.0.1:7100/mcp/query \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"query":"Redis configuration","limit":10,"agent":"default"}'
```

**Response:**
```json
{
  "facts": [
    {"id":"fact_abc","text":"Redis 7.2 deployed as session cache...","confidence":0.7,"source_type":"user_authored","injection_status":"inject"}
  ],
  "entity_count": 3,
  "activated_nodes": 8,
  "elapsed_ms": 6.2
}
```

### POST /mcp/search

Simple BM25 full-text search on L2 facts (no graph activation).

```bash
curl -X POST http://127.0.0.1:7100/mcp/search \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"query":"nginx proxy","limit":10}'
```

### GET /mcp/fact/:id

Get a single L2 fact by ID. Supports `ref_N` aliases from warm stubs.

```bash
curl http://127.0.0.1:7100/mcp/fact/fact_abc123 \
  -H "Authorization: Bearer $SECRET"
```

### POST /mcp/remember

Store a fact directly in L2 (bypasses L0/L1 pipeline).

```bash
curl -X POST http://127.0.0.1:7100/mcp/remember \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"fact_text":"Redis runs on port 6379 with maxmemory 2GB","entities":["Redis"],"source_type":"user_authored"}'
```

### POST /mcp/observe

Record a raw L0 observation (will be consolidated by background pipeline).

```bash
curl -X POST http://127.0.0.1:7100/mcp/observe \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent":"default","session":"sess_123","content":"Deployed Redis 7.2","type":"exchange","source_type":"tool_result"}'
```

### GET /mcp/timeline

Chronological L2 facts for an entity.

```bash
curl "http://127.0.0.1:7100/mcp/timeline?entity=Redis&limit=20" \
  -H "Authorization: Bearer $SECRET"
```

**Query params:** `entity` (required), `limit`, `from` (timestamp ms), `to` (timestamp ms)

### GET /mcp/graph/neighbors/:nodeId

Get a graph node and its edges.

```bash
curl http://127.0.0.1:7100/mcp/graph/neighbors/node_redis \
  -H "Authorization: Bearer $SECRET"
```

### GET /mcp/graph/activate

Run spreading activation on given entities, return activated nodes.

```bash
curl "http://127.0.0.1:7100/mcp/graph/activate?entities=Redis,PostgreSQL" \
  -H "Authorization: Bearer $SECRET"
```

### GET /mcp/slots/:agent/:key

Read a slot value.

```bash
curl http://127.0.0.1:7100/mcp/slots/default/session_context \
  -H "Authorization: Bearer $SECRET"
```

### PUT /mcp/slots/:agent/:key

Write a slot value.

```bash
curl -X PUT http://127.0.0.1:7100/mcp/slots/default/active_task \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"value":{"task":"deploy redis","priority":"high"}}'
```

## Admin Endpoints

### GET /health

System health check. **No authentication required.**

```bash
curl http://127.0.0.1:7100/health
```

**Response:**
```json
{"status":"ok","schema_version":8,"graph_nodes":1500,"uptime_ms":86400000}
```

### GET /stats

Record counts at each level.

```bash
curl http://127.0.0.1:7100/stats \
  -H "Authorization: Bearer $SECRET"
```

**Response:**
```json
{"l0":44000,"l1":6800,"l2":28000,"graph_nodes":15000}
```

### POST /admin/reload-graph

Reload graph from SQLite into memory (after manual DB changes).

```bash
curl -X POST http://127.0.0.1:7100/admin/reload-graph \
  -H "Authorization: Bearer $SECRET"
```

### POST /admin/consolidate

Trigger consolidation manually (runs in background).

```bash
curl -X POST http://127.0.0.1:7100/admin/consolidate \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"modules":["l0l1","l1l2"]}'
```

**Modules:** `l0l1`, `l1l2`, `l2l3`

### GET /admin/l3/pending

List pending L3 rule proposals.

```bash
curl http://127.0.0.1:7100/admin/l3/pending \
  -H "Authorization: Bearer $SECRET"
```

### POST /admin/l3/approve/:id

Approve a pending L3 rule (makes it live).

```bash
curl -X POST http://127.0.0.1:7100/admin/l3/approve/rule_abc \
  -H "Authorization: Bearer $SECRET"
```

### DELETE /admin/l3/reject/:id

Reject and delete a pending L3 rule.

```bash
curl -X DELETE http://127.0.0.1:7100/admin/l3/reject/rule_abc \
  -H "Authorization: Bearer $SECRET"
```

### POST /admin/supersession/apply/:vid

Apply a supersession verdict (zero the old fact).

```bash
curl -X POST http://127.0.0.1:7100/admin/supersession/apply/sv_123 \
  -H "Authorization: Bearer $SECRET"
```

### POST /admin/supersession/skip/:vid

Skip a supersession verdict (keep both facts).

```bash
curl -X POST http://127.0.0.1:7100/admin/supersession/skip/sv_123 \
  -H "Authorization: Bearer $SECRET"
```
