// Shared graph retrieval engine — used by both push (prefetch) and pull (cortex_query).
// Push (prefetch): gateMode='fast' — inline 0.15/0.4 thresholds, hot path.
// Pull (/mcp/query): gateMode='full' — count-rule from gate.mjs, not hot.
// One retrieval engine, two gate modes. Per-node diversity cap prevents hot nodes
// from flooding results.

import { canonEntity, buildAliasMap, detectTopics, extractEntitiesFromText } from '../graph/entities.mjs';
import { activate } from '../graph/activation.mjs';
import { injectionStatus } from './gate.mjs';
import { fallbackSearch } from './fallback.mjs';
import { provenanceTiebreak } from '../cognitive/e1-provenance.mjs';

const PER_NODE_CAP = 5;

// RU↔EN overlap dictionary — auto-generated from RU_EN_ALIASES at import time.
// Both directions: RU word matches EN fact_text, EN word matches RU query.
// New domains auto-covered when RU_EN_ALIASES is extended (single source of truth).
import { RU_EN_ALIASES } from '../graph/entities.mjs';
const OVERLAP_TRANSLATE = new Map();
for (const [ru, en] of RU_EN_ALIASES) {
  OVERLAP_TRANSLATE.set(ru, en);
  OVERLAP_TRANSLATE.set(en, ru);
}

let _cachedAliasMap = null;
let _cachedLabelIndex = null;
let _cacheGraph = null;

export function invalidateSearchCache() {
  _cachedAliasMap = null;
  _cachedLabelIndex = null;
  _cacheGraph = null;
}

function getCachedAliasMap(db) {
  if (!_cachedAliasMap) _cachedAliasMap = buildAliasMap(db);
  return _cachedAliasMap;
}

function getCachedLabelIndex(graph) {
  if (!_cachedLabelIndex || _cacheGraph !== graph) {
    const idx = new Map();
    for (const [id, node] of graph.nodes) idx.set(canonEntity(node.label), id);
    _cachedLabelIndex = idx;
    _cacheGraph = graph;
  }
  return _cachedLabelIndex;
}

