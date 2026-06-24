// In-session window compaction — token-budget protect zone.
// Called by sync_turn when context ratio > 0.50 (eager.mjs triggers preemptive L0→L1).
//
// Protection zone: walk backward from current turn, accumulate tokens,
// protect last N tokens (default 20K). Everything before = compaction candidates.
// Coding agents get ~3-5 turns, chat agents ~15-20 (auto-adapts to shape).
//
// Fork (b): two prompt templates — raw L0 and structured L1 union.
// Depth tracking: L1 reuse increments compaction_depth.

const PROTECT_LAST_TOKENS_DEFAULT = 20_000;
const COMPACTION_MARKER = '[earlier context compressed — use prefetch for details]';

// Walk backward from turns, find the split point between protect zone and candidates.
// turns: [{tokens, l1_id?}] from newest to oldest (reversed chronological).
export function findProtectBoundary(turns, protectTokens = PROTECT_LAST_TOKENS_DEFAULT) {
  let budget = protectTokens;
  let splitIdx = 0;
  // Walk from newest (end) backward
  for (let i = turns.length - 1; i >= 0; i--) {
    budget -= turns[i].tokens;
    if (budget <= 0) { splitIdx = i; break; }
  }
  return {
    protect: turns.slice(splitIdx),      // newest, kept raw
    candidates: turns.slice(0, splitIdx), // oldest, compaction targets
  };
}

// Assemble compacted window.
// For each candidate turn: if L1 summary exists → substitute; else truncation marker.
export function assembleWindow(candidates, protectedTurns, l1Summaries, { systemPromptTokens = 9000 } = {}) {
  const compacted = [];
  let compactedTokens = 0;

  for (const turn of candidates) {
    if (turn.l1_id && l1Summaries.has(turn.l1_id)) {
      const summary = l1Summaries.get(turn.l1_id);
      compacted.push({ type: 'l1_summary', text: summary.summary_text, tokens: summary.token_count, depth: summary.compaction_depth });
      compactedTokens += summary.token_count;
    } else {
      compacted.push({ type: 'marker', text: COMPACTION_MARKER, tokens: 15 });
      compactedTokens += 15;
    }
  }

  const protectedTokens = protectedTurns.reduce((sum, t) => sum + t.tokens, 0);
  return {
    compacted,
    protected: protectedTurns,
    total_tokens: systemPromptTokens + compactedTokens + protectedTokens,
    compacted_tokens: compactedTokens,
    protected_tokens: protectedTokens,
  };
}

// Depth tracking: increment compaction_depth on reused L1 records.
export function trackDepth(db, reusedL1Ids) {
  const stmt = db.prepare('UPDATE l1_episodic SET compaction_depth=compaction_depth+1 WHERE id=?');
  let maxDepth = 0;
  for (const id of reusedL1Ids) {
    stmt.run(id);
    const row = db.prepare('SELECT compaction_depth FROM l1_episodic WHERE id=?').get(id);
    if (row && row.compaction_depth > maxDepth) maxDepth = row.compaction_depth;
  }
  return {
    maxDepth,
    warning: maxDepth >= 4 ? 'compaction quality degrading' : null,
    reanchor: maxDepth >= 5,
    userFlag: maxDepth >= 6 ? 'session very long, quality may degrade' : null,
  };
}
