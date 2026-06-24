// Contradiction scan — daily batch (03:30 UTC via croner, when spine ships).
// Detect-and-record ONLY: writes to scan_verdicts, zero mutations to L2 facts.
// Fact mutations (confidence decay, supersession zeroing) live in apply-verdicts.
//
// Pipeline:
//   1. Select recent L2 facts (created in last scan_window_hours)
//   2. Pre-filter: BM25(FTS5) + entity-overlap (alias-resolved, )
//      + not-already-linked (no existing scan_verdict for this pair)
//   3. Sonnet judge classifies: CONTRADICTION | SUPERSESSION | UNRELATED
//      Prompt includes source_type of both facts ()
//   4. policy: if losing fact is user_authored AND winning is
//      tool_result_external → pending=1 (route to owner approval)

import { ulid } from '../utils/lexical.mjs';
import { buildAliasMap, parseEntities, entityOverlap } from '../graph/entities.mjs';
import { CONTRADICTION_JUDGE, HASHES } from './prompts.mjs';
import { parseJsonLoose } from '../utils/json.mjs';

export const DEFAULT_KNOBS = Object.freeze({
  scan_window_hours: 24,
  bm25_candidate_limit: 10,     // top-K BM25 matches per new fact
  min_entity_overlap: 1,        // : ≥1 shared entity after alias resolution
  batch_size: 20,               // max pairs per judge call (keeps prompt manageable)
  judge_model: 'claude-sonnet-4-6',  // : most irreversible → sonnet
});

