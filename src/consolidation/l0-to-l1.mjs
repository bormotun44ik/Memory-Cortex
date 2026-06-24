// L0 → L1 consolidation (every 30 minutes via croner).
// Groups unconsolidated L0 by session + topic_cluster (top entities).
// Each group → haiku structured summary → L1 record.
// schema_type routing selects the JSON shape.
// Re-anchoring: high-salience L0 sampled for verification .
// v0: no embedding (empty), no cosine. Entity extraction feeds the graph.

import { prepareL0 } from '../storage/l0.mjs';
import { prepareL1, routeSchemaType, lowestSourceType, SCHEMA_TYPES } from '../storage/l1.mjs';
import { estTokens, sha16 } from '../utils/lexical.mjs';
import { checkSurprise } from '../cognitive/e3-surprise.mjs';
import { parseJsonLoose } from '../utils/json.mjs';

const GRACE_PERIOD_MS = 10 * 60_000; // 10 min — don't touch hot data
const BATCH_TOKEN_LIMIT = 4000;      // truncate input per batch (doc line 382)

// Group L0 records: session-first, then sub-group by topic if too large.
// Works for both live data (session = real agent session, topic-coherent) and
// imported data (session = import:source:file, date-coherent but topic-mixed).
// Sub-grouping avoids the 91% singleton problem (agentmemory has unique concepts
// per obs → old session|topic key created one group per obs) AND avoids shoving
// 500 diverse obs into one haiku call.
const MAX_GROUP_SIZE = 15; // ~4K tokens at ~250tok/obs. Larger groups truncate anyway.
const TEMPORAL_WINDOW_MS = 30 * 60_000; // 30 min — adjacent messages within this gap = same topic

function groupBySessionTopic(records) {
  // Phase 1: group by session only
  const bySession = new Map();
  for (const r of records) {
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(r);
  }

  // Phase 2: sub-group large sessions
  const groups = new Map();
  for (const [session, recs] of bySession) {
    if (recs.length <= MAX_GROUP_SIZE) {
      groups.set(session, recs);
      continue;
    }

    // Check if records have entities at all
    const hasEntities = recs.some((r) => r.entities && r.entities !== '[]' && r.entities !== 'null');

    if (hasEntities) {
      // Entity sub-grouping (original path — works for imported data)
      const entityBuckets = new Map();
      for (const r of recs) {
        const entities = r.entities ? JSON.parse(r.entities) : [];
        const primary = entities[0] ?? '__none__';
        if (!entityBuckets.has(primary)) entityBuckets.set(primary, []);
        entityBuckets.get(primary).push(r);
      }
      for (const [entity, bucket] of entityBuckets) {
        const key = `${session}|${entity}`;
        if (bucket.length <= MAX_GROUP_SIZE) {
          groups.set(key, bucket);
        } else {
          for (let i = 0; i < bucket.length; i += MAX_GROUP_SIZE) {
            groups.set(`${key}:${i}`, bucket.slice(i, i + MAX_GROUP_SIZE));
          }
        }
      }
    } else {
      // Temporal sub-grouping (fallback for live data with no entities).
      // Adjacent messages within TEMPORAL_WINDOW_MS = same conversational topic.
      const sorted = [...recs].sort((a, b) => a.ts - b.ts);
      let groupIdx = 0;
      let current = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].ts - sorted[i - 1].ts > TEMPORAL_WINDOW_MS || current.length >= MAX_GROUP_SIZE) {
          groups.set(`${session}|t${groupIdx}`, current);
          groupIdx++;
          current = [sorted[i]];
        } else {
          current.push(sorted[i]);
        }
      }
      if (current.length > 0) groups.set(`${session}|t${groupIdx}`, current);
    }
  }
  return groups;
}

// Determine dominant L0 type for routing.
function dominantType(records) {
  const counts = {};
  for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'exchange';
}

// Build the consolidation prompt per schema_type.
function buildPrompt(schemaType) {
  const fields = SCHEMA_TYPES[schemaType]?.fields ?? SCHEMA_TYPES.task.fields;
  return `Compress these events into structured JSON.\nFormat: {${fields.join(', ')}}\nkey_artifacts (if present): exact file paths, commands, ports, configs — verbatim.\nKeep language as-is (RU stays RU, EN stays EN).`;
}

