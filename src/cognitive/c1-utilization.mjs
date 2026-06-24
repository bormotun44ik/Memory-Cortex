// C1 — Detail-utilization metric (Phase 2a ruler).
// Measures: did the agent USE what was injected?
// Proxy = specific-detail overlap (numbers/paths/ports/commands from key_artifacts
// in the response), NOT entity-name overlap (inflation).
// OBSERVATIONAL-ONLY in 2a: counts only, does NOT influence retrieval.
// +2 counters: injected_count, used_count per L2 fact (~0.4ms UPDATE).

import { extractArtifacts } from '../utils/lexical.mjs';

export function measureUtilization(db, { injectedFacts, responseText, log = () => {} } = {}) {
  if (!injectedFacts?.length || !responseText) return { injected: 0, used: 0 };

  const responseLower = responseText.toLowerCase();
  const incrInjected = db.prepare('UPDATE l2_semantic SET injected_count = injected_count + 1 WHERE id = ?');
  const incrUsed = db.prepare('UPDATE l2_semantic SET used_count = used_count + 1 WHERE id = ?');

  let injected = 0, used = 0;

  for (const fact of injectedFacts) {
    const factText = fact.text || fact.fact_text || '';
    if (!factText) continue;

    incrInjected.run(fact.id);
    injected++;

    // Extract specific details (numbers, paths, ports, commands) from the fact
    const artifacts = extractArtifacts(factText, 5);
    if (artifacts.length === 0) continue;

    // Check if ANY specific detail appears in the response
    let found = false;
    for (const art of artifacts) {
      const artLower = art.toLowerCase();
      if (artLower.length >= 3 && responseLower.includes(artLower)) {
        found = true;
        break;
      }
    }

    if (found) {
      incrUsed.run(fact.id);
      used++;
    }
  }

  log(`c1: ${used}/${injected} facts utilized`);
  return { injected, used, rate: injected > 0 ? used / injected : 0 };
}

// Aggregate utilization stats for reporting
export function getUtilizationStats(db) {
  const total = db.prepare('SELECT count(*) c FROM l2_semantic WHERE injected_count > 0').get().c;
  const utilized = db.prepare('SELECT count(*) c FROM l2_semantic WHERE used_count > 0').get().c;
  const avgRate = db.prepare(
    'SELECT avg(CAST(used_count AS REAL) / max(injected_count, 1)) as r FROM l2_semantic WHERE injected_count > 0'
  ).get()?.r ?? 0;
  return { total_injected_facts: total, utilized_facts: utilized, avg_utilization: Math.round(avgRate * 100) / 100 };
}
