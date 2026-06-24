// Slots — pinned mutable state with per-key TTL ().
// sync_turn heartbeats updated_at. Stale slot demotes to ranked candidate.
// Deleted at 2x TTL by daily maintenance (Slot TTL rule).

const SLOT_TTLS = Object.freeze({
  active_task: 24 * 3600_000,      // 24h
  session_context: 72 * 3600_000,  // 72h
  user_profile: null,              // no TTL
  server_spec: null,               // no TTL — stable hardware description
});

export function prepareSlots(db) {
  const upsert = db.prepare(`
    INSERT INTO slots (agent, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(agent, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `);
  const get = db.prepare('SELECT * FROM slots WHERE agent=? AND key=?');
  const getAll = db.prepare('SELECT * FROM slots WHERE agent=? ORDER BY key');
  const remove = db.prepare('DELETE FROM slots WHERE agent=? AND key=?');
  const cleanStale = db.prepare('DELETE FROM slots WHERE key=? AND updated_at < ?');

  return {
    set(agent, key, value) {
      upsert.run(agent, key, JSON.stringify(value), Date.now());
    },
    get(agent, key) {
      const row = get.get(agent, key);
      if (!row) return null;
      const ttl = SLOT_TTLS[key] ?? SLOT_TTLS[key.split(':')[0]] ?? null;
      if (ttl && Date.now() - row.updated_at > ttl) return null; // stale
      return JSON.parse(row.value);
    },
    getAll(agent) {
      const rows = getAll.all(agent);
      const now = Date.now();
      return rows.filter((r) => {
        const ttl = SLOT_TTLS[r.key] ?? SLOT_TTLS[r.key.split(':')[0]] ?? null;
        return !ttl || now - r.updated_at <= ttl;
      }).map((r) => ({ key: r.key, value: JSON.parse(r.value), updated_at: r.updated_at }));
    },
    remove(agent, key) { remove.run(agent, key); },
    // Daily maintenance: delete at 2x TTL (Slot TTL rule).
    cleanExpired() {
      const now = Date.now();
      let deleted = 0;
      for (const [key, ttl] of Object.entries(SLOT_TTLS)) {
        if (!ttl) continue;
        const r = cleanStale.run(key, now - 2 * ttl);
        deleted += r.changes;
      }
      return deleted;
    },
  };
}
