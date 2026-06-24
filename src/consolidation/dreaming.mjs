// Dreaming / Insight Pass — triggered on session_end.
// Architecture: session L1 summaries + last 5 accessed L2 → haiku insight →
// candidate L2 facts tag="insight" confidence=0.6 (agent_internal).
// Dreaming gate (Design rule): agent_internal can't confirm itself.
// Dreaming cap: 0.7 self-only, 0.85 with external confirmation.

import { dreamingMaxConfidence } from '../retrieval/gate.mjs';
import { ulid, sha16 } from '../utils/lexical.mjs';
import { parseJsonLoose } from '../utils/json.mjs';
import { prioritizeForDreaming } from '../cognitive/c2-replay.mjs';

export const DREAMING_DEFAULTS = Object.freeze({
  insightBaseConfidence: 0.6,
  sourceType: 'agent_internal',
});

export function capDreamingConfidence(targetConfidence, hasNonAgentInternalSource) {
  const cap = dreamingMaxConfidence(hasNonAgentInternalSource);
  return Math.min(targetConfidence, cap);
}

const INSIGHT_PROMPT = `Analyze this session's events and the agent's recent knowledge.
Identify non-obvious patterns, contradictions with prior knowledge, or important gaps.
Output valid JSON: {"insights": [{"text": "...", "entities": ["..."], "type": "pattern|contradiction|gap"}]}
Be specific. Each insight must be a concrete observation, not a generic statement.`;

const PROMPT_HASH = sha16(INSIGHT_PROMPT);

export async function runDreaming(db, llmClient, { agent, session, log = console.log } = {}) {
  const sessionL1 = db.prepare(
    'SELECT id, summary_text, entities FROM l1_episodic WHERE session=? AND agent=? ORDER BY ts DESC LIMIT 10',
  ).all(session, agent);

  const recentL2 = db.prepare(
    'SELECT id, fact_text, entities FROM l2_semantic WHERE confidence > 0 ORDER BY last_accessed DESC LIMIT 5',
  ).all();

  if (sessionL1.length === 0) {
    log('dreaming: no L1 for session, skipping');
    return { insights: 0 };
  }

  // C2: prioritize L1 by salience × (1 − utilization)
  const prioritized = prioritizeForDreaming(sessionL1, db);
  if (prioritized.length > 0) {
    sessionL1.length = 0;
    sessionL1.push(...prioritized);
  }

  const context = [
    '## This session summaries:',
    ...sessionL1.map((l) => `- ${l.summary_text?.slice(0, 300) ?? ''}`),
    '',
    '## Recent knowledge (last accessed facts):',
    ...recentL2.map((f) => `- ${f.fact_text?.slice(0, 200) ?? ''}`),
  ].join('\n');

  const result = await llmClient.worker({
    system: INSIGHT_PROMPT,
    user: context,
    maxTokens: 1000,
  });

  const parsed = parseJsonLoose(result.text);
  if (!parsed?.insights?.length) {
    log('dreaming: no insights extracted');
    return { insights: 0 };
  }

  const insertL2 = db.prepare(`INSERT INTO l2_semantic
    (id, created_at, fact_text, entities, confidence, source_type, scope, tags, source_agent, prompt_hash, judge_model_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let count = 0;
  for (const insight of parsed.insights.slice(0, 5)) {
    if (!insight.text || insight.text.length < 10) continue;
    const conf = capDreamingConfidence(DREAMING_DEFAULTS.insightBaseConfidence, false);
    const id = ulid('fact');
    insertL2.run(
      id, Date.now(), insight.text.trim(),
      JSON.stringify(insight.entities ?? []),
      conf,
      DREAMING_DEFAULTS.sourceType,
      `agent:${agent}`,
      JSON.stringify(['insight', insight.type ?? 'pattern']),
      agent,
      PROMPT_HASH,
      result.model ?? 'unknown',
    );
    count++;
    log(`  insight: ${insight.text.slice(0, 80)}`);
  }

  log(`dreaming: ${count} insights from ${sessionL1.length} L1`);
  return { insights: count };
}
