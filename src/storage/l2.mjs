// L2 semantic fact storage — permanent until contradicted, versioned.
// Hard length caps on fact_text and key_artifacts before storage (length cap,
// ).

import { ulid } from '../utils/lexical.mjs';
import { canonEntity, extractEntitiesFromText } from '../graph/entities.mjs';

const VALID_SOURCE = new Set(['user_authored', 'tool_result', 'tool_result_external', 'agent_internal']);

const MAX_FACT_TEXT_CHARS = 2000;
const MAX_ENTITIES = 20;

function capText(s, max) {
  if (typeof s !== 'string' || s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

export function prepareL2(db, graph = null) {
  const insert = db.prepare(`
    INSERT INTO l2_semantic
      (id, fact_text, entities, confidence, source_type, bypass_recurrence,
       prompt_hash, judge_model_id, version, source_l1_ids, source_l0_sample,
       scope, source_agent, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getById = db.prepare('SELECT * FROM l2_semantic WHERE id=?');
  const updateConfidence = db.prepare('UPDATE l2_semantic SET confidence=?, updated_at=? WHERE id=?');
  const updateAccess = db.prepare(
    'UPDATE l2_semantic SET access_count=access_count+1, last_accessed=? WHERE id=?'
  );
  const search = db.prepare(`
    SELECT l2.*, rank FROM l2_fts fts
    JOIN l2_semantic l2 ON l2.rowid = fts.rowid
    WHERE l2_fts MATCH ?
    ORDER BY rank LIMIT ?
  `);
  const getByScope = db.prepare('SELECT * FROM l2_semantic WHERE scope=? AND confidence > 0.15 ORDER BY access_count DESC LIMIT ?');

  return {
    insert(fact) {
      const id = ulid('fact');
      const { text: factText, truncated: textTrunc } = capText(fact.fact_text, MAX_FACT_TEXT_CHARS);
      const sourceType = VALID_SOURCE.has(fact.source_type) ? fact.source_type : 'agent_internal';
      let entities = null;
      let entitiesTrunc = false;
      if (fact.entities) {
        const arr = Array.isArray(fact.entities) ? fact.entities : [];
        entitiesTrunc = arr.length > MAX_ENTITIES;
        entities = JSON.stringify(arr.slice(0, MAX_ENTITIES));
      }
      insert.run(id, factText, entities, fact.confidence ?? 0.7, sourceType,
        fact.bypass_recurrence ? 1 : 0,
        fact.prompt_hash ?? null, fact.judge_model_id ?? null,
        fact.version ?? 1,
        fact.source_l1_ids ? JSON.stringify(fact.source_l1_ids) : null,
        fact.source_l0_sample ? JSON.stringify(fact.source_l0_sample) : null,
        fact.scope ?? 'shared', fact.source_agent ?? null,
        fact.tags ? JSON.stringify(fact.tags) : null);
      // Auto-link to graph: create/update nodes for entities, link fact
      if (graph && entities) {
        try {
          const ents = JSON.parse(entities);
          for (const e of ents) {
            const canon = canonEntity(String(e));
            const nodeId = 'node_' + canon.replace(/\s+/g, '_').slice(0, 40);
            if (!graph.getNode(nodeId)) graph.addNode(nodeId, { label: canon, type: 'concept' });
            const node = graph.getNode(nodeId);
            if (node) {
              const lf = node.linked_facts ? JSON.parse(node.linked_facts) : [];
              if (!lf.includes(id)) {
                lf.push(id);
                db.prepare('UPDATE graph_nodes SET linked_facts=? WHERE id=?').run(JSON.stringify(lf), nodeId);
                node.linked_facts = JSON.stringify(lf);
              }
            }
          }
        } catch { /* graph link errors must not block L2 insert */ }
      }
      return { id, truncated: textTrunc || entitiesTrunc };
    },
    getById(id) { return getById.get(id); },
    updateConfidence(id, conf) { updateConfidence.run(conf, Date.now(), id); },
    touchAccess(id) { updateAccess.run(Date.now(), id); },
    search(query, limit = 10) {
      const safe = query.replace(/['"*?^{}():\-+<>~|@#!]/g, ' ');
      if (!safe.trim()) return [];
      return search.all(safe, limit);
    },
    getByScope(scope, limit = 50) { return getByScope.all(scope, limit); },
  };
}
