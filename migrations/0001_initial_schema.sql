-- 0001_initial_schema.sql
-- Memory-Cortex v0 base schema.
-- Canonical reference: docs/architecture.md
--
-- v0: NO embeddings anywhere. embedding / embedding_model columns
-- exist as escape hatches and stay EMPTY in v0.

-- ============================================================
-- L0 — raw event log (append-only)
-- ============================================================
CREATE TABLE l0_raw (
 id TEXT PRIMARY KEY, -- "obs_<ulid>"
 ts INTEGER NOT NULL, -- event-time, unix ms. Used for consolidation
 -- grouping + graph recency ONLY — never retention
 ingested_at INTEGER NOT NULL
 DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER)),
 -- wall-clock arrival, unix ms. THE retention clock:
 -- delete only when >=14d wall AND parent L1
 -- consolidated/non-promotable; hard cap 90d wall
 session TEXT NOT NULL,
 agent TEXT NOT NULL, -- agent identity name
 type TEXT NOT NULL, -- "exchange" | "tool_call" | "tool_result" | "system_event"
 source_type TEXT NOT NULL DEFAULT 'agent_internal'
 CHECK (source_type IN
 ('user_authored','tool_result','tool_result_external','agent_internal')),
 -- write-time trust tag.
 -- tool_result_external = crossed a network boundary
 -- (web_fetch, external APIs).
 -- Unlabeled writes fail-safe to LOWEST trust class
 content TEXT NOT NULL,
 entities TEXT, -- JSON array, auto-extracted
 tokens INTEGER,
 salience REAL NOT NULL DEFAULT 0.5, -- regex-scored at write time (0-1)
 consolidated_to TEXT -- L1 id once consolidated
);
CREATE INDEX idx_l0_ts ON l0_raw(ts);
CREATE INDEX idx_l0_ingested ON l0_raw(ingested_at); -- used by retention scanner
CREATE INDEX idx_l0_session ON l0_raw(session);
CREATE INDEX idx_l0_agent ON l0_raw(agent);
CREATE INDEX idx_l0_unconsolidated ON l0_raw(consolidated_to) WHERE consolidated_to IS NULL;

-- ============================================================
-- L1 — episodic summaries
-- ============================================================
CREATE TABLE l1_episodic (
 id TEXT PRIMARY KEY, -- "epi_<ulid>"
 ts INTEGER NOT NULL, -- event-time of summarized span, unix ms
 created_at INTEGER NOT NULL
 DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER)),
 -- wall-clock; retention reads this
 -- (imported legacy rows must not self-delete on arrival)
 session TEXT,
 agent TEXT NOT NULL,
 topic TEXT, -- dominant entities, comma-separated
 summary BLOB NOT NULL, -- structured JSON {done,decided,remaining,key_artifacts}
 summary_text TEXT NOT NULL, -- flattened text for FTS
 entities TEXT, -- JSON array
 source_type TEXT NOT NULL DEFAULT 'agent_internal'
 CHECK (source_type IN
 ('user_authored','tool_result','tool_result_external','agent_internal')),
 -- LOWEST trust class among source L0 records;
 -- unlabeled fail-safes to lowest trust
 embedding BLOB, -- EMPTY in v0 (design rule)
 embedding_model TEXT, -- escape hatch, EMPTY in v0
 prompt_hash TEXT, -- tracks which prompt produced this; NULL = not LLM-produced
 judge_model_id TEXT, -- tracks which model judged this
 source_l0_ids TEXT, -- JSON array of L0 ids
 token_count INTEGER,
 compaction_depth INTEGER NOT NULL DEFAULT 0, -- reuse counter for compaction depth
 consolidated_to TEXT -- L2 id when promoted
);
CREATE INDEX idx_l1_ts ON l1_episodic(ts);
CREATE INDEX idx_l1_created ON l1_episodic(created_at);
CREATE INDEX idx_l1_agent ON l1_episodic(agent);
CREATE INDEX idx_l1_unconsolidated ON l1_episodic(consolidated_to) WHERE consolidated_to IS NULL;

-- ============================================================
-- L2 — semantic facts (permanent until contradicted, versioned)
-- ============================================================
CREATE TABLE l2_semantic (
 id TEXT PRIMARY KEY, -- "fact_<ulid>"
 created_at INTEGER NOT NULL
 DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER)),
 updated_at INTEGER,
 fact_text TEXT NOT NULL, -- hard length cap enforced in code before storage
 -- (hard cap prevents oversized facts)
 entities TEXT, -- JSON array
 confidence REAL NOT NULL DEFAULT 0.7,
 access_count INTEGER NOT NULL DEFAULT 0,
 last_accessed INTEGER,
 source_type TEXT NOT NULL DEFAULT 'agent_internal'
 CHECK (source_type IN
 ('user_authored','tool_result','tool_result_external','agent_internal')),
 -- LOWEST trust class among sources;
 -- unlabeled fail-safes to lowest trust.
 -- contradiction judge prompt includes this for context
 bypass_recurrence INTEGER NOT NULL DEFAULT 0,-- one-shot bypass flag (boolean 0/1)
 embedding BLOB, -- EMPTY in v0
 embedding_model TEXT, -- escape hatch, EMPTY in v0
 prompt_hash TEXT, -- tracks which prompt produced this; NULL = not LLM-produced
 judge_model_id TEXT, -- tracks which model judged this
 version INTEGER NOT NULL DEFAULT 1,
 prev_version_id TEXT,
 source_l1_ids TEXT, -- JSON array
 source_l0_sample TEXT, -- JSON array of sampled L0 ids (re-anchoring)
 contradicts TEXT, -- JSON array of fact ids
 contradicted_by TEXT, -- JSON array of fact ids
 scope TEXT NOT NULL DEFAULT 'shared', -- "shared" | "agent:<name>" | "user:<name>"
 source_agent TEXT,
 crystallized_to TEXT, -- L3 rule id if promoted
 tags TEXT -- JSON array
);
CREATE INDEX idx_l2_entities ON l2_semantic(entities);
CREATE INDEX idx_l2_access ON l2_semantic(access_count);
CREATE INDEX idx_l2_scope ON l2_semantic(scope);

