// Spreading activation (BFS + max-norm per hop).
// Base spec  + STEAL D graft  resolved).
//
// Propagation term: score += current.score × w_eff × node.weight × HOP_DECAY
//   w_eff = max(0, (w - 0.4) / 0.6)  — STEAL D rescale, CLAMPED at 0
//     (decayed edges fade to zero, never reverse; original STEAL D goes negative
//     at w < 0.4, bites after ~11 days of decay — Fork (a) fix)
// Max-norm after each hop (divide all scores by max_score).
// Threshold 0.05 (base spec, not STEAL D's 0.5).
// HOP_DECAY 0.7 per hop.
// node.weight in propagation (STEAL D silently dropped this — regression).
// Source refs: docs/memory-cortex-architecture.md lines 256-265 (base spec),
//   lines 1116-1123 (STEAL D), lines 1255-1261 (Fork (a) resolution).

export const ACTIVATION_DEFAULTS = Object.freeze({
  maxHops: 3,
  threshold: 0.05,
  hopDecay: 0.7,
  agentBoostPct: 0.1,
  topK: 20,
});

// STEAL D rescale, clamped: decayed edges → 0, never negative.
export function wEff(w) {
  return Math.max(0, (w - 0.4) / 0.6);
}

// Spreading activation on an in-memory adjacency representation.
// nodes: Map<id, {weight, access_count, linked_facts, ...}>
// edges: Map<sourceId, [{target, weight, invalid_at}, ...]>
// seeds: [{id, score}]
export function activate(nodes, edges, seeds, agentId, opts = {}) {
  const { maxHops, threshold, hopDecay, agentBoostPct, topK } = { ...ACTIVATION_DEFAULTS, ...opts };

  const scores = new Map();
  for (const s of seeds) scores.set(s.id, s.score);

  for (let hop = 0; hop < maxHops; hop++) {
    const updates = new Map();
    for (const [nodeId, score] of scores) {
      if (score < threshold) continue;
      const nodeEdges = edges.get(nodeId);
      if (!nodeEdges) continue;
      for (const e of nodeEdges) {
        if (e.invalid_at != null) continue;
        const neighbor = nodes.get(e.target);
        if (!neighbor) continue;
        const delta = score * wEff(e.weight) * (neighbor.weight ?? 1.0) * hopDecay;
        if (delta < 1e-9) continue;
        updates.set(e.target, (updates.get(e.target) ?? (scores.get(e.target) ?? 0)) + delta);
      }
    }
    for (const [id, s] of updates) scores.set(id, s);

    // Max-norm: divide all by max to prevent hub domination
    let maxScore = 0;
    for (const s of scores.values()) if (s > maxScore) maxScore = s;
    if (maxScore > 0) {
      for (const [id, s] of scores) scores.set(id, s / maxScore);
    }
  }

  // Agent-specific access boost
  if (agentId) {
    const accessCounts = [];
    for (const [id] of scores) {
      const n = nodes.get(id);
      if (n?.access_count_by_agent) {
        try {
          const byAgent = JSON.parse(n.access_count_by_agent);
          accessCounts.push(byAgent[agentId] ?? 0);
        } catch { accessCounts.push(0); }
      } else { accessCounts.push(0); }
    }
    accessCounts.sort((a, b) => a - b);
    const median = accessCounts[Math.floor(accessCounts.length / 2)] ?? 0;
    for (const [id, score] of scores) {
      const n = nodes.get(id);
      try {
        const byAgent = JSON.parse(n?.access_count_by_agent ?? '{}');
        if ((byAgent[agentId] ?? 0) > median) {
          scores.set(id, score * (1 + agentBoostPct));
        }
      } catch { /* skip */ }
    }
  }

  // Collect above threshold, sorted descending
  const result = [];
  for (const [id, score] of scores) {
    if (score >= threshold) result.push({ id, score, node: nodes.get(id) });
  }
  result.sort((a, b) => b.score - a.score);
  return result.slice(0, topK);
}
