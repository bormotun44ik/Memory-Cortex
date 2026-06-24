// R3 — Prospective bookmarks.
// Auto-bookmark ONLY facts that passed count-rule (R3 constraint).
// content_type ∈ {world_fact, user_preference}. Procedural → Curator, not R3.
// Caps: auto ≤5/agent, user ≤20/agent, TTL ≤30d.
// Fire = injected (trigger entities in query). Delete when fire ≥ 2 OR TTL expired.

import { ulid } from '../utils/lexical.mjs';
import { canonEntity } from '../graph/entities.mjs';

const MAX_AUTO = 5;
const MAX_USER = 20;
const MAX_TTL_DAYS = 30;

export function createBookmark(db, { agent, factId, triggerEntities, contentType, ttlDays = 7 }) {
  const ttl = Math.min(ttlDays, MAX_TTL_DAYS);
  const existing = db.prepare('SELECT count(*) c FROM bookmarks WHERE agent = ?').get(agent).c;
  if (existing >= MAX_USER) return null;
  const id = ulid('bm');
  db.prepare(`INSERT INTO bookmarks (id, agent, trigger_entities, fact_id, content_type, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, agent, JSON.stringify(triggerEntities), factId, contentType,
    Date.now() + ttl * 86400_000,
  );
  return id;
}

export function checkBookmarks(db, { agent, queryEntities }) {
  const now = Date.now();
  // Cleanup expired
  db.prepare('DELETE FROM bookmarks WHERE expires_at < ?').run(now);
  // Cleanup over-fired
  db.prepare('DELETE FROM bookmarks WHERE fire_count >= 2').run();

  const bookmarks = db.prepare('SELECT * FROM bookmarks WHERE agent = ?').all(agent);
  const fired = [];
  for (const bm of bookmarks) {
    const triggers = JSON.parse(bm.trigger_entities);
    const match = triggers.some((t) => queryEntities.has(canonEntity(t)));
    if (match) {
      db.prepare('UPDATE bookmarks SET fire_count = fire_count + 1 WHERE id = ?').run(bm.id);
      fired.push(bm.fact_id);
    }
  }
  return fired;
}
