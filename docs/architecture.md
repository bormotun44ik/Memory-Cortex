# Architecture

Memory Cortex is a single-process daemon that manages a four-level memory hierarchy backed by SQLite and an in-memory entity graph.

## Memory Hierarchy

### L0 — Raw Events

Every interaction is captured as an L0 record: messages, tool calls, tool results, system events. L0 is the write-ahead log of the agent's experience.

- **Stored in:** `l0_raw` table
- **Fields:** id, timestamp, session, agent, type, source_type, content, entities, salience
- **Retention:** 14 days after consolidation, hard cap 90 days
- **Privacy:** L0 is never exposed via any agent-facing endpoint (Invariant 2)

### L1 — Episodic Summaries

Background consolidation groups L0 records by session and topic, then compresses each group into a structured summary via LLM (Haiku).

- **Stored in:** `l1_episodic` table
- **Schema types:** `task` (done/decided/remaining), `exchange` (topic/intent/response), `system_event` (status/anomalies)
- **Created by:** `l0→l1` consolidation every 30 minutes
- **Key property:** preserves verbatim artifacts (file paths, ports, commands)

### L2 — Semantic Facts

L1 episodes are clustered and distilled into atomic, deduplicated facts. Each fact has a confidence score, source type, and entity links.

- **Stored in:** `l2_semantic` table with FTS5 full-text index
- **Fields:** fact_text, confidence (0–1), source_type, entities, scope, access_count
- **Created by:** `l1→l2` consolidation every 6 hours
- **Deduplication:** AUDN (entity overlap ≥ 1 + text Jaccard ≥ 0.3)

### L3 — Crystallized Rules

High-confidence, frequently accessed L2 facts are promoted to rules — procedures, patterns, and guidelines.

- **Stored in:** `l3_rules` table
- **Approval:** L3 proposals are `pending` by default and require explicit approval
- **Created by:** `l2→l3` crystallization daily at 03:00 UTC

## Entity Graph

An in-memory graph of entities (people, tools, services, concepts) extracted from facts, with weighted edges representing co-occurrence relationships.

### Nodes

Each node represents a named entity with:
- `label` — canonical name (lowercase, alias-resolved)
- `weight` — decays over time (0.98/day, floor 0.05)
- `evidence_count` — how many facts link to this node
- `aliases` — alternative names (e.g., `бэкап` → `backup`)

### Edges

Edges represent co-occurrence: two entities appearing in the same fact or same L1 episode.
- `weight` — decays over time, strong edges (evidence > 5) decay slower (0.995/day)
- `evidence_count` — number of co-occurrences

### Spreading Activation

Given a query, the retrieval system:

1. **Extracts entities** from the query text (named entities, technical terms, known aliases)
2. **Seeds** matching graph nodes with score 1.0
3. **Propagates** activation through edges via 3-hop BFS:
   - `w_eff = max(0, (edge_weight - 0.4) / 0.6)` — weak edges contribute nothing
   - `hop_decay = 0.7` per hop — distant nodes contribute less
   - `node.weight` factors into propagation
4. **Normalizes** scores per hop (max-norm) to prevent hub domination
5. **Collects** L2 facts linked to activated nodes

Seed nodes reserve 5 slots in results to prevent hub domination (a densely-connected node absorbing all activation).

## Retrieval Pipeline

### Push (Prefetch)

Called before each agent turn. Returns a formatted memory block (0–500 tokens) for system prompt injection.

```
Query entities → Graph activation → Fact collection → Confidence gate → Slot injection → Token budget assembly
```

1. Extract entities from last few messages + detect topics
2. Run spreading activation on entity graph
3. Collect linked L2 facts from activated nodes (batch SQL)
4. Apply confidence gate (fast mode: inline thresholds)
5. Inject active slot values (session context, active task)
6. Partition into HOT (full text) and WARM (stubs with recall IDs)
7. Assemble within token budget

**Latency target:** 5–15 ms, zero LLM calls.

### Pull (MCP Query)

Called when the agent explicitly searches memory. Uses the same graph search engine but with full count-rule gating.

```
Query → Graph activation → Fact collection → Full gate (count-rule + distinct sessions) → Ranked results
```

### Confidence Gate

Each fact's injection status depends on confidence and confirmation count:

| Status | Criteria | Behavior |
|--------|----------|----------|
| **inject** | confidence ≥ 0.4 AND distinct_sessions ≥ 2 | Full text in results |
| **annotate** | confidence ≥ 0.15 OR single-session | Included with low-confidence marker |
| **suppress** | confidence < 0.15 AND 0 sessions | Excluded from results |

Trusted escape: `user_authored` and `tool_result` facts with 0 sessions get `annotate` (not suppress).

## Source Types and Trust

Every record carries a `source_type` indicating its trust level:

| Source Type | Trust | Description |
|-------------|-------|-------------|
| `tool_result` | Highest | Output from tools (verified data) |
| `user_authored` | High | Direct user input |
| `tool_result_external` | Medium | External tool output (less trusted) |
| `agent_internal` | Lowest | Agent's own reasoning/inference |

**Lowest-trust inheritance:** when consolidating multiple records, the result inherits the least trusted source type among its inputs.

**Agent self-confirmation guard:** facts confirmed only by `agent_internal` sessions cannot accumulate count-rule confirmations (prevents echo chamber).

## Consolidation Pipeline

All consolidation runs in the background via scheduled jobs (croner):

| Job | Schedule | What |
|-----|----------|------|
| L0 → L1 | Every 30 min | Group L0 by session+topic, compress via Haiku |
| L1 → L2 | Every 6 hours | Cluster L1, extract atomic facts, AUDN dedup |
| L2 → L3 | Daily 03:00 | Promote high-access high-confidence facts to rules |
| Contradiction scan | Daily 03:30 | Find contradicting/superseding fact pairs (Sonnet judge) |
| Graph maintenance | Daily 04:00 | Decay weights, detect orphans |
| L0 retention | Daily 04:30 | Delete old consolidated L0 records |
| Entity queue | Hourly | Review unknown entity candidates |

## Cognitive Layer

Optional mechanisms that improve memory quality over time:

| Module | Purpose |
|--------|---------|
| **C1 Utilization** | Measures which injected facts the agent actually uses |
| **C2 Replay** | Prioritizes under-accessed facts for dreaming |
| **C3 Metamemory** | Warns when seed entities have no graph matches |
| **R1 Page-fault** | HOT/WARM/COLD partitioning with recall stubs |
| **R2 Shadow** | Logs confidence deltas without applying (shadow mode) |
| **R3 Bookmarks** | Query-triggered recall for specific patterns |
| **E1 Provenance** | Tiebreaks by source type in ranking |
| **E3 Surprise** | Boosts related facts when new contradictory info arrives |

## Key Invariants

1. **Zero LLM / zero network / zero embeddings on the retrieval hot path.** Prefetch budget: 5–15 ms, pure SQLite + graph activation.
2. **L0 raw events are never exposed via any agent-facing endpoint.**
3. **Writes are non-blocking:** sync_turn → L0 append < 1 ms; all distillation is background.
4. **v0 has no embeddings anywhere.** Retrieval = BM25(FTS5) + entity overlap + temporal proximity.
5. **Judge ≠ producer:** worker calls run Haiku; judge calls run Sonnet.
6. **Agent-internal can never confirm itself:** excluded from count-rule distinct_sessions.
