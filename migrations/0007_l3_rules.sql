-- L3 crystallized rules — approved proposals from l2-to-l3 pipeline.
-- Per architecture: YAML file is the injection surface, this table tracks
-- proposals + approvals + metadata. Rules injected into system prompt
-- via relevance filter (entity overlap) with 2000 token budget.

CREATE TABLE IF NOT EXISTS l3_rules (
 id TEXT PRIMARY KEY, -- "rule_<ulid>"
 agent TEXT NOT NULL DEFAULT 'all', -- "all" | "my-agent" | agent name
 text TEXT NOT NULL, -- concise actionable rule (1 line)
 entities TEXT, -- JSON array for relevance filter
 source_facts TEXT NOT NULL, -- JSON array of L2 fact ids
 confidence REAL NOT NULL,
 access_count INTEGER NOT NULL DEFAULT 0,
 last_accessed INTEGER,
 auto_approved INTEGER NOT NULL DEFAULT 0, -- 1=auto, 0=owner-approved
 pending INTEGER NOT NULL DEFAULT 1, -- 1=pending review, 0=approved
 prompt_hash TEXT, -- which prompt produced this
 judge_model_id TEXT, -- which model judged
 created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('now','subsec')*1000 AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_l3_agent ON l3_rules(agent);
CREATE INDEX IF NOT EXISTS idx_l3_pending ON l3_rules(pending);
CREATE INDEX IF NOT EXISTS idx_l3_approved ON l3_rules(pending, agent) WHERE pending = 0;
