// L1 episodic summary storage.
// schema_type routing: L0.type selects the structured JSON shape.
// source_type inherits LOWEST trust class from source L0 records ().

import { ulid, estTokens } from '../utils/lexical.mjs';

const VALID_SOURCE = new Set(['user_authored', 'tool_result', 'tool_result_external', 'agent_internal']);
// Trust order (HIGH→LOW): tool_result > user_authored > tool_result_external > agent_internal.
// "Lowest trust inheritance" = consolidated record gets the LEAST trusted source among its inputs.
// Index 0 = highest trust → lowestSourceType picks max index.
const TRUST_ORDER = ['tool_result', 'user_authored', 'tool_result_external', 'agent_internal'];

// schema_type determines structured JSON shape.
export const SCHEMA_TYPES = Object.freeze({
  task:   { fields: ['done', 'decided', 'remaining', 'key_artifacts'] },
  exchange: { fields: ['topic', 'user_intent', 'response_given', 'open_threads'] },
  system_event: { fields: ['status', 'anomalies', 'entities'] },
});

// Route L0.type → schema_type.
export function routeSchemaType(dominantL0Type) {
  if (dominantL0Type === 'tool_call' || dominantL0Type === 'tool_result') return 'task';
  if (dominantL0Type === 'system_event') return 'system_event';
  return 'exchange';
}

// Inherit LOWEST trust class from source L0 records ().
export function lowestSourceType(sourceTypes) {
  let lowest = 0;
  for (const st of sourceTypes) {
    const idx = TRUST_ORDER.indexOf(st);
    if (idx > lowest) lowest = idx;
  }
  return TRUST_ORDER[lowest] ?? 'agent_internal';
}

// Flatten structured summary to text for FTS.
export function flattenSummary(summary, schemaType) {
  const fields = SCHEMA_TYPES[schemaType]?.fields ?? SCHEMA_TYPES.task.fields;
  return fields.map((k) => {
    const v = summary[k];
    if (Array.isArray(v)) return `${k}: ${v.join('; ')}`;
    if (typeof v === 'string') return `${k}: ${v}`;
    if (v == null) return `${k}: `;
    return `${k}: ${JSON.stringify(v)}`;
  }).join('\n');
}

// Hard cap on summary fields (Length cap).
const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 300;

function capSummary(summary) {
  const out = {};
  let truncated = false;
  for (const [k, v] of Object.entries(summary)) {
    if (Array.isArray(v)) {
      if (v.length > MAX_LIST_ITEMS) truncated = true;
      out[k] = v.slice(0, MAX_LIST_ITEMS).map((x) => {
        const s = String(x);
        if (s.length > MAX_ITEM_CHARS) truncated = true;
        return s.slice(0, MAX_ITEM_CHARS);
      });
    } else if (typeof v === 'string') {
      if (v.length > MAX_ITEM_CHARS) truncated = true;
      out[k] = v.slice(0, MAX_ITEM_CHARS);
    } else {
      out[k] = v;
    }
  }
  return { summary: out, truncated };
}

export function prepareL1(db) {
  const insert = db.prepare(`
    INSERT INTO l1_episodic
      (id, ts, session, agent, topic, summary, summary_text, entities, source_type,
       prompt_hash, judge_model_id, source_l0_ids, token_count, compaction_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getById = db.prepare('SELECT * FROM l1_episodic WHERE id=?');
  const getByAgent = db.prepare('SELECT * FROM l1_episodic WHERE agent=? ORDER BY ts DESC LIMIT ?');
  const getUnconsolidated = db.prepare(
    'SELECT * FROM l1_episodic WHERE agent=? AND consolidated_to IS NULL ORDER BY ts'
  );
  const markConsolidated = db.prepare('UPDATE l1_episodic SET consolidated_to=? WHERE id=?');
  const incrDepth = db.prepare('UPDATE l1_episodic SET compaction_depth=compaction_depth+1 WHERE id=?');

  return {
    insert(epi) {
      const id = ulid('epi');
      const { summary, truncated } = capSummary(epi.summary);
      const schemaType = epi.schemaType ?? 'task';
      const summaryText = flattenSummary(summary, schemaType);
      const sourceType = VALID_SOURCE.has(epi.source_type) ? epi.source_type : 'agent_internal';
      const entities = epi.entities ? JSON.stringify(epi.entities) : null;
      const sourceL0Ids = epi.source_l0_ids ? JSON.stringify(epi.source_l0_ids) : null;

      insert.run(id, epi.ts ?? Date.now(), epi.session ?? null, epi.agent, epi.topic ?? null,
        JSON.stringify(summary), summaryText, entities, sourceType,
        epi.prompt_hash ?? null, epi.judge_model_id ?? null, sourceL0Ids,
        estTokens(summaryText), epi.compaction_depth ?? 0);
      return { id, truncated };
    },
    getById(id) { return getById.get(id); },
    getByAgent(agent, limit = 10) { return getByAgent.all(agent, limit); },
    getUnconsolidated(agent) { return getUnconsolidated.all(agent); },
    markConsolidated(l1Id, l2Id) { markConsolidated.run(l2Id, l1Id); },
    incrementDepth(l1Id) { incrDepth.run(l1Id); },
  };
}
