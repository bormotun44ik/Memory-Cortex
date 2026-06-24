// Fallback search: BM25(FTS5) + entity overlap. No cosine/embeddings ().
// Used when graph activation finds nothing (Step 7 in doc).
// Replaces the cosine_similarity + bm25 + entity_overlap fusion from the
// pre-).

import { parseEntities, entityOverlap, canonEntity } from '../graph/entities.mjs';

export function fallbackSearch(db, query, aliasMap, { agent, limit = 5 } = {}) {
  const safe = query.replace(/['"*?^{}():\-+<>~|@#!]/g, ' ').trim();
  if (!safe) return [];

  // FTS5 defaults to AND — use OR to handle mixed-language queries where
  // stopwords/conversational tokens don't appear in facts.
  const tokens = safe.split(/\s+/).filter((t) => t.length >= 2);
  // Expand tokens through alias dictionary: "порт" → also search "port",
  // "бэкап" → "backup", etc. Doubles coverage for bilingual corpus.
  const expanded = new Set();
  for (const t of tokens) {
    expanded.add(t);
    const canon = canonEntity(t);
    if (canon !== t.toLowerCase()) expanded.add(canon);
  }
  const ftsQuery = [...expanded].join(' OR ');
  if (!ftsQuery) return [];

  const bm25Rows = db.prepare(`
    SELECT l2.*, rank as bm25_rank FROM l2_fts fts
    JOIN l2_semantic l2 ON l2.rowid = fts.rowid
    WHERE l2_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(ftsQuery, limit * 3);

  const queryTokens = tokens.map((t) => canonEntity(t));
  const queryEntities = new Set(queryTokens.filter((t) => t.length >= 2));

  // Score: BM25 primary (0.7), entity overlap boost (0.3).
  // KG-triples often have few/no entities — pure entity scoring misses them.
  const scored = bm25Rows.map((row) => {
    const factEntities = parseEntities(row.entities, aliasMap);
    const overlap = entityOverlap(queryEntities, factEntities);
    const bm25Norm = row.bm25_rank ? 1 / (1 - row.bm25_rank) : 0; // rank is negative in FTS5
    const overlapNorm = queryEntities.size > 0 ? overlap / queryEntities.size : 0;
    return {
      ...row,
      score: 0.7 * Math.min(bm25Norm, 1) + 0.3 * overlapNorm,
    };
  });

  // Guarantee top BM25 results survive scoring — KG-triples with numeric-only
  // entities (port numbers, IPs) have zero entity overlap but high BM25 relevance.
  // Top 3 by BM25 rank get a floor score so they're never buried.
  const byRank = [...scored].sort((a, b) => (a.bm25_rank ?? 0) - (b.bm25_rank ?? 0));
  for (let i = 0; i < Math.min(3, byRank.length); i++) {
    if (byRank[i].score < 0.3) byRank[i].score = 0.3;
  }

  // Filter by scope if agent specified
  const filtered = agent
    ? scored.filter((r) => r.scope === 'shared' || r.scope === `agent:${agent}`)
    : scored;

  return filtered.sort((a, b) => b.score - a.score).slice(0, limit);
}
