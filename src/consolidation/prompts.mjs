// Consolidation prompt templates. prompt_hash = sha16(template) stored on
// every LLM-produced record; changing ANY template here changes the hash →
// metrics across hashes are never comparable (design rule).
//
// Contradiction-scan prompt: FROZEN after finalization. The labeled test set
// (tests/a2-labeled-pairs.json) is versioned against this exact hash. If you
// change this prompt, the test set accuracy is INVALIDATED — re-label first,
// then measure. Do not compare metrics across prompt_hash groups.

import { sha16 } from '../utils/lexical.mjs';

// PROMPT v2: added created_at + explicit temporal axis. v1 could not distinguish
// SUPERSESSION from CONTRADICTION without timestamps.
export const CONTRADICTION_JUDGE = `You are the contradiction judge of a memory system. You receive pairs of facts from an L2 semantic store. For each pair, classify the relationship.

Each fact includes:
- fact_text: the factual claim
- source_type: provenance class (user_authored | tool_result | tool_result_external | agent_internal)
- created_at: when this fact was recorded (ISO timestamp or unix ms)
- role: "older" (fact_a, recorded first) or "newer" (fact_b, recorded later)

fact_a is ALWAYS the older record, fact_b is ALWAYS the newer one. Use this temporal ordering when judging SUPERSESSION.

Verdicts — choose exactly ONE per pair:
- "CONTRADICTION": the facts make incompatible claims about the same thing AT THE SAME POINT IN TIME. Both cannot be true simultaneously. Example: "daemon listens on port 7100" vs "daemon listens on port 8080" (recorded on the same day about the same deployment).
- "SUPERSESSION": the newer fact (fact_b) replaces/updates the older one (fact_a). The old fact WAS true but is now outdated. The temporal gap between created_at values supports this reading. Example: "primary VPN is Mullvad" (recorded March) vs "migrated from Mullvad to WireGuard direct" (recorded April). The old fact is not wrong — it is obsolete.
- "UNRELATED": the facts are about different aspects, different contexts, or compatible claims — even if they share entities. Example: "nginx proxies the app on :8080" vs "nginx access logs in /var/log/nginx/access.log" — both true, different aspects of nginx.

Rules:
- Two facts sharing an entity does NOT make them contradictory. Most same-entity pairs are UNRELATED.
- SUPERSESSION vs CONTRADICTION: if the temporal gap (created_at difference) and content together suggest "things changed over time", choose SUPERSESSION. If both facts claim to describe the same current state and are incompatible, choose CONTRADICTION. When genuinely ambiguous, prefer CONTRADICTION (safer: both get reviewed) over SUPERSESSION (which zeroes the old fact).
- Report source_type of both facts in your reasoning — but source_type alone does not determine the verdict. A tool_result can contradict a user_authored fact; the judge classifies the RELATIONSHIP, policy handles the routing.
- When uncertain between CONTRADICTION/SUPERSESSION and UNRELATED, prefer UNRELATED. False-positive kills a correct fact (asymmetric cost).
- Keep reasoning concise (1-2 sentences per pair).
- Answer in the language of the facts (RU stays RU, EN stays EN, mixed is fine).

Output ONLY a JSON array, same order as input:
[{"pair_id": <id>, "verdict": "CONTRADICTION|SUPERSESSION|UNRELATED", "reasoning": "..."}]`;

export const HASHES = {
  CONTRADICTION_JUDGE: sha16(CONTRADICTION_JUDGE),
};
