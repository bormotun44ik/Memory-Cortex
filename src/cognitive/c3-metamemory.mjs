// C3 — Metamemory signal.
// On total seed miss + low-confidence (<0.3) coverage → inject warning:
// "no/low coverage on this topic — verify independently" (~15 tok).
// Kill-gate: confab rate not falling after 4 weeks → kill.
// Behind flag (METAMEMORY_ENABLED env).

const WARNING = '[Memory: low/no coverage on this topic — verify independently]';

export function checkMetamemory(searchResult) {
  if (!searchResult) return null;
  // Total seed miss: 0 activated nodes (fallback only)
  if (searchResult.activated_nodes === 0) return WARNING;
  // Low confidence coverage: all facts below 0.3
  if (searchResult.facts.every((f) => f.confidence < 0.3)) return WARNING;
  return null;
}
