-- 0004_scan_verdicts_pending.sql
-- Contradiction judge MAY NOT auto-apply where the losing fact is
-- user_authored and winning evidence is tool_result_external. Such pairs route
-- to pending_proposals for human review.
-- 0 = auto-applied (or UNRELATED, no action needed)
-- 1 = pending approval
ALTER TABLE scan_verdicts ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
