// KG-triple → L2 direct promotion (no LLM, no episodic summarization).
// KG triples are already semantic: "X uses Y", "A is part of B".
// Bypasses L1 (correct: they're not episodes), NOT trust hierarchy.
//
// Guards:
//   - Confidence capped at 0.4 (agent_internal = lowest trust)
//   - dedup (BM25 + entity overlap) — same as l1→l2
//   - Conservative default: skip on FTS crash, don't insert unchecked
//   - Graph update: add entity nodes + edges
//
// False positive filter: only records with source mcp-memory OR length >20.
// Short workspace-md fragments (<20 chars) are truncated md, not real triples.

import { prepareL2 } from '../storage/l2.mjs';
import { parseEntities, entityOverlap, buildAliasMap, canonEntity } from '../graph/entities.mjs';
import { GraphStore } from '../graph/store.mjs';
import { sha16 } from '../utils/lexical.mjs';

const CONFIDENCE_CAPS = {
  agent_internal: 0.4,
  user_authored: 0.7,
  tool_result: 0.7,
  tool_result_external: 0.5,
};

const ENTITY_PATTERNS = [
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,
  /\b[A-Z][A-Z0-9_]{2,}\b/g,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g,
  /:\d{4,5}\b/g,
  /\b[\w.-]+\.(?:mjs|js|py|md|db|json|yaml|toml|service)\b/gi,
];
const STOP_CAPS = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'BUT', 'ARE', 'WAS', 'HAS', 'NEW', 'ALL', 'SET',
  'API', 'URL', 'HTTP', 'HTTPS', 'JSON', 'HTML', 'CSS', 'SQL', 'GET', 'POST',
  'PUT', 'DELETE', 'NULL', 'TRUE', 'FALSE', 'UTC', 'GMT', 'PID', 'DOM', 'XHR',
  'HEARTBEAT', 'NONE', 'TODO', 'NOTE', 'YES',
]);

function extractEntities(text) {
  const found = new Set();
  for (const re of ENTITY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const e = m[0].trim();
      if (e.length >= 2 && e.length <= 40 && !STOP_CAPS.has(e)) found.add(e);
    }
  }
  return [...found];
}

function findDuplicate(db, factText, entities, aliasMap) {
  const FTS_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const tokens = factText.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30 && !FTS_RESERVED.has(t.toUpperCase()))
    .slice(0, 8);
  if (tokens.length === 0) return null;
  const ftsQuery = tokens.join(' OR ');

  let candidates;
  try {
    candidates = db.prepare(`
      SELECT l2.* FROM l2_fts fts
      JOIN l2_semantic l2 ON l2.rowid = fts.rowid
      WHERE l2_fts MATCH ?
      ORDER BY rank LIMIT 5
    `).all(ftsQuery);
  } catch {
    return 'FTS_ERROR';
  }

  const factEntities = parseEntities(JSON.stringify(entities), aliasMap);
  for (const c of candidates) {
    const cEntities = parseEntities(c.entities, aliasMap);
    if (entityOverlap(factEntities, cEntities) >= 1) return c;
  }
  return null;
}

export async function runKgToL2(db, { graph = null, limit = Infinity, log = console.log } = {}) {
  const l2 = prepareL2(db);
  const aliasMap = buildAliasMap(db);
  const _graph = graph ?? new GraphStore(db);
  if (!graph) _graph.load();

  const records = db.prepare(`
    SELECT * FROM l0_raw
    WHERE consolidated_to = 'skip:kg-triple'
    ORDER BY ts
    ${limit < Infinity ? `LIMIT ${limit}` : ''}
  `).all();

  if (records.length === 0) {
    log('kg→l2: no KG triples to promote');
    return { total: 0, promoted: 0, dups: 0, fts_skip: 0, filtered: 0 };
  }
  log(`kg→l2: ${records.length} KG triples to process`);

  const markPromoted = db.prepare("UPDATE l0_raw SET consolidated_to=? WHERE id=?");
  let promoted = 0, dups = 0, ftsSkip = 0, filtered = 0;

  for (const r of records) {
    // False positive filter: skip short workspace-md fragments
    if (r.session && !r.session.startsWith('import:mcp-memory') && r.content.length <= 20) {
      filtered++;
      markPromoted.run('skip:kg-false-positive', r.id);
      continue;
    }

    const entities = extractEntities(r.content);
    const factText = r.content.trim();
    if (factText.length < 5) { filtered++; continue; }

    // dedup
    const dup = findDuplicate(db, factText, entities, aliasMap);
    if (dup === 'FTS_ERROR') {
      ftsSkip++;
      log(`  dedup-skip (FTS): "${factText.slice(0, 60)}"`);
      continue;
    }
    if (dup) {
      dups++;
      markPromoted.run(`dup:${dup.id}`, r.id);
      continue;
    }

    // Confidence cap by source_type
    const maxConf = CONFIDENCE_CAPS[r.source_type] ?? 0.4;

    const { id: factId } = l2.insert({
      fact_text: factText,
      entities,
      confidence: maxConf,
      source_type: r.source_type ?? 'agent_internal',
      source_l1_ids: [],
      source_l0_sample: [r.id],
      prompt_hash: sha16('kg-direct-v1'),
      judge_model_id: 'none',
      scope: 'shared',
      source_agent: r.agent,
    });
    promoted++;

    // Graph update
    const nodeIds = [];
    for (const e of entities) {
      const label = String(e).slice(0, 50);
      if (label.length < 2) continue;
      const nodeId = 'node_' + canonEntity(label).replace(/\s+/g, '_');
      if (!_graph.getNode(nodeId)) _graph.addNode(nodeId, { label, type: 'concept' });
      nodeIds.push(nodeId);
    }
    if (nodeIds[0]) {
      const node = _graph.getNode(nodeIds[0]);
      if (node) {
        const linked = node.linked_facts ? JSON.parse(node.linked_facts) : [];
        if (!linked.includes(factId)) {
          linked.push(factId);
          db.prepare('UPDATE graph_nodes SET linked_facts=? WHERE id=?')
            .run(JSON.stringify(linked), nodeIds[0]);
        }
      }
    }
    for (let i = 0; i < nodeIds.length && i < 3; i++) {
      for (let j = i + 1; j < nodeIds.length && j < i + 3; j++) {
        _graph.addEdge(nodeIds[i], nodeIds[j], 'co-occurs');
      }
    }

    markPromoted.run(factId, r.id);
  }

  log(`kg→l2: ${promoted} promoted, ${dups} dups, ${ftsSkip} FTS-skipped, ${filtered} filtered`);
  return { total: records.length, promoted, dups, fts_skip: ftsSkip, filtered };
}
