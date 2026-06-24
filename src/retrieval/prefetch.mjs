// Push retrieval — called before each agent turn.
// zero-LLM hot path: zero LLM / zero network / zero embeddings. Budget 5-15ms.
// Uses shared graphSearch (gateMode='fast') + slots + budget-aware assembly.

import { graphSearch } from './search.mjs';
import { buildAliasMap, canonEntity } from '../graph/entities.mjs';
import { estTokens } from '../utils/lexical.mjs';
import { checkMetamemory } from '../cognitive/c3-metamemory.mjs';
import { partitionFacts, formatWarmStubs, resetRefMap } from '../cognitive/r1-page-fault.mjs';
import { checkBookmarks } from '../cognitive/r3-bookmarks.mjs';

const INJECT_BUDGET_DEFAULT = 500;
const L3_BUDGET = 2000;

function assembleFacts(facts, budget) {
  const result = [];
  let remaining = budget;
  for (const f of facts) {
    const tok = estTokens(f.fact_text);
    if (tok > remaining) {
      if (remaining > 20) {
        const arts = f.key_artifacts ? JSON.parse(f.key_artifacts).join(', ') : f.fact_text.slice(0, 80);
        result.push({ id: f.id, text: arts, mode: 'stub', confidence: f.confidence });
        remaining -= estTokens(arts);
      }
      break;
    }
    const annotation = f.injectionStatus === 'annotate' ? ' [low confidence]' : '';
    result.push({ id: f.id, text: f.fact_text + annotation, mode: 'full', confidence: f.confidence });
    remaining -= tok;
  }
  return result;
}

export function prefetch(db, graph, {
  agent,
  lastMessages,
  contextRemaining = 100_000,
  aliasMap = null,
  labelIndex = null,
} = {}) {
  const queryText = (Array.isArray(lastMessages) ? lastMessages : [lastMessages ?? '']).join(' ');

  // Graph retrieval (fast gate — hot path)
  const searchResult = graphSearch(db, graph, {
    query: queryText,
    agent,
    gateMode: 'fast',
    limit: 20,
    aliasMap,
    labelIndex,
  });

  // Slot injection — all non-expired slots for this agent (pinned, always visible)
  const slots = [];
  const allSlots = db.prepare("SELECT key, value, updated_at FROM slots WHERE agent=?").all(agent);
  for (const s of allSlots) {
    try { slots.push({ key: s.key, value: JSON.parse(s.value), updated_at: s.updated_at }); } catch {}
  }

  // L3 rules injection — relevance filter + budget (per architecture L3 section)
  let rules = [];
  try {
    const allRules = db.prepare(
      "SELECT * FROM l3_rules WHERE pending=0 AND (agent=? OR agent='all') ORDER BY access_count * confidence DESC",
    ).all(agent);
    if (allRules.length > 0) {
      const queryEntities = new Set(
        queryText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((w) => w.length >= 3).map((w) => canonEntity(w)),
      );
      let ruleBudget = L3_BUDGET;
      for (const r of allRules) {
        const ruleEntities = r.entities ? JSON.parse(r.entities) : [];
        const overlap = allRules.length <= 50 || ruleEntities.some((e) => queryEntities.has(canonEntity(e)));
        if (!overlap && allRules.length > 50) continue;
        const tok = estTokens(r.text);
        if (tok > ruleBudget) break;
        rules.push({ id: r.id, text: r.text, confidence: r.confidence });
        ruleBudget -= tok;
      }
    }
  } catch (e) { console.error('L3 inject error:', e.message?.slice(0, 100)); }

  // R3 bookmarks: check for triggered bookmarks
  let bookmarkedIds = [];
  try {
    const queryEntities = new Set(
      queryText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((w) => w.length >= 3).map((w) => canonEntity(w)),
    );
    bookmarkedIds = checkBookmarks(db, { agent, queryEntities });
  } catch { /* bookmarks table may not exist */ }

  // R1 page-fault: three-class injection (HOT full / WARM stubs / COLD none)
  resetRefMap();
  const { hot, warm } = partitionFacts(searchResult.facts);

  // HOT: full facts within budget
  const budget = Math.min(INJECT_BUDGET_DEFAULT, Math.round(contextRemaining * 0.02));
  const assembled = assembleFacts(hot, budget);

  // WARM: one-line stubs with ref_N aliases
  const warmStubs = formatWarmStubs(warm);

  const touchIds = [...assembled.map((f) => f.id), ...warmStubs.map((s) => s.factId)];

  // C3 metamemory: warn on low/no coverage
  const metamemoryWarning = process.env.METAMEMORY_ENABLED === 'true' ? checkMetamemory(searchResult) : null;

  return {
    rules,
    facts: assembled,
    warm_stubs: warmStubs.length > 0 ? warmStubs.map((s) => s.text) : undefined,
    warm_delimiter: warmStubs.length > 0 ? '--- retrievable stubs below ---' : undefined,
    metamemory: metamemoryWarning,
    slots,
    elapsed_ms: searchResult.elapsed_ms,
    entity_count: searchResult.entity_count,
    activated_nodes: searchResult.activated_nodes,
    fallback_used: searchResult.fallback_used,
    touchIds,
  };
}
