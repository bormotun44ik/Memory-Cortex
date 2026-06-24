// L1 → L2 consolidation (every 6 hours via croner).
// Clusters L1 by entity-group + BM25 (v0, no cosine).
// Re-anchoring: sample high-salience source L0 for verification.
// exact-dup hash + BM25 + entity for near-dup → haiku classifies ADD/UPDATE/NONE.
// source_type inherits LOWEST trust ().

import { prepareL1, lowestSourceType } from '../storage/l1.mjs';
import { prepareL2 } from '../storage/l2.mjs';
import { estTokens, sha16, ulid } from '../utils/lexical.mjs';
import { parseJsonLoose } from '../utils/json.mjs';
import { parseEntities, entityOverlap, buildAliasMap, canonEntity, extractEntitiesFromText } from '../graph/entities.mjs';
import { GraphStore } from '../graph/store.mjs';

const MIN_CLUSTER_SIZE = 2;
const REANCHOR_SAMPLE = 5;
const REANCHOR_SALIENCE = 0.7;
const MAX_CLUSTER_BATCH = 5;
const MIN_SUMMARY_LEN = 50;
const BYPASS_SALIENCE = 0.9;
const BYPASS_MIN_L0_AGENT_INTERNAL = 2;

function clusterByEntity(l1Records, aliasMap) {
  const groups = new Map();
  for (const r of l1Records) {
    let entities = parseEntities(r.entities, aliasMap);
    // Fallback: extract from summary_text if entities field is empty
    if (entities.size === 0 && r.summary_text) {
      entities = extractEntitiesFromText(r.summary_text);
    }
    const primary = [...entities][0] ?? '__none__';
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary).push(r);
  }
  return groups;
}

// check if extracted fact is near-duplicate of existing L2.
// v0: normalized-text hash + BM25 + entity overlap (, no cosine).
function findDuplicate(db, factText, entities, aliasMap) {
  // Sanitize for FTS5: keep only word characters, filter short/noise tokens
  const FTS_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const tokens = factText.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30 && !FTS_RESERVED.has(t.toUpperCase()))
    .slice(0, 8);
  if (tokens.length === 0) return null;
  const ftsQuery = tokens.join(' OR ');
  if (!ftsQuery) return null;

  const candidates = db.prepare(`
    SELECT l2.* FROM l2_fts fts
    JOIN l2_semantic l2 ON l2.rowid = fts.rowid
    WHERE l2_fts MATCH ?
    ORDER BY rank LIMIT 5
  `).all(ftsQuery);

  const factEntities = parseEntities(JSON.stringify(entities), aliasMap);
  const factTokens = new Set(factText.toLowerCase().split(/\s+/).filter(t => t.length >= 4));
  for (const c of candidates) {
    const cEntities = parseEntities(c.entities, aliasMap);
    if (entityOverlap(factEntities, cEntities) >= 1) {
      // Entity match — verify with text similarity to avoid false positives
      // (e.g., "Payment debugging" vs "Payment approved" share "NowPayments"
      // but are different facts about same entity)
      const cTokens = new Set(c.fact_text.toLowerCase().split(/\s+/).filter(t => t.length >= 4));
      let inter = 0;
      for (const t of factTokens) if (cTokens.has(t)) inter++;
      const jaccard = (factTokens.size + cTokens.size - inter) > 0
        ? inter / (factTokens.size + cTokens.size - inter) : 0;
      if (jaccard >= 0.3) return c;
    }
  }
  return null;
}

function checkBypass(db, l1Record) {
  if (!l1Record.source_l0_ids) return false;
  if ((l1Record.summary_text ?? '').length < MIN_SUMMARY_LEN) return false;
  let l0Ids;
  try { l0Ids = JSON.parse(l1Record.source_l0_ids); } catch { return false; }
  // Check max salience from source L0
  let maxSalience = 0;
  for (const id of l0Ids) {
    const l0 = db.prepare('SELECT salience FROM l0_raw WHERE id=?').get(id);
    if (l0?.salience > maxSalience) maxSalience = l0.salience;
  }
  if (maxSalience < BYPASS_SALIENCE) return false;
  // Source type rules
  if (l1Record.source_type === 'user_authored' || l1Record.source_type === 'tool_result') return true;
  if (l1Record.source_type === 'agent_internal') return l0Ids.length >= BYPASS_MIN_L0_AGENT_INTERNAL;
  return false;
}

