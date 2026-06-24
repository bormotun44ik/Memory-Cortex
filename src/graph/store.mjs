// In-memory graph store with SQLite persistence.
// Loaded on daemon start, persisted on writes. activation.mjs reads from this.
//
// Nodes: Map<id, {label, type, weight, access_count, access_count_by_agent, last_accessed, linked_facts, aliases}>
// Edges: Map<sourceId, [{target, relation, weight, evidence_count, last_seen, valid_from, invalid_at}]>

import { invalidateSearchCache } from '../retrieval/search.mjs';

const VALID_TYPES = new Set([
  'project', 'tool', 'service', 'server', 'person', 'concept', 'file', 'error', 'action', 'config',
]);

export class GraphStore {
  constructor(db) {
    this.db = db;
    this.nodes = new Map();
    this.edges = new Map();
    this._stmts = null;
  }

  _prepare() {
    if (this._stmts) return this._stmts;
    const db = this.db;
    this._stmts = {
      upsertNode: db.prepare(`
        INSERT INTO graph_nodes (id, label, type, weight, access_count, access_count_by_agent, last_accessed, linked_facts, aliases)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label=excluded.label, type=excluded.type, weight=excluded.weight,
          access_count=excluded.access_count, access_count_by_agent=excluded.access_count_by_agent,
          last_accessed=excluded.last_accessed, linked_facts=excluded.linked_facts, aliases=excluded.aliases
      `),
      upsertEdge: db.prepare(`
        INSERT INTO graph_edges (source, target, relation, weight, evidence_count, last_seen, valid_from, invalid_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, target, relation) DO UPDATE SET
          weight=excluded.weight, evidence_count=excluded.evidence_count,
          last_seen=excluded.last_seen, invalid_at=excluded.invalid_at
      `),
      allNodes: db.prepare('SELECT * FROM graph_nodes'),
      allEdges: db.prepare('SELECT * FROM graph_edges'),
      deleteNode: db.prepare('DELETE FROM graph_nodes WHERE id=?'),
      deleteEdge: db.prepare('DELETE FROM graph_edges WHERE source=? AND target=? AND relation=?'),
      invalidateEdges: db.prepare('UPDATE graph_edges SET invalid_at=? WHERE source=? OR target=?'),
    };
    return this._stmts;
  }

  load() {
    const s = this._prepare();
    this.nodes.clear();
    this.edges.clear();
    for (const r of s.allNodes.all()) {
      this.nodes.set(r.id, {
        label: r.label, type: r.type, weight: r.weight,
        access_count: r.access_count,
        access_count_by_agent: r.access_count_by_agent,
        last_accessed: r.last_accessed,
        linked_facts: r.linked_facts,
        aliases: r.aliases,
      });
    }
    for (const r of s.allEdges.all()) {
      if (!this.edges.has(r.source)) this.edges.set(r.source, []);
      this.edges.get(r.source).push({
        target: r.target, relation: r.relation, weight: r.weight,
        evidence_count: r.evidence_count, last_seen: r.last_seen,
        valid_from: r.valid_from, invalid_at: r.invalid_at,
      });
    }
    return { nodes: this.nodes.size, edges: this.edges.size };
  }

  addNode(id, { label, type, weight, aliases } = {}) {
    const t = VALID_TYPES.has(type) ? type : 'concept';
    const node = {
      label: label ?? id, type: t, weight: weight ?? 1.0,
      access_count: 0, access_count_by_agent: null,
      last_accessed: null, linked_facts: null, aliases: aliases ? JSON.stringify(aliases) : null,
    };
    this.nodes.set(id, node);
    this._prepare().upsertNode.run(id, node.label, node.type, node.weight,
      node.access_count, node.access_count_by_agent, node.last_accessed,
      node.linked_facts, node.aliases);
    invalidateSearchCache();
    return id;
  }

  addEdge(source, target, relation, { weight, valid_from } = {}) {
    const edge = {
      target, relation, weight: weight ?? 0.5,
      evidence_count: 1, last_seen: Date.now(),
      valid_from: valid_from ?? Date.now(), invalid_at: null,
    };
    // Check if exists in memory — if so, bump evidence
    const existing = this.edges.get(source);
    if (existing) {
      const found = existing.find((e) => e.target === target && e.relation === relation);
      if (found) {
        found.evidence_count++;
        found.last_seen = Date.now();
        found.weight = Math.min(1.0, found.weight + 0.1);
        edge.evidence_count = found.evidence_count;
        edge.weight = found.weight;
        edge.last_seen = found.last_seen;
      } else {
        existing.push(edge);
      }
    } else {
      this.edges.set(source, [edge]);
    }
    this._prepare().upsertEdge.run(source, target, relation, edge.weight,
      edge.evidence_count, edge.last_seen, edge.valid_from, edge.invalid_at);
  }

  touchNode(id, agent) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.access_count++;
    node.last_accessed = Date.now();
    if (agent) {
      const byAgent = node.access_count_by_agent ? JSON.parse(node.access_count_by_agent) : {};
      byAgent[agent] = (byAgent[agent] ?? 0) + 1;
      node.access_count_by_agent = JSON.stringify(byAgent);
    }
    this._prepare().upsertNode.run(id, node.label, node.type, node.weight,
      node.access_count, node.access_count_by_agent, node.last_accessed,
      node.linked_facts, node.aliases);
  }

  invalidateNode(id) {
    const now = Date.now();
    this._prepare().invalidateEdges.run(now, id, id);
    // Update in-memory
    for (const [, edges] of this.edges) {
      for (const e of edges) {
        if (e.target === id) e.invalid_at = now;
      }
    }
    const srcEdges = this.edges.get(id);
    if (srcEdges) for (const e of srcEdges) e.invalid_at = now;
  }

  getNode(id) { return this.nodes.get(id); }
  getEdges(source) { return this.edges.get(source) ?? []; }
  nodeCount() { return this.nodes.size; }
}