-- ============================================================
-- Slots — pinned mutable state (per-key TTL lives in config)
-- ============================================================
CREATE TABLE slots (
 agent TEXT NOT NULL,
 key TEXT NOT NULL,
 value TEXT NOT NULL, -- JSON
 updated_at INTEGER NOT NULL
 DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER)),
 -- heartbeat target: sync_turn touches this
 PRIMARY KEY (agent, key)
);

-- ============================================================
-- Graph — persisted form of the in-memory graph
-- ============================================================
CREATE TABLE graph_nodes (
 id TEXT PRIMARY KEY,
 label TEXT NOT NULL,
 type TEXT NOT NULL, -- project|tool|service|server|person|concept|file|error|action|config
 weight REAL NOT NULL DEFAULT 1.0,
 access_count INTEGER NOT NULL DEFAULT 0,
 access_count_by_agent TEXT, -- JSON: {"agent-1": 12, "agent-2": 3}
 last_accessed INTEGER,
 linked_facts TEXT, -- JSON array of L2 fact ids
 aliases TEXT -- JSON array (RU/EN alias dictionary feeds from this)
);

CREATE TABLE graph_edges (
 source TEXT NOT NULL,
 target TEXT NOT NULL,
 relation TEXT NOT NULL, -- typed at L1->L2 consolidation
 weight REAL NOT NULL DEFAULT 0.5,
 evidence_count INTEGER NOT NULL DEFAULT 1,
 last_seen INTEGER,
 valid_from INTEGER, -- temporal validity
 invalid_at INTEGER, -- NULL = still valid
 PRIMARY KEY (source, target, relation)
);

-- ============================================================
-- Scan verdicts — contradiction-scan judge outputs.
-- Provenance (prompt_hash + judge_model_id) tracked on every LLM-produced row.
-- ============================================================
CREATE TABLE scan_verdicts (
 id TEXT PRIMARY KEY, -- "ver_<ulid>"
 scanned_at INTEGER NOT NULL, -- wall-clock ms
 fact_a TEXT NOT NULL, -- existing/older L2 fact id
 fact_b TEXT NOT NULL, -- newer L2 fact id
 verdict TEXT NOT NULL
 CHECK (verdict IN ('CONTRADICTION','SUPERSESSION','UNRELATED')),
 prompt_hash TEXT NOT NULL, -- which prompt produced this verdict
 judge_model_id TEXT NOT NULL, -- which model judged
 knob_snapshot TEXT -- JSON of tunables at verdict time (design rule)
);
CREATE INDEX idx_verdicts_scanned ON scan_verdicts(scanned_at);
CREATE INDEX idx_verdicts_facts ON scan_verdicts(fact_a, fact_b);

-- ============================================================
-- FTS5 — BM25 full-text search (v0: no embeddings, FTS is the primary text retrieval).
-- Default unicode61 tokenizer; works on mixed-language content.
-- ============================================================
CREATE VIRTUAL TABLE l1_fts USING fts5(summary_text, content=l1_episodic, content_rowid=rowid);
CREATE VIRTUAL TABLE l2_fts USING fts5(fact_text, content=l2_semantic, content_rowid=rowid);

-- External-content FTS stays in sync via triggers
CREATE TRIGGER l1_fts_ai AFTER INSERT ON l1_episodic BEGIN
 INSERT INTO l1_fts(rowid, summary_text) VALUES (new.rowid, new.summary_text);
END;
CREATE TRIGGER l1_fts_ad AFTER DELETE ON l1_episodic BEGIN
 INSERT INTO l1_fts(l1_fts, rowid, summary_text) VALUES ('delete', old.rowid, old.summary_text);
END;
CREATE TRIGGER l1_fts_au AFTER UPDATE OF summary_text ON l1_episodic BEGIN
 INSERT INTO l1_fts(l1_fts, rowid, summary_text) VALUES ('delete', old.rowid, old.summary_text);
 INSERT INTO l1_fts(rowid, summary_text) VALUES (new.rowid, new.summary_text);
END;

CREATE TRIGGER l2_fts_ai AFTER INSERT ON l2_semantic BEGIN
 INSERT INTO l2_fts(rowid, fact_text) VALUES (new.rowid, new.fact_text);
END;
CREATE TRIGGER l2_fts_ad AFTER DELETE ON l2_semantic BEGIN
 INSERT INTO l2_fts(l2_fts, rowid, fact_text) VALUES ('delete', old.rowid, old.fact_text);
END;
CREATE TRIGGER l2_fts_au AFTER UPDATE OF fact_text ON l2_semantic BEGIN
 INSERT INTO l2_fts(l2_fts, rowid, fact_text) VALUES ('delete', old.rowid, old.fact_text);
 INSERT INTO l2_fts(rowid, fact_text) VALUES (new.rowid, new.fact_text);
END;
