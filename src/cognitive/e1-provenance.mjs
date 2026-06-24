// E1 — Source-typed provenance tiebreaker.
// TAG not multiplier (Inv: count-rule is sole gate). Step-3 sort tiebreaker only.
// system-state facts: tool_result > user_authored
// user-intent facts: user_authored at parity. 0 knobs.

const SOURCE_PRIORITY = {
  tool_result: 4,
  user_authored: 3,
  tool_result_external: 2,
  agent_internal: 1,
};

export function provenanceTiebreak(a, b) {
  return (SOURCE_PRIORITY[b.source_type] ?? 0) - (SOURCE_PRIORITY[a.source_type] ?? 0);
}
