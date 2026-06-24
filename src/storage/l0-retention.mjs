// L0 retention scanner — L0 retention rule.
// Delete: ingested_at wall-clock ≥14d AND parent L1 consolidated (or skip:non-promotable).
// Hard cap: 90d wall-clock regardless.
// Resurrection: if L0 is referenced by active L2 fact via source_l0_sample, keep.

const RETENTION_MIN_DAYS = 14;
const RETENTION_HARD_CAP_DAYS = 90;

export function scanRetention(db, { dryRun = true, log = console.log } = {}) {
  const now = Date.now();
  const minAge = now - RETENTION_MIN_DAYS * 86400_000;
  const hardCap = now - RETENTION_HARD_CAP_DAYS * 86400_000;

  // Eligible: ingested_at < minAge AND consolidated (or skip/sticker/design-deferred)
  const softCandidates = db.prepare(`
    SELECT id, ingested_at, consolidated_to FROM l0_raw
    WHERE ingested_at < ?
      AND (consolidated_to IS NOT NULL
           OR consolidated_to LIKE 'skip:%'
           OR consolidated_to LIKE 'dup:%')
  `).all(minAge);

  // Hard cap: everything older than 90d regardless
  const hardCandidates = db.prepare(`
    SELECT id, ingested_at, consolidated_to FROM l0_raw
    WHERE ingested_at < ?
  `).all(hardCap);

  // Union: unique IDs
  const deleteIds = new Set([
    ...softCandidates.map((r) => r.id),
    ...hardCandidates.map((r) => r.id),
  ]);

  // Resurrection: check if any L2 fact references this L0 via source_l0_sample
  const resurrect = new Set();
  if (deleteIds.size > 0) {
    const l2WithSamples = db.prepare(
      "SELECT source_l0_sample FROM l2_semantic WHERE source_l0_sample IS NOT NULL AND confidence > 0",
    ).all();
    for (const row of l2WithSamples) {
      try {
        for (const l0Id of JSON.parse(row.source_l0_sample)) {
          if (deleteIds.has(l0Id)) resurrect.add(l0Id);
        }
      } catch {}
    }
  }

  for (const id of resurrect) deleteIds.delete(id);

  log(`l0-retention: ${deleteIds.size} to delete (${softCandidates.length} soft + ${hardCandidates.length} hard - ${resurrect.size} resurrected)`);
  log(`  dry-run: ${dryRun}`);

  if (!dryRun && deleteIds.size > 0) {
    const stmt = db.prepare('DELETE FROM l0_raw WHERE id=?');
    const tx = db.transaction(() => {
      for (const id of deleteIds) stmt.run(id);
    });
    tx();
    log(`  deleted: ${deleteIds.size}`);
  }

  return {
    total_candidates: deleteIds.size,
    soft: softCandidates.length,
    hard: hardCandidates.length,
    resurrected: resurrect.size,
    deleted: dryRun ? 0 : deleteIds.size,
    dry_run: dryRun,
  };
}