// KG-triple detection: short content (<150 chars) with no entities = already a
// semantic fact, not an episode. These skip l0→l1 summarization (which would
// force episodic {done,decided,remaining} on a "X uses Y" fact) and go directly
// to L2 via in a separate path. Distinction is structural, not a special-case
// hack: the architecture has L1=episodic and L2=semantic, and KG triples are
// semantic by nature.
// Strip HTML tags and style/script blocks from content before haiku prompt.
// Design-site analysis records contain raw HTML that wastes tokens and breaks
// haiku's JSON output (one HTML record corrupts a whole 15-record group).
function stripHtml(text) {
  return text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const KG_TRIPLE_MAX_CHARS = 150;

function isKgTriple(record) {
  return record.content.length < KG_TRIPLE_MAX_CHARS &&
    (record.entities == null || record.entities === 'null' || record.entities === '[]');
}

// Permanent-fail tracking: group key → consecutive fail count.
// Persists across cron cycles (same process), resets on daemon restart (fresh chances).
const _failCounts = new Map();
const MAX_RETRIES = 3;

export async function runL0ToL1(db, llmClient, { log = console.log } = {}) {
  const l0 = prepareL0(db);
  const l1 = prepareL1(db);
  const cutoff = Date.now() - GRACE_PERIOD_MS;

  // Get all agents with unconsolidated L0
  const agents = db.prepare(
    "SELECT DISTINCT agent FROM l0_raw WHERE consolidated_to IS NULL AND ts < ?"
  ).all(cutoff).map((r) => r.agent);

  let totalGroups = 0, totalL1 = 0;

  for (const agent of agents) {
    const records = db.prepare(
      "SELECT * FROM l0_raw WHERE agent=? AND consolidated_to IS NULL AND ts < ? ORDER BY salience DESC, ts"
    ).all(agent, cutoff);

    if (records.length === 0) continue;

    // Separate KG triples from episodes — KG triples skip l0→l1
    const episodes = [];
    const kgTriples = [];
    for (const r of records) {
      if (isKgTriple(r)) kgTriples.push(r);
      else episodes.push(r);
    }
    if (kgTriples.length > 0) {
      // Mark KG triples as consolidated directly (they'll go to L2 via separate path)
      const markDirect = db.prepare("UPDATE l0_raw SET consolidated_to='skip:kg-triple' WHERE id=?");
      for (const r of kgTriples) markDirect.run(r.id);
      log(`  ${agent}: ${kgTriples.length} KG triples skipped (direct L2 path)`);
    }
    if (episodes.length === 0) continue;

    const groups = groupBySessionTopic(episodes);
    totalGroups += groups.size;

    for (const [key, recs] of groups) {
      // Permanent-fail backoff: skip groups that failed MAX_RETRIES times
      if ((_failCounts.get(key) ?? 0) >= MAX_RETRIES) {
        const markSkip = db.prepare("UPDATE l0_raw SET consolidated_to='skip:permanent-json-fail' WHERE id=?");
        for (const r of recs) markSkip.run(r.id);
        log(`  l0→l1: group ${key} failed ${MAX_RETRIES}x, marked permanent-fail (${recs.length} L0)`);
        _failCounts.delete(key);
        continue;
      }

      const domType = dominantType(recs);
      const schemaType = routeSchemaType(domType);
      const prompt = buildPrompt(schemaType);
      const promptHash = sha16(prompt);

      // Truncate input to BATCH_TOKEN_LIMIT
      let inputText = '';
      const usedIds = [];
      for (const r of recs) {
        const line = `[${r.type}] ${stripHtml(r.content)}\n`;
        if (estTokens(inputText + line) > BATCH_TOKEN_LIMIT) break;
        inputText += line;
        usedIds.push(r.id);
      }

      if (!inputText.trim()) continue;

      let text;
      try {
        ({ text } = await llmClient.worker({
          system: prompt,
          user: `<data>\n${inputText}</data>\n\nOutput ONLY the JSON object.`,
          maxTokens: 1500,
          prefill: '{',
        }));
      } catch (e) {
        _failCounts.set(key, (_failCounts.get(key) ?? 0) + 1);
        log(`  l0→l1: LLM error for group ${key} (attempt ${_failCounts.get(key)}/${MAX_RETRIES}): ${e.message?.slice(0, 100)}`);
        continue;
      }

      let summary;
      try {
        summary = parseJsonLoose(text);
      } catch {
        _failCounts.set(key, (_failCounts.get(key) ?? 0) + 1);
        log(`  l0→l1: JSON parse failed for group ${key} (attempt ${_failCounts.get(key)}/${MAX_RETRIES})`);
        continue;
      }

      // Guard: reject empty/stub summaries (haiku sometimes returns empty fields)
      const guardFields = SCHEMA_TYPES[schemaType]?.fields ?? SCHEMA_TYPES.task.fields;
      const summaryText = typeof summary === 'string' ? summary
        : guardFields.map((k) => summary[k]).filter(Boolean)
          .map((v) => (Array.isArray(v) ? v.join(', ') : String(v))).join(' ');
      if (summaryText.replace(/\s+/g, '').length < 50) {
        _failCounts.set(key, (_failCounts.get(key) ?? 0) + 1);
        log(`  l0→l1: empty summary for group ${key} (attempt ${_failCounts.get(key)}/${MAX_RETRIES})`);
        continue;
      }

      // Entities from all L0 in batch
      const allEntities = new Set();
      const sourceTypes = [];
      for (const r of recs) {
        if (r.entities) try { for (const e of JSON.parse(r.entities)) allEntities.add(e); } catch {}
        sourceTypes.push(r.source_type);
      }

      const { id: l1Id } = l1.insert({
        ts: recs[0].ts,
        session: recs[0].session,
        agent,
        topic: [...allEntities].slice(0, 5).join(', '),
        summary,
        schemaType,
        source_type: lowestSourceType(sourceTypes),
        entities: [...allEntities].slice(0, 20),
        source_l0_ids: usedIds,
        prompt_hash: promptHash,
        judge_model_id: llmClient.MODEL_IDS.worker,
      });

      // E3 surprise-at-consolidation: if L1 surprises existing L2,
      // boost the RELATED L2 facts (entity-overlap) — they're now "contested"
      try {
        const l1Row = l1.getById(l1Id);
        if (l1Row && checkSurprise(db, l1Row)) {
          const l1Ents = l1Row.entities ? JSON.parse(l1Row.entities) : [];
          if (l1Ents.length > 0) {
            const likePattern = l1Ents.slice(0, 3).map((e) => `%${e}%`);
            for (const pat of likePattern) {
              db.prepare('UPDATE l2_semantic SET salience_boosted = 1 WHERE confidence > 0 AND entities LIKE ?').run(pat);
            }
          }
        }
      } catch { /* E3 errors must not block consolidation */ }

      // Mark L0 as consolidated
      for (const id of usedIds) l0.markConsolidated(id, l1Id);
      _failCounts.delete(key);
      totalL1++;
    }
  }

  log(`l0→l1: ${totalGroups} groups → ${totalL1} L1 records from ${agents.length} agents`);
  return { groups: totalGroups, l1_created: totalL1 };
}
