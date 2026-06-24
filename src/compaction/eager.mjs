// Eager-path wiring: preemptive L0→L1 trigger when context ratio > threshold.
// Called by sync_turn (Hermes plugin) on each turn to check if summaries should
// be generated BEFORE the compaction threshold hits.
//
// Spec (doc lines 510-511): if ratio > 0.45, trigger eager L0→L1 for current
// session (async). Have summaries ready before 0.50 hits.
//
// This module is the TRIGGER only — the actual L0→L1 consolidation is in
// consolidation/l0-to-l1.mjs (not yet built, spine dependency). Eager schedules
// it, doesn't implement it.

export const EAGER_DEFAULTS = Object.freeze({
  eagerRatio: 0.45,     // trigger eager L0→L1
  compactRatio: 0.50,   // trigger compaction (Knob Triage: collapsed to one threshold)
});

// Returns action to take based on current context ratio.
// ratio = context_used / context_limit (0-1).
export function checkEagerTrigger(ratio, { sessionHasL1 = false, eagerPending = false } = {}) {
  if (ratio > EAGER_DEFAULTS.compactRatio) {
    return {
      action: 'compact',
      reason: `ratio ${ratio.toFixed(3)} > ${EAGER_DEFAULTS.compactRatio}`,
      needsL1: !sessionHasL1,
    };
  }
  if (ratio > EAGER_DEFAULTS.eagerRatio && !sessionHasL1 && !eagerPending) {
    return {
      action: 'eager_l0_to_l1',
      reason: `ratio ${ratio.toFixed(3)} > ${EAGER_DEFAULTS.eagerRatio}, no L1 yet`,
    };
  }
  return { action: 'none' };
}
