// Graph maintenance: decay (persisted), orphan cleanup, stats.
// Runs daily via croner. Zero LLM.
// Merge is NOT in maintenance (separate manual task with owner review).

const EDGE_DECAY_RATE = 0.98;
const STRONG_EDGE_DECAY = 0.995;
const STRONG_EDGE_THRESHOLD = 5;
const NODE_DECAY_RATE = 0.97;
const WEIGHT_FLOOR = 0.05;
const ORPHAN_THRESHOLD_DAYS = 30;

export function canMerge(labelA, labelB) {
  if (labelA.length < 6 || labelB.length < 6) return false;
  if (/\d/.test(labelA) || /\d/.test(labelB)) return false;
  return true;
}

export function runMaintenance(graph, { db, dryRun = false, log = console.log } = {}) {
  const now = Date.now();
  let edgesDecayed = 0, edgesInvalidated = 0, nodesDecayed = 0, orphansRemoved = 0;

  // --- Edge decay: persist to SQLite ---
  const edgeUpdates = [];
  const edgeInvalidations = [];
  for (const [source, edges] of graph.edges) {
    for (const e of edges) {
      if (e.invalid_at != null) continue;
      if (!e.last_seen) continue;
      const rawDays = (now - e.last_seen) / 86400_000;
      if (rawDays < 1) continue;
      const daysSince = Math.min(rawDays, 1);
      const rate = e.evidence_count > STRONG_EDGE_THRESHOLD ? STRONG_EDGE_DECAY : EDGE_DECAY_RATE;
      const newWeight = Math.round(e.weight * (rate ** daysSince) * 1000) / 1000;
      if (newWeight < WEIGHT_FLOOR) {
        e.invalid_at = now;
        edgeInvalidations.push({ source, target: e.target, relation: e.relation, invalid_at: now });
        edgesInvalidated++;
      } else if (newWeight !== e.weight) {
        e.weight = newWeight;
        edgeUpdates.push({ source, target: e.target, relation: e.relation, weight: newWeight });
        edgesDecayed++;
      }
    }
  }

  // --- Node decay: persist to SQLite ---
  const nodeUpdates = [];
  for (const [id, node] of graph.nodes) {
    if (node.weight <= WEIGHT_FLOOR) continue;
    if (!node.last_accessed) continue;
    const rawDays = (now - node.last_accessed) / 86400_000;
    if (rawDays < 1) continue;
    const daysSince = Math.min(rawDays, 1);
    const newWeight = Math.round(node.weight * (NODE_DECAY_RATE ** daysSince) * 1000) / 1000;
    if (newWeight !== node.weight && newWeight >= WEIGHT_FLOOR) {
      node.weight = newWeight;
      nodeUpdates.push({ id, weight: newWeight });
      nodesDecayed++;
    }
  }

  // --- Orphan cleanup ---
  const cutoff = now - ORPHAN_THRESHOLD_DAYS * 86400_000;
  const nodesWithEdges = new Set();
  for (const [source, edges] of graph.edges) {
    for (const e of edges) {
      if (e.invalid_at == null) { nodesWithEdges.add(source); nodesWithEdges.add(e.target); }
    }
  }
  const orphanIds = [];
  for (const [id, node] of graph.nodes) {
    if (nodesWithEdges.has(id)) continue;
    if (node.last_accessed && node.last_accessed > cutoff) continue;
    if (node.access_count >= 3) continue;
    if (node.weight >= 0.1) continue;
    if (node.linked_facts) {
      try { if (JSON.parse(node.linked_facts).length > 0) continue; } catch {}
    }
    orphanIds.push(id);
  }
  orphansRemoved = orphanIds.length;

  // --- Persist to SQLite ---
  if (db && !dryRun) {
    if (edgeUpdates.length > 0) {
      const stmt = db.prepare('UPDATE graph_edges SET weight=? WHERE source=? AND target=? AND relation=?');
      const tx = db.transaction(() => {
        for (const u of edgeUpdates) stmt.run(u.weight, u.source, u.target, u.relation);
      });
      tx();
    }
    if (edgeInvalidations.length > 0) {
      const stmt = db.prepare('UPDATE graph_edges SET invalid_at=? WHERE source=? AND target=? AND relation=?');
      const tx = db.transaction(() => {
        for (const u of edgeInvalidations) stmt.run(u.invalid_at, u.source, u.target, u.relation);
      });
      tx();
    }
    if (nodeUpdates.length > 0) {
      const stmt = db.prepare('UPDATE graph_nodes SET weight=? WHERE id=?');
      const tx = db.transaction(() => {
        for (const u of nodeUpdates) stmt.run(u.weight, u.id);
      });
      tx();
    }
    if (orphanIds.length > 0) {
      const delNode = db.prepare('DELETE FROM graph_nodes WHERE id=?');
      const delEdgeS = db.prepare('DELETE FROM graph_edges WHERE source=?');
      const delEdgeT = db.prepare('DELETE FROM graph_edges WHERE target=?');
      const tx = db.transaction(() => {
        for (const id of orphanIds) {
          delNode.run(id);
          delEdgeS.run(id);
          delEdgeT.run(id);
          graph.nodes.delete(id);
        }
      });
      tx();
    }
  }

  log(`maintenance: edges ${edgesDecayed} decayed + ${edgesInvalidated} invalidated, nodes ${nodesDecayed} decayed, orphans ${orphansRemoved} ${dryRun ? '(dry-run)' : 'removed'}`);
  return { edgesDecayed, edgesInvalidated, nodesDecayed, orphansRemoved, orphanIds: dryRun ? orphanIds : [] };
}
