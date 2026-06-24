// Entity candidate queue — hourly batch review of unknown entities.
// Architecture: unknown capitalized words → queue → 1 haiku call reviews ~50.
// Classifies as entity (add node) or noise (discard).

import { canonEntity } from './entities.mjs';
import { parseJsonLoose } from '../utils/json.mjs';
import { ulid } from '../utils/lexical.mjs';

const REVIEW_PROMPT = `Classify each candidate as either a real entity (project, tool, person, service, concept worth tracking) or noise (generic word, abbreviation, random capitalization).
Output JSON: {"entities": [{"text": "...", "type": "project|tool|service|person|concept", "keep": true/false}]}
Only keep=true for specific, named things worth remembering.`;

export function collectCandidates(db, graph, { limit = 50 } = {}) {
  const knownLabels = new Set();
  for (const [, node] of graph.nodes) knownLabels.add(canonEntity(node.label));

  const recentL2 = db.prepare(
    'SELECT fact_text, entities FROM l2_semantic WHERE confidence > 0 ORDER BY created_at DESC LIMIT 200',
  ).all();

  const candidates = new Map();
  for (const row of recentL2) {
    if (!row.entities) continue;
    try {
      for (const e of JSON.parse(row.entities)) {
        const canon = canonEntity(e);
        if (canon.length < 3 || canon.length > 40) continue;
        if (knownLabels.has(canon)) continue;
        candidates.set(canon, (candidates.get(canon) ?? 0) + 1);
      }
    } catch {}
  }

  return [...candidates.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
}

export async function reviewCandidates(candidates, llmClient, { log = console.log } = {}) {
  if (candidates.length === 0) return { added: 0, discarded: 0 };

  const batchText = candidates.map((c) => `- "${c.text}" (seen ${c.count}x)`).join('\n');
  const result = await llmClient.worker({
    system: REVIEW_PROMPT,
    user: batchText,
    maxTokens: 1500,
  });

  const parsed = parseJsonLoose(result.text);
  if (!parsed?.entities) return { added: 0, discarded: 0 };

  let added = 0, discarded = 0;
  for (const e of parsed.entities) {
    if (e.keep) {
      added++;
      log(`  entity: ${e.text} (${e.type})`);
    } else {
      discarded++;
    }
  }

  return { added, discarded, entities: parsed.entities.filter((e) => e.keep) };
}

export async function runEntityQueue(db, graph, llmClient, { log = console.log } = {}) {
  const candidates = collectCandidates(db, graph);
  log(`entity-queue: ${candidates.length} candidates`);
  if (candidates.length === 0) return { candidates: 0, added: 0 };

  const result = await reviewCandidates(candidates, llmClient, { log });

  if (result.entities) {
    for (const e of result.entities) {
      const nodeId = `node_${canonEntity(e.text).replace(/\s+/g, '_')}`;
      if (!graph.getNode(nodeId)) {
        graph.addNode(nodeId, { label: e.text, type: e.type || 'concept' });
      }
    }
  }

  log(`entity-queue: ${result.added} added, ${result.discarded} discarded`);
  return { candidates: candidates.length, added: result.added, discarded: result.discarded };
}
