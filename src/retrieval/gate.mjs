// Injection gate: confidence band + count-rule (gate + verdict application).
// Determines injection status for L2 facts into agent prefetch.
//
// Two independent gates, result = stricter of the two:
//   confidence band: >0.4 inject, 0.15-0.4 annotate, <=0.15 suppress
//   count-rule: distinct_sessions >=2 inject, ==1 annotate, 0 suppress
//     escape hatch : inject if ==1 AND max_salience >= 0.8
//     agent_internal excluded from count (self-confirmation cap)
//
// Status priority: suppress > annotate > inject (strictest wins).

export const CONFIDENCE_BANDS = Object.freeze({
  inject: 0.4,    // confidence > 0.4 → inject
  annotate: 0.15, // 0.15 < confidence <= 0.4 → annotate
  // <= 0.15 → suppress
});

export const COUNT_RULE = Object.freeze({
  inject: 2,
  salience_escape: 0.8,
});

const STATUS_RANK = { suppress: 0, annotate: 1, inject: 2 };
const strictest = (a, b) => STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;

export function confidenceStatus(confidence) {
  if (confidence > CONFIDENCE_BANDS.inject) return 'inject';
  if (confidence > CONFIDENCE_BANDS.annotate) return 'annotate';
  return 'suppress';
}

// distinct_sessions: count of unique sessions that contributed to this fact,
// EXCLUDING agent_internal source_type (self-confirmation cap).
export function countRuleStatus(distinctSessions, maxSalience = 0) {
  if (distinctSessions >= COUNT_RULE.inject) return 'inject';
  if (distinctSessions === 1) {
    if (maxSalience >= COUNT_RULE.salience_escape) return 'inject';
    return 'annotate';
  }
  return 'suppress';
}

// source_type: trusted sources (user_authored, tool_result) bypass count-rule suppress.
// Owner-authored content intentionally placed in L2 should not be blocked as "unconfirmed".
export function injectionStatus(confidence, distinctSessions, maxSalience = 0, sourceType = null) {
  const confStatus = confidenceStatus(confidence);
  let countStatus = countRuleStatus(distinctSessions, maxSalience);
  // Trusted source escape: user_authored/tool_result with 0 sessions → annotate (not suppress)
  if (countStatus === 'suppress' && (sourceType === 'user_authored' || sourceType === 'tool_result')) {
    countStatus = 'annotate';
  }
  return strictest(confStatus, countStatus);
}

// Additive decay: max(confidence - 0.2, 0.15) per contradiction.
// Replaces old multiplicative *= 0.5 which killed facts in 2 steps.
export function applyContradictionDecay(currentConfidence) {
  return Math.round(Math.max(currentConfidence - 0.2, 0.15) * 1000) / 1000;
}

// Dreaming auto-boost (Self-confirmation cap): caps at 0.7 if all source sessions
// are agent_internal; allows 0.85 only with >=1 non-agent_internal source.
export const DREAMING_CAPS = Object.freeze({
  selfOnly: 0.7,
  withExternal: 0.85,
});

export function dreamingMaxConfidence(hasNonAgentInternalSource) {
  return hasNonAgentInternalSource ? DREAMING_CAPS.withExternal : DREAMING_CAPS.selfOnly;
}
