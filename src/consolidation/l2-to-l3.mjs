// L2 → L3 proposals (daily, 03:00 UTC via croner).
// Sonnet formulates crystallized rules from high-confidence, high-access L2 facts.
// Auto-approve if ALL conditions met ; otherwise pending_proposals.
// v0: pending_proposals = flagged in DB, Telegram routing deferred to integration.

import { sha16, ulid } from '../utils/lexical.mjs';

const CANDIDATE_QUERY = `
  SELECT * FROM l2_semantic
  WHERE access_count > 10
    AND created_at < ?
    AND crystallized_to IS NULL
    AND confidence > 0.7
    AND contradicted_by IS NULL
  ORDER BY access_count * confidence DESC
  LIMIT 5
`;

const AUTO_APPROVE_CRITERIA = {
  minConfidence: 0.9,
  minAccessCount: 20,
  minSourceFacts: 3,
};

const RULE_PROMPT = `Formulate a concise, actionable rule for an agent's system prompt.
Maximum 1 line. Must be specific and operational, not descriptive.
Keep the language of the source fact (RU stays RU, EN stays EN).
Output ONLY the rule text, nothing else.`;

export async function runL2ToL3(db, llmClient, { log = console.log } = {}) {
  const sevenDaysAgo = Date.now() - 7 * 86400_000;
  const candidates = db.prepare(CANDIDATE_QUERY).all(sevenDaysAgo);

  if (candidates.length === 0) {
    log('l2→l3: no candidates');
    return { proposed: 0, auto_approved: 0, pending: 0 };
  }

  log(`l2→l3: ${candidates.length} candidates`);
  const promptHash = sha16(RULE_PROMPT);

  const insertRule = db.prepare(`INSERT INTO l3_rules
    (id, agent, text, entities, source_facts, confidence, auto_approved, pending, prompt_hash, judge_model_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const markCrystallized = db.prepare('UPDATE l2_semantic SET crystallized_to=? WHERE id=?');

  let proposed = 0, autoApproved = 0, pending = 0;

  for (const fact of candidates) {
    const result = await llmClient.judge({
      system: RULE_PROMPT,
      user: `Source fact: ${fact.fact_text}\nEntities: ${fact.entities ?? '[]'}`,
      maxTokens: 200,
    });
    const ruleText = result.text;
    if (!ruleText || ruleText.length < 5) continue;

    const sourceCount = fact.source_l1_ids ? JSON.parse(fact.source_l1_ids).length : 0;
    const canAutoApprove =
      fact.confidence >= AUTO_APPROVE_CRITERIA.minConfidence &&
      fact.access_count >= AUTO_APPROVE_CRITERIA.minAccessCount &&
      sourceCount >= AUTO_APPROVE_CRITERIA.minSourceFacts;

    const ruleId = ulid('rule');
    const isPending = canAutoApprove ? 0 : 1;
    insertRule.run(
      ruleId,
      fact.scope?.startsWith('agent:') ? fact.scope.replace('agent:', '') : 'all',
      ruleText.trim(),
      fact.entities,
      JSON.stringify([fact.id]),
      fact.confidence,
      canAutoApprove ? 1 : 0,
      isPending,
      promptHash,
      result.model ?? 'unknown',
    );
    markCrystallized.run(ruleId, fact.id);

    if (canAutoApprove) {
      autoApproved++;
      log(`  auto-approved: ${ruleText.slice(0, 80)}`);
    } else {
      pending++;
      log(`  pending: ${ruleText.slice(0, 80)}`);
    }
    proposed++;
  }

  log(`l2→l3: ${proposed} proposed, ${autoApproved} auto-approved, ${pending} pending`);
  return { proposed, auto_approved: autoApproved, pending };
}
