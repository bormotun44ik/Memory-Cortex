# Memory-Cortex

Brain-like memory daemon for AI agents. Four-level hierarchy (L0 raw → L1 episodic → L2 semantic → L3 crystallized rules) plus an entity graph with spreading-activation retrieval.

## Canonical reference

`docs/architecture.md` is the single source of truth. On any conflict between this file and the doc, the doc wins.

## Code conventions

- **Runtime:** Node.js LTS, ESM (.mjs throughout).
- **Storage:** SQLite via `better-sqlite3` (synchronous, no ORM). Raw SQL everywhere. Numbered `.sql` migrations in `migrations/`.
- **HTTP:** Fastify with JSON-schema validation on every endpoint.
- **LLM:** Background calls only (haiku worker, sonnet judge). Zero LLM on the retrieval hot path.
- **MCP:** `@modelcontextprotocol/sdk` for the agent-facing tool server.
- **Style:** Minimal comments (only non-obvious "why"). No abstractions beyond what the task requires.

## Key invariants

1. Zero LLM / zero network / zero embeddings on the retrieval hot path.
2. L0 raw events are never exposed via any agent-facing endpoint.
3. Writes are non-blocking: sync_turn → L0 append < 1ms.
4. v0 has no embeddings anywhere — BM25 + entity overlap + temporal proximity.
