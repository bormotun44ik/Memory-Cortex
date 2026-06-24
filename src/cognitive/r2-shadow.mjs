// R2 — Access-ranked confidence (SHADOW MODE per Inv 5 + N4).
// Deltas logged to shadow_confidence_delta, NEVER applied to real confidence.
// Ranking stays on static confidence until shadow ECE < 0.20 for 2 weeks.
// S1: on_correction hook. S3: exact entity match on key_artifacts. Abstain on ≥2 candidates.

import { ulid } from '../utils/lexical.mjs';

export function logShadowDelta(db, { factId, delta, signalType, artifactsMatched = [] }) {
  db.prepare(`INSERT INTO shadow_confidence_delta (fact_id, delta, signal_type, artifacts_matched)
    VALUES (?, ?, ?, ?)`).run(factId, delta, signalType, JSON.stringify(artifactsMatched));
}

// S3: access-ranked — fact was injected AND used → small positive delta
export function onFactUtilized(db, factId) {
  logShadowDelta(db, { factId, delta: 0.02, signalType: 'access_rank' });
}

// S3: injected but NOT used → small negative
export function onFactIgnored(db, factId) {
  logShadowDelta(db, { factId, delta: -0.01, signalType: 'access_rank' });
}

// S1: explicit correction by agent/user
export function onCorrection(db, { factId, delta, artifacts }) {
  logShadowDelta(db, { factId, delta, signalType: 'correction', artifactsMatched: artifacts });
}

// Compute hypothetical confidence for calibration shadow ECE
export function getHypotheticalConfidence(db, factId) {
  const base = db.prepare('SELECT confidence FROM l2_semantic WHERE id = ?').get(factId);
  if (!base) return null;
  const deltas = db.prepare('SELECT sum(delta) s FROM shadow_confidence_delta WHERE fact_id = ?').get(factId);
  return Math.max(0, Math.min(1, base.confidence + (deltas?.s ?? 0)));
}

export function getShadowStats(db) {
  return db.prepare(`SELECT count(*) total, count(DISTINCT fact_id) facts,
    sum(CASE WHEN delta > 0 THEN 1 ELSE 0 END) positive,
    sum(CASE WHEN delta < 0 THEN 1 ELSE 0 END) negative
    FROM shadow_confidence_delta`).get();
}