// Pre-filter: for each new fact, find candidate existing facts via BM25 + entity overlap.
function findCandidates(db, newFact, aliasMap, knobs, alreadyScanned) {
  const newEntities = parseEntities(newFact.entities, aliasMap);
  if (newEntities.size === 0) return [];

  // BM25 search against existing facts (excluding the new fact itself)
  // Sanitize for FTS5: strip non-word chars, filter reserved words and short tokens.
  const FTS_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const ftsTokens = newFact.fact_text.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30 && !FTS_RESERVED.has(t.toUpperCase()))
    .slice(0, 10);
  if (ftsTokens.length === 0) return [];
  const ftsQuery = ftsTokens.join(' OR ');

  let bm25Rows;
  try {
    bm25Rows = db.prepare(`
      SELECT l2.rowid, l2.id, l2.fact_text, l2.entities, l2.source_type, l2.confidence,
             l2.created_at, datetime(l2.created_at/1000, 'unixepoch') AS created_at_iso
      FROM l2_fts fts
      JOIN l2_semantic l2 ON l2.rowid = fts.rowid
      WHERE l2_fts MATCH ? AND l2.id != ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, newFact.id, knobs.bm25_candidate_limit);
  } catch {
    return []; // FTS edge case — skip this fact (conservative)
  }

  const candidates = [];
  for (const row of bm25Rows) {
    const pairKey = [newFact.id, row.id].sort().join('|');
    if (alreadyScanned.has(pairKey)) continue;

    const existingEntities = parseEntities(row.entities, aliasMap);
    const overlap = entityOverlap(newEntities, existingEntities);
    if (overlap < knobs.min_entity_overlap) continue;

    candidates.push({
      existing: row,
      overlap,
    });
  }
  return candidates;
}

// : check if this verdict needs owner approval.
function needsPending(verdict, factA, factB) {
  if (verdict === 'UNRELATED') return false;
  // The "losing" fact: for CONTRADICTION both are hit, but the older (factA) loses confidence.
  // For SUPERSESSION the older (factA) is zeroed.
  // : losing=user_authored AND winning=tool_result_external → pending
  if (factA.source_type === 'user_authored' && factB.source_type === 'tool_result_external') return true;
  return false;
}

export async function runScan(db, client, knobs = DEFAULT_KNOBS, { log = console.log } = {}) {
  const aliasMap = buildAliasMap(db);
  const cutoff = Date.now() - knobs.scan_window_hours * 3600_000;

  const newFacts = db.prepare(`
    SELECT id, fact_text, entities, source_type, confidence, created_at,
           datetime(created_at/1000, 'unixepoch') AS created_at_iso
    FROM l2_semantic
    WHERE created_at > ?
    ORDER BY created_at
  `).all(cutoff);

  if (newFacts.length === 0) {
    log('contradiction scan: no new facts in window');
    return { pairs: 0, verdicts: {} };
  }
  log(`contradiction scan: ${newFacts.length} new facts in last ${knobs.scan_window_hours}h`);

  // Build set of already-scanned pairs
  const alreadyScanned = new Set();
  const existingVerdicts = db.prepare('SELECT fact_a, fact_b FROM scan_verdicts').all();
  for (const v of existingVerdicts) alreadyScanned.add([v.fact_a, v.fact_b].sort().join('|'));

  // Collect candidate pairs
  const pairs = [];
  for (const nf of newFacts) {
    for (const cand of findCandidates(db, nf, aliasMap, knobs, alreadyScanned)) {
      const pairKey = [nf.id, cand.existing.id].sort().join('|');
      alreadyScanned.add(pairKey); // dedupe within this scan
      pairs.push({
        factA: { id: cand.existing.id, fact_text: cand.existing.fact_text, source_type: cand.existing.source_type, created_at: cand.existing.created_at_iso },
        factB: { id: nf.id, fact_text: nf.fact_text, source_type: nf.source_type, created_at: nf.created_at_iso },
        overlap: cand.overlap,
      });
    }
  }

  if (pairs.length === 0) {
    log('contradiction scan: no candidate pairs after pre-filter');
    return { pairs: 0, verdicts: {} };
  }
  log(`  ${pairs.length} candidate pairs after pre-filter`);

  // Batch judge calls
  const insertVerdict = db.prepare(`
    INSERT INTO scan_verdicts (id, scanned_at, fact_a, fact_b, verdict, pending, prompt_hash, judge_model_id, knob_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const counts = { CONTRADICTION: 0, SUPERSESSION: 0, UNRELATED: 0, pending: 0 };
  const knobJson = JSON.stringify({ ...knobs, prompt_hash: HASHES.CONTRADICTION_JUDGE });

  for (let i = 0; i < pairs.length; i += knobs.batch_size) {
    const batch = pairs.slice(i, i + knobs.batch_size);
    const items = batch.map((p, idx) => ({
      pair_id: idx,
      fact_a: { fact_text: p.factA.fact_text, source_type: p.factA.source_type, created_at: p.factA.created_at, role: 'older' },
      fact_b: { fact_text: p.factB.fact_text, source_type: p.factB.source_type, created_at: p.factB.created_at, role: 'newer' },
    }));

    // Use judge() if available, fall back to chat()
    const chatFn = client.judge ?? client.chat;
    const { text } = await chatFn({
      model: knobs.judge_model,
      user: CONTRADICTION_JUDGE + '\n\nPAIRS:\n' + JSON.stringify(items),
      maxTokens: 2000,
    });

    const results = parseJsonLoose(text);
    for (const r of (Array.isArray(results) ? results : [])) {
      const idx = r.pair_id;
      if (idx == null || idx >= batch.length) continue;
      const verdict = r.verdict;
      if (!['CONTRADICTION', 'SUPERSESSION', 'UNRELATED'].includes(verdict)) continue;

      const p = batch[idx];
      const pending = needsPending(verdict, p.factA, p.factB) ? 1 : 0;
      if (pending) counts.pending++;
      counts[verdict]++;

      insertVerdict.run(
        ulid('ver'), Date.now(), p.factA.id, p.factB.id, verdict, pending,
        HASHES.CONTRADICTION_JUDGE, knobs.judge_model, knobJson,
      );
    }
    log(`  batch ${Math.floor(i / knobs.batch_size) + 1}: ${batch.length} pairs judged`);
  }

  log(`  verdicts: ${JSON.stringify(counts)}`);
  return { pairs: pairs.length, verdicts: counts };
}
