-- Phase 2 cognitive layer schema additions.
-- All mechanisms ship in gated/shadow/observational mode.

-- C1: utilization counters on L2 facts (+0.4ms hot-path UPDATE cost, acknowledged)
ALTER TABLE l2_semantic ADD COLUMN injected_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE l2_semantic ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;

-- E3: surprise-at-consolidation boolean
ALTER TABLE l2_semantic ADD COLUMN salience_boosted INTEGER NOT NULL DEFAULT 0;

-- E2: contrastive deltas (differs_from chain)
ALTER TABLE l2_semantic ADD COLUMN differs_from TEXT; -- JSON {fact_id, delta_text}

-- R2: shadow confidence deltas (NEVER applied to real confidence in 2a — shadow only)
CREATE TABLE IF NOT EXISTS shadow_confidence_delta (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 fact_id TEXT NOT NULL,
 delta REAL NOT NULL,
 signal_type TEXT NOT NULL, -- 'access_rank' | 'correction' | 'beta_posterior'
 artifacts_matched TEXT, -- JSON array of matched key_artifacts
 ts INTEGER NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_shadow_fact ON shadow_confidence_delta(fact_id);
CREATE INDEX IF NOT EXISTS idx_shadow_ts ON shadow_confidence_delta(ts);

-- R3: prospective bookmarks
CREATE TABLE IF NOT EXISTS bookmarks (
 id TEXT PRIMARY KEY,
 agent TEXT NOT NULL,
 trigger_entities TEXT NOT NULL, -- JSON array
 fact_id TEXT NOT NULL,
 content_type TEXT NOT NULL CHECK (content_type IN ('world_fact', 'user_preference')),
 fire_count INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_agent ON bookmarks(agent);
CREATE INDEX IF NOT EXISTS idx_bookmarks_expires ON bookmarks(expires_at);

CREATE TABLE IF NOT EXISTS calibration_probes (
 id TEXT PRIMARY KEY,
 fact_id TEXT NOT NULL,
 probe_command TEXT NOT NULL,
 probe_result TEXT, -- 'STILL_CORRECT' | 'NOW_WRONG' | 'SUPERSEDED' | 'UNVERIFIABLE'
 probe_output TEXT,
 confidence_at_probe REAL,
 prompt_hash TEXT,
 judge_model_id TEXT,
 run_id TEXT,
 created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);

CREATE TABLE IF NOT EXISTS calibration_runs (
 id TEXT PRIMARY KEY,
 ece REAL,
 probes_total INTEGER,
 probes_correct INTEGER,
 probes_wrong INTEGER,
 probes_unverifiable INTEGER,
 knob_snapshot TEXT,
 created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);
