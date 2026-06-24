// Verdict application — reads scan_verdicts, mutates L2 facts.
// Behind APPLY_ENABLED flag (default false = record-only).
// Contradiction scan writes verdicts, verdict-application applies them — clean separation.
//
// CONTRADICTION → additive decay: max(confidence - 0.2, 0.15)
// SUPERSESSION  → old fact zeroed, edges invalidated, new fact versioned
// UNRELATED     → no action (already handled by contradiction scan as no-op)
// pending=1     → skip (: owner must approve first)

import { applyContradictionDecay } from '../retrieval/gate.mjs';

export function applyPendingVerdicts(db, { applyEnabled = false, log = console.log } = {}) {
  const unapplied = db.prepare(`
    SELECT v.id, v.fact_a, v.fact_b, v.verdict, v.pending
    FROM scan_verdicts v
    WHERE v.verdict != 'UNRELATED'
      AND v.pending = 0
      AND NOT EXISTS (
        SELECT 1 FROM scan_verdicts_applied a WHERE a.verdict_id = v.id
      )
    ORDER BY v.scanned_at
  `).all();

  if (unapplied.length === 0) {
    log('apply-verdicts: no unapplied verdicts');
    return { applied: 0, skipped_pending: 0 };
  }

  const skippedPending = db.prepare(`
    SELECT COUNT(*) c FROM scan_verdicts
    WHERE verdict != 'UNRELATED' AND pending = 1
      AND NOT EXISTS (SELECT 1 FROM scan_verdicts_applied a WHERE a.verdict_id = id)
  `).get().c;

  log(`apply-verdicts: ${unapplied.length} unapplied, ${skippedPending} pending (blocked)`);
  if (!applyEnabled) {
    log('apply-verdicts: RECORD-ONLY mode (applyEnabled=false) — no mutations');
    return { applied: 0, skipped_pending: skippedPending, record_only: true };
  }

  const updateConf = db.prepare('UPDATE l2_semantic SET confidence=?, updated_at=? WHERE id=?');
  const zeroFact = db.prepare('UPDATE l2_semantic SET confidence=0, updated_at=? WHERE id=?');
  const invalidateEdges = db.prepare("UPDATE graph_edges SET invalid_at=? WHERE source=? OR target=?");
  const versionFact = db.prepare('UPDATE l2_semantic SET version=?, prev_version_id=?, updated_at=? WHERE id=?');
  const markApplied = db.prepare(`
    INSERT INTO scan_verdicts_applied (verdict_id, applied_at, action)
    VALUES (?, ?, ?)
  `);

  let applied = 0;
  const now = Date.now();

  for (const v of unapplied) {
    if (v.verdict === 'CONTRADICTION') {
      const fact = db.prepare('SELECT confidence FROM l2_semantic WHERE id=?').get(v.fact_a);
      if (!fact) continue;
      const newConf = applyContradictionDecay(fact.confidence);
      updateConf.run(newConf, now, v.fact_a);
      markApplied.run(v.id, now, `contradiction_decay:${fact.confidence}->${newConf}`);

      if (newConf <= 0.15) log(`  cortex.confidence_suppressed fact=${v.fact_a} chain=${v.fact_b}`);
      else if (newConf <= 0.4) log(`  cortex.confidence_annotated fact=${v.fact_a} confidence=${newConf}`);
      applied++;
    } else if (v.verdict === 'SUPERSESSION') {
      const oldFact = db.prepare('SELECT version FROM l2_semantic WHERE id=?').get(v.fact_a);
      if (!oldFact) continue;
      zeroFact.run(now, v.fact_a);
      invalidateEdges.run(now, v.fact_a, v.fact_a);
      versionFact.run((oldFact.version ?? 1) + 1, v.fact_a, now, v.fact_b);
      markApplied.run(v.id, now, `supersession:${v.fact_a}->zeroed,${v.fact_b}->v${(oldFact.version ?? 1) + 1}`);

      log(`  cortex.supersession old=${v.fact_a} zeroed, new=${v.fact_b} v${(oldFact.version ?? 1) + 1}`);
      applied++;
    }
  }

  log(`apply-verdicts: ${applied} applied, ${skippedPending} pending`);
  return { applied, skipped_pending: skippedPending };
}
