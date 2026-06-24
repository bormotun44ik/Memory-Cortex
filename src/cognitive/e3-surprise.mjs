// E3 — Surprise-at-consolidation (NOT at-write).
// Runs ONLY during L0→L1 consolidation (background).
// L1 vs L2 sharing entities: boost when entity-overlap AND cosine < 0.50.
// Boost = boolean salience_boosted, not a float. 0 new knobs.
// v0: no cosine (Inv 4) — entity-overlap only, cosine check deferred to .
// Behind flag: C1 must show boosted facts higher utilization before unflagging.

import { parseEntities, entityOverlap, buildAliasMap } from '../graph/entities.mjs';

export function checkSurprise(db, l1Record, { aliasMap } = {}) {
  aliasMap ??= buildAliasMap(db);
  const l1Entities = parseEntities(l1Record.entities, aliasMap);
  if (l1Entities.size === 0) return false;

  // Find L2 facts sharing entities
  const relatedL2 = db.prepare(
    "SELECT id, entities, fact_text FROM l2_semantic WHERE confidence > 0 LIMIT 100"
  ).all();

  for (const f of relatedL2) {
    const fEntities = parseEntities(f.entities, aliasMap);
    if (entityOverlap(l1Entities, fEntities) >= 2) {
      // Entity overlap exists — in v0 without cosine, this is the surprise signal.
      // (cosine < 0.50 would filter paraphrases at 0.60-0.85; without embeddings,
      // we accept entity-overlap alone — false positive rate higher but safe behind flag)
      return true;
    }
  }
  return false;
}

// Superseded: l0-to-l1 writes UPDATE directly.
function markSalienceBoosted(db, factId) {
  db.prepare('UPDATE l2_semantic SET salience_boosted = 1 WHERE id = ?').run(factId);
}