export async function runL1ToL2(db, llmClient, { graph = null, log = console.log } = {}) {
  const l1 = prepareL1(db);
  const l2 = prepareL2(db);
  const aliasMap = buildAliasMap(db);
  // Graph: use provided or create from DB. Live daemon passes its in-memory graph.
  const _graph = graph ?? new GraphStore(db);
  if (!graph) _graph.load();

  const agents = db.prepare(
    "SELECT DISTINCT agent FROM l1_episodic WHERE consolidated_to IS NULL"
  ).all().map((r) => r.agent);

  let totalClusters = 0, totalFacts = 0, totalDups = 0, totalBypassed = 0;

  for (const agent of agents) {
    const records = l1.getUnconsolidated(agent);
    if (records.length === 0) continue;

    // --- Salience bypass: promote qualifying singletons before clustering ---
    const bypassCandidates = [];
    const clusterCandidates = [];
    for (const r of records) {
      if (checkBypass(db, r)) bypassCandidates.push(r);
      else clusterCandidates.push(r);
    }

    for (const r of bypassCandidates) {
      if ((r.summary_text ?? '').length < MIN_SUMMARY_LEN) continue;
      const promptHash = sha16('l1-to-l2-bypass-v2-router');
      let text;
      try {
        ({ text } = await llmClient.worker({
          user: `Analyze this memory and extract knowledge. CLASSIFY each piece:
- If it's a step-by-step procedure/guide/workflow → type:"procedure", text=ALL steps as ONE ordered block (keep numbering, keep order, do NOT split into individual steps)
- If it's a descriptive fact/config/state → type:"fact", text=specific atomic claim
Output JSON: {"items": [{"text": "...", "entities": ["..."], "type": "fact|procedure"}]}

Summary:\n${r.summary_text.slice(0, 3500)}`,
          maxTokens: 1500,
        }));
      } catch (e) { log(`  bypass LLM error ${r.id}: ${e.message?.slice(0, 60)}`); continue; }

      let parsed;
      try { parsed = parseJsonLoose(text); } catch { log(`  bypass JSON fail ${r.id}`); continue; }
      // Support both old format {facts:[]} and new router format {items:[]}
      const items = parsed?.items ?? parsed?.facts ?? (Array.isArray(parsed) ? parsed : []);
      if (items.length === 0) continue;

      const CONFIDENCE_CAPS = { agent_internal: 0.4, user_authored: 0.7, tool_result: 0.7, tool_result_external: 0.5 };
      const maxConf = CONFIDENCE_CAPS[r.source_type] ?? 0.4;

      for (const f of items.slice(0, 7)) {
        const factText = typeof f.text === 'string' ? f.text : typeof f.fact === 'string' ? f.fact : '';
        if (!factText || factText.length < 10) continue;
        const entities = Array.isArray(f.entities) ? f.entities : [];
        const itemType = f.type || 'fact';

        // ROUTER: procedures → L3 proposal, facts → L2
        if (itemType === 'procedure' && factText.length > 50) {
          try {
            db.prepare(`INSERT INTO l3_rules (id,agent,text,entities,source_facts,confidence,auto_approved,pending,prompt_hash,judge_model_id)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
              ulid('rule'), agent === 'all' ? 'all' : agent,
              factText.slice(0, 2000),
              JSON.stringify(entities.slice(0, 10)),
              JSON.stringify([r.id]),
              maxConf, 0, 1, promptHash, llmClient.MODEL_IDS.worker,
            );
            log(`  → L3 proposal: ${factText.slice(0, 60)}`);
          } catch { /* L3 table may not exist in old DBs */ }
          continue;
        }

        let dup = null;
        try { dup = findDuplicate(db, factText, entities, aliasMap); } catch { continue; }
        if (dup) { totalDups++; continue; }
        const scope = r.source_type === 'agent_internal' ? `agent:${agent}` : 'shared';
        l2.insert({
          fact_text: factText, entities, confidence: Math.min(0.7, maxConf),
          source_type: r.source_type, source_l1_ids: [r.id],
          prompt_hash: promptHash, judge_model_id: llmClient.MODEL_IDS.worker,
          scope, source_agent: agent,
        });
        totalFacts++;
      }
      // Mark L1 as consolidated via bypass
      db.prepare("UPDATE l1_episodic SET consolidated_to=? WHERE id=?").run('bypass_l2', r.id);
      totalBypassed++;
    }

    // --- Standard cluster path (with split for large clusters) ---
    const clusters = clusterByEntity(clusterCandidates, aliasMap);

    for (const [entity, recs] of clusters) {
      if (recs.length < MIN_CLUSTER_SIZE) continue;

      // Split large clusters into batches (JSON truncation hardening)
      const batches = [];
      for (let i = 0; i < recs.length; i += MAX_CLUSTER_BATCH) {
        batches.push(recs.slice(i, i + MAX_CLUSTER_BATCH));
      }

      for (const batchRecs of batches) {
      totalClusters++;

      // Re-anchoring: fetch high-salience source L0 samples
      const l0Samples = [];
      for (const r of batchRecs) {
        if (!r.source_l0_ids) continue;
        try {
          const ids = JSON.parse(r.source_l0_ids);
          for (const id of ids) {
            const l0 = db.prepare('SELECT * FROM l0_raw WHERE id=?').get(id);
            if (l0 && l0.salience >= REANCHOR_SALIENCE) l0Samples.push(l0);
            if (l0Samples.length >= REANCHOR_SAMPLE) break;
          }
        } catch {}
        if (l0Samples.length >= REANCHOR_SAMPLE) break;
      }

      // Build extraction prompt (batch, not full cluster)
      const summaries = batchRecs.map((r) => r.summary_text).join('\n---\n');
      const originals = l0Samples.map((r) => `[${r.type}] ${r.content}`).join('\n');
      const promptHash = sha16('l1-to-l2-extraction-v1');

      const { text } = await llmClient.worker({
        system: `Extract stable facts from these episodic summaries. For each: {fact, entities, confidence}. Resolve contradictions between summaries and originals. Output ONLY a JSON array.`,
        user: `SUMMARIES:\n<data>\n${summaries}\n</data>\n\nORIGINAL SAMPLES:\n<data>\n${originals}\n</data>`,
        maxTokens: 2000,
        prefill: '[',
      });

      let facts;
      try {
        facts = parseJsonLoose(text);
      } catch {
        // Recursive split: halve the batch and retry each half
        if (batchRecs.length > 1) {
          const mid = Math.ceil(batchRecs.length / 2);
          log(`  l1→l2: JSON fail on batch of ${batchRecs.length} for ${entity}, splitting ${mid}+${batchRecs.length - mid}`);
          batches.push(batchRecs.slice(0, mid), batchRecs.slice(mid));
        } else {
          log(`  l1→l2: JSON parse failed for singleton ${entity}, skipping`);
        }
        continue;
      }
      if (!Array.isArray(facts)) continue;

      // Source types for trust inheritance
      const sourceTypes = batchRecs.map((r) => r.source_type);
      const inheritedSource = lowestSourceType(sourceTypes);
      const sourceL1Ids = batchRecs.map((r) => r.id);
      const sourceL0Sample = l0Samples.map((r) => r.id);

      for (const f of facts) {
        const factText = typeof f.fact === 'string' ? f.fact : String(f.fact ?? '');
        if (!factText || factText.length < 5) continue;
        const entities = Array.isArray(f.entities) ? f.entities : [];

        // check. If dedup crashes (FTS edge case) → SKIP insertion, don't
        // insert unchecked. Conservative: "when in doubt, don't add to L2."
        let dup = null;
        let dedupFailed = false;
        try { dup = findDuplicate(db, factText, entities, aliasMap); } catch (e) {
          dedupFailed = true;
          log(`  crash on "${factText.slice(0, 60)}": ${e.message} — SKIPPING (conservative)`);
        }
        if (dedupFailed) continue;
        if (dup) {
          totalDups++;
          continue; // v0: skip near-dups, don't update (conservative)
        }

        // Confidence cap differentiated by source_type (owner-approved mapping):
        //   agent_internal → max 0.4 (unverified agent inference, must confirm via live sessions)
        //   user_authored  → max 0.7 (owner's words, normal trust)
        //   tool_result    → max 0.7 (system observations, normal trust)
        // Design rule: inheritedSource already = lowest trust in the cluster.
        const CONFIDENCE_CAPS = { agent_internal: 0.4, user_authored: 0.7, tool_result: 0.7, tool_result_external: 0.5 };
        const maxConf = CONFIDENCE_CAPS[inheritedSource] ?? 0.4;
        const rawConf = typeof f.confidence === 'number' ? f.confidence : 0.7;

        const { id: factId } = l2.insert({
          fact_text: factText,
          entities,
          confidence: Math.min(rawConf, maxConf),
          source_type: inheritedSource,
          source_l1_ids: sourceL1Ids,
          source_l0_sample: sourceL0Sample,
          prompt_hash: promptHash,
          judge_model_id: llmClient.MODEL_IDS.worker,
          scope: 'shared',
          source_agent: agent,
        });
        totalFacts++;

        // Graph update: add nodes for entities, link fact, create edges (doc line 415-420).
        const nodeIds = [];
        for (const e of entities) {
          const label = String(e).slice(0, 50);
          if (label.length < 2) continue;
          const nodeId = 'node_' + canonEntity(label).replace(/\s+/g, '_');
          if (!_graph.getNode(nodeId)) _graph.addNode(nodeId, { label, type: 'concept' });
          nodeIds.push(nodeId);
        }
        // Link fact to primary node
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
        // Edges between co-occurring entities
        for (let i = 0; i < nodeIds.length && i < 3; i++) {
          for (let j = i + 1; j < nodeIds.length && j < i + 3; j++) {
            _graph.addEdge(nodeIds[i], nodeIds[j], 'co-occurs');
          }
        }
      }

      // Mark batch L1 as consolidated
      for (const r of batchRecs) l1.markConsolidated(r.id, `cluster:${entity}`);
      } // end batch loop
    }
  }

  log(`l1→l2: ${totalClusters} clusters + ${totalBypassed} bypassed → ${totalFacts} new facts, ${totalDups} dups skipped`);
  return { clusters: totalClusters, bypassed: totalBypassed, facts_created: totalFacts, dups_skipped: totalDups };
}
