// L0 raw event storage — append-only (writes non-blocking, <1ms).
// Salience scored at write time (regex, no LLM). Entities auto-extracted.
// source_type fail-safes to agent_internal (lowest trust) if unlabeled.

import { ulid, estTokens, salience } from '../utils/lexical.mjs';

const VALID_TYPES = new Set(['exchange', 'tool_call', 'tool_result', 'system_event']);
const VALID_SOURCE = new Set(['user_authored', 'tool_result', 'tool_result_external', 'agent_internal']);

// Hard length cap on content ( — deterministic, not judge trust).
const MAX_CONTENT_TOKENS = 8000;

export function prepareL0(db) {
  const insert = db.prepare(`
    INSERT INTO l0_raw (id, ts, session, agent, type, source_type, content, entities, tokens, salience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markConsolidated = db.prepare('UPDATE l0_raw SET consolidated_to=? WHERE id=?');
  const getById = db.prepare('SELECT * FROM l0_raw WHERE id=?');
  const getBySession = db.prepare('SELECT * FROM l0_raw WHERE session=? ORDER BY ts');
  const getUnconsolidated = db.prepare(
    'SELECT * FROM l0_raw WHERE agent=? AND consolidated_to IS NULL ORDER BY ts'
  );

  return {
    insert(event) {
      const id = ulid('obs');
      const type = VALID_TYPES.has(event.type) ? event.type : 'exchange';
      const sourceType = VALID_SOURCE.has(event.source_type) ? event.source_type : 'agent_internal';
      const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
      const contentBytes = Buffer.byteLength(content, 'utf8');
      const truncated = contentBytes > MAX_CONTENT_TOKENS * 4;
      const capped = truncated
        ? Buffer.from(content, 'utf8').subarray(0, MAX_CONTENT_TOKENS * 4).toString('utf8').replace(/�+$/, '')
        : content;
      const tokens = estTokens(capped);
      const sal = salience(capped);
      const entities = event.entities ? JSON.stringify(event.entities) : null;

      insert.run(id, event.ts ?? Date.now(), event.session, event.agent, type, sourceType,
        capped, entities, tokens, sal);
      return { id, truncated };
    },
    markConsolidated(l0Id, l1Id) { markConsolidated.run(l1Id, l0Id); },
    getById(id) { return getById.get(id); },
    getBySession(session) { return getBySession.all(session); },
    getUnconsolidated(agent) { return getUnconsolidated.all(agent); },
  };
}