function extractQueryEntities(text, aliasMap) {
  const entities = new Set();
  // Compound names first (multi-word: "Order Block", "Smart Money", "FibDiv")
  for (const e of extractEntitiesFromText(text)) {
    const canon = canonEntity(e);
    if (aliasMap.has(canon)) entities.add(aliasMap.get(canon));
    else if (canon.length >= 3) entities.add(canon);
  }
  // Single-word tokens (catch what compound extraction misses)
  const tokens = text.split(/[\s,.:;!?()[\]{}"'`]+/).filter((t) => t.length >= 2);
  for (const t of tokens) {
    const canon = canonEntity(t);
    if (aliasMap.has(canon)) entities.add(aliasMap.get(canon));
    else if (canon.length >= 3 && !entities.has(canon)) entities.add(canon);
  }
  for (const topic of detectTopics(text)) entities.add(canonEntity(topic));
  return entities;
}

export function graphSearch(db, graph, {
  query,
  agent,
  gateMode = 'fast',
  limit = 20,
  aliasMap = null,
  labelIndex = null,
} = {}) {
  const start = performance.now();
  aliasMap ??= getCachedAliasMap(db);
  const _labelIndex = labelIndex ?? getCachedLabelIndex(graph);

  // Step 1: entity extraction
  const queryEntities = extractQueryEntities(query, aliasMap);

  // Step 2: graph activation
  const seeds = [];
  for (const entity of queryEntities) {
    const nodeId = _labelIndex.get(entity);
    if (nodeId) seeds.push({ id: nodeId, score: 1.0 });
  }
  const activated = seeds.length > 0 ? activate(graph.nodes, graph.edges, seeds, agent) : [];
  const seedIds = new Set(seeds.map((s) => s.id));
  const SEED_RESERVED = 5;

  // Step 3: fact collection with per-node diversity cap (batch SQL)
  const seedFacts = [];
  const neighborFacts = [];
  const seenFacts = new Set();
  const nodeFactBatches = [];
  for (const node of activated) {
    if (!node.node?.linked_facts) continue;
    try {
      const nodeFacts = JSON.parse(node.node.linked_facts);
      nodeFactBatches.push({ nodeId: node.id, score: node.score, factIds: nodeFacts, isSeed: seedIds.has(node.id) });
    } catch { /* malformed linked_facts */ }
  }
  // Batch-load all unique fact IDs in one query
  const allFactIds = new Set();
  for (const b of nodeFactBatches) for (const fid of b.factIds) allFactIds.add(fid);
  const factCache = new Map();
  if (allFactIds.size > 0) {
    const ids = [...allFactIds];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM l2_semantic WHERE id IN (${placeholders}) AND confidence > 0`).all(...chunk);
      for (const r of rows) factCache.set(r.id, r);
    }
  }
  // Query words for intra-node relevance ranking (lexical overlap, no LLM — Inv 1/4)
  // Expand with RU↔EN translations so "вход" matches "entry" in EN fact_text
  const rawWords = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((w) => w.length >= 3);
  const queryWords = new Set(rawWords);
  for (const w of rawWords) {
    const tr = OVERLAP_TRANSLATE.get(w);
    if (tr) queryWords.add(tr);
  }

  // Apply per-node cap, route seed vs neighbor facts
  for (const batch of nodeFactBatches) {
    const candidates = [];
    for (const factId of batch.factIds) {
      if (seenFacts.has(factId)) continue;
      const fact = factCache.get(factId);
      if (!fact) continue;
      if (agent && fact.scope !== 'shared' && fact.scope !== `agent:${agent}`) continue;
      candidates.push(fact);
    }
    // Rank by confidence first; within same confidence, use query-word overlap
    // Optimize: only compute overlap for top confidence tier (avoids scanning all 100+ facts)
    if (candidates.length > PER_NODE_CAP) {
      const maxConf = candidates.reduce((m, f) => Math.max(m, f.confidence), 0);
      const topTier = candidates.filter((f) => f.confidence >= maxConf - 0.01);
      if (topTier.length > PER_NODE_CAP) {
        // All same confidence — rank by overlap within this tier
        for (const f of topTier) {
          const words = (f.fact_text || '').toLowerCase().split(/\s+/);
          f._qo = 0;
          for (const w of words) if (w.length >= 3 && queryWords.has(w)) f._qo++;
        }
        topTier.sort((a, b) => (b._qo - a._qo) || provenanceTiebreak(a, b));
        // Replace candidates with topTier-sorted + rest
        const topIds = new Set(topTier.map((f) => f.id));
        const rest = candidates.filter((f) => !topIds.has(f.id));
        candidates.length = 0;
        candidates.push(...topTier, ...rest);
      } else {
        candidates.sort((a, b) => b.confidence - a.confidence);
      }
    }
    const target = batch.isSeed ? seedFacts : neighborFacts;
    for (const fact of candidates.slice(0, PER_NODE_CAP)) {
      seenFacts.add(fact.id);
      target.push({ ...fact, activationScore: batch.score });
    }
  }

  // Score: activation × confidence × recency
  const now = Date.now();
  const scoreFn = (f) => {
    const recency = f.last_accessed ? Math.max(0.5, 1 - (now - f.last_accessed) / (30 * 86400_000)) : 0.7;
    return { ...f, score: f.activationScore * f.confidence * recency };
  };
  const scoredSeed = seedFacts.map(scoreFn).sort((a, b) => b.score - a.score);
  const scoredNeighbor = neighborFacts.map(scoreFn).sort((a, b) => b.score - a.score);
  // Seed-pool: reserve first SEED_RESERVED slots for seed facts, fill rest with neighbors
  let facts = [...scoredSeed.slice(0, SEED_RESERVED), ...scoredNeighbor];
  const deduped = [];
  const usedIds = new Set();
  for (const f of facts) {
    if (usedIds.has(f.id)) continue;
    usedIds.add(f.id);
    deduped.push(f);
  }
  facts = deduped;

  // Gate: fast (inline thresholds) or full (count-rule from gate.mjs)
  if (gateMode === 'full') {
    // Limit candidates BEFORE count-rule SQL to bound cost
    facts = facts.slice(0, limit * 3);
    const countStmt = db.prepare(`
      SELECT COUNT(DISTINCT l1.session) as cnt FROM l1_episodic l1
      WHERE l1.id IN (SELECT value FROM json_each(?))
        AND l1.source_type != 'agent_internal'
    `);
    facts = facts.map((f) => {
      let distinctSessions = 0;
      if (f.source_l1_ids) {
        try { distinctSessions = countStmt.get(f.source_l1_ids)?.cnt ?? 0; } catch {}
      }
      return { ...f, injectionStatus: injectionStatus(f.confidence, distinctSessions, f.salience ?? 0, f.source_type) };
    });
  } else {
    facts = facts.map((f) => ({
      ...f,
      injectionStatus: f.confidence > 0.4 ? 'inject' : f.confidence > 0.15 ? 'annotate' : 'suppress',
    }));
  }
  facts = facts.filter((f) => f.injectionStatus !== 'suppress');

  // Step 7: hybrid BM25 merge
  if (query.trim()) {
    try {
      const fallbackResults = fallbackSearch(db, query, aliasMap, { agent, limit: 5 });
      const existingIds = new Set(facts.map((f) => f.id));
      for (const f of fallbackResults) {
        if (!existingIds.has(f.id) && f.confidence > 0.15) {
          facts.push({
            ...f,
            activationScore: 0,
            score: f.score,
            injectionStatus: f.confidence > 0.4 ? 'inject' : 'annotate',
          });
        }
      }
    } catch { /* FTS5 edge case */ }
  }

  const elapsed = performance.now() - start;

  return {
    facts: facts.slice(0, limit),
    elapsed_ms: Math.round(elapsed * 100) / 100,
    entity_count: queryEntities.size,
    activated_nodes: activated.length,
    fallback_used: facts.length > 0 && activated.length === 0,
  };
}
