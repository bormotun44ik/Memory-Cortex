// C2 — Prioritized replay in dreaming.
// Priority = salience × (1 − utilization). E3 NOT in formula (C2).
// Reorders session L1 summaries, never filters. Safe degradation to status quo.

export function prioritizeForDreaming(l1Records, db) {
  return l1Records.map((r) => {
    const salience = r.salience ?? 0.5;
    // Get average utilization of facts from this L1's sources
    let utilization = 0;
    if (r.source_l0_ids) {
      try {
        const l0Ids = JSON.parse(r.source_l0_ids);
        // Rough proxy: check if any L2 facts from same session have been utilized
        const sessionFacts = db.prepare(
          "SELECT avg(CAST(used_count AS REAL) / max(injected_count, 1)) u FROM l2_semantic WHERE source_l1_ids LIKE ? AND injected_count > 0"
        ).get(`%${r.id}%`);
        utilization = sessionFacts?.u ?? 0;
      } catch {}
    }
    return { ...r, _priority: salience * (1 - utilization) };
  }).sort((a, b) => b._priority - a._priority);
}
