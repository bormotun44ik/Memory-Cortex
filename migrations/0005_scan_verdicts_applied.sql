-- Tracks which scan verdicts have been applied (approved/skipped).
-- Prevents double-application and enables audit trail.

CREATE TABLE IF NOT EXISTS scan_verdicts_applied (
  verdict_id  TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  action      TEXT NOT NULL    -- 'apply' | 'skip' | 'owner_approve' | 'owner_skip'
);
