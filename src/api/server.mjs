// Fastify HTTP server — JSON-schema validation on every endpoint.
// binds to 127.0.0.1:7100 (loopback-only), requires CORTEX_SECRET.
// /mcp/search and /mcp/timeline serve L2 ONLY (Design rule).
// L0 raw events NEVER exposed via any agent-facing endpoint (Design rule).

import Fastify from 'fastify';
import { loadConfig, assertServerConfig, RETRIEVAL_SURFACES } from '../config.mjs';

export async function createServer(db, graph, llmClient, { log } = {}) {
  const cfg = assertServerConfig(loadConfig());

  const app = Fastify({ logger: false });

  // Auth middleware: shared secret on every request
  app.addHook('onRequest', (req, reply, done) => {
    if (req.url === '/health') return done(); // health is public
    const token = req.headers['x-cortex-secret'] || req.headers.authorization?.replace('Bearer ', '');
    if (token !== cfg.secret) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    done();
  });

  // --- Provider endpoints (Hermes MemoryProvider) ---
  const { prefetch } = await import('../retrieval/prefetch.mjs');
  const { prepareL0 } = await import('../storage/l0.mjs');
  const { prepareSlots } = await import('../storage/slots.mjs');

  const l0 = prepareL0(db);
  const slots = prepareSlots(db);

  app.post('/provider/prefetch', {
    schema: {
      body: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          messages: { type: 'array', items: { type: 'string' } },
          context_remaining: { type: 'number' },
        },
        required: ['agent', 'messages'],
      },
    },
  }, async (req) => {
    const result = prefetch(db, graph, {
      agent: req.body.agent,
      lastMessages: req.body.messages,
      contextRemaining: req.body.context_remaining,
    });
    // Deferred touch: update access_count AFTER responding (not on hot path).
    if (result.touchIds?.length) {
      const touchStmt = db.prepare('UPDATE l2_semantic SET access_count=access_count+1, last_accessed=? WHERE id=?');
      const now = Date.now();
      for (const id of result.touchIds) touchStmt.run(now, id);
      // Store injected facts server-side for C1 measurement at next sync
      const injectedFacts = result.touchIds.map((id) => {
        const f = db.prepare('SELECT id, fact_text FROM l2_semantic WHERE id=?').get(id);
        return f;
      }).filter(Boolean);
      _lastInjected.set(req.body.agent, injectedFacts);
    }
    return result;
  });

  const { measureUtilization } = await import('../cognitive/c1-utilization.mjs');
  const { onFactUtilized, onFactIgnored } = await import('../cognitive/r2-shadow.mjs');
  const { checkMetamemory } = await import('../cognitive/c3-metamemory.mjs');

  // Server-side injected-facts tracking per agent (C1 needs to know what was injected)
  const _lastInjected = new Map(); // agent → [{id, fact_text}]

  app.post('/provider/sync', {
    schema: {
      body: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          session: { type: 'string' },
          type: { type: 'string' },
          source_type: { type: 'string' },
          content: { type: 'string' },
          entities: { type: 'array', items: { type: 'string' } },
          injected_fact_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['agent', 'session', 'content'],
      },
    },
  }, async (req) => {
    const result = l0.insert(req.body);
    // Touch graph nodes for accessed entities
    if (req.body.entities) {
      for (const e of req.body.entities) {
        for (const [id, node] of graph.nodes) {
          if (node.label.toLowerCase() === e.toLowerCase()) graph.touchNode(id, req.body.agent);
        }
      }
    }
    // Heartbeat active slot
    slots.set(req.body.agent, 'session_context', { session: req.body.session, ts: Date.now() });
    // C1 utilization measurement (observational — does not affect retrieval)
    // Uses server-side _lastInjected from most recent prefetch for this agent.
    const injected = _lastInjected.get(req.body.agent);
    if (injected?.length && req.body.content && req.body.source_type === 'agent_internal') {
      try {
        const c1 = measureUtilization(db, { injectedFacts: injected, responseText: req.body.content });
        // R2 shadow deltas based on C1 utilization
        for (const f of injected) {
          const wasUsed = c1.used > 0; // C1 already computed per-fact detail overlap
          if (wasUsed) onFactUtilized(db, f.id);
          else onFactIgnored(db, f.id);
        }
      } catch { /* C1/R2 errors must not break sync */ }
    }
    return result;
  });

  // /provider/compress — returns L1 summaries for in-session window compaction.
  const { findProtectBoundary, assembleWindow } = await import('../compaction/window.mjs');
  const { prepareL1 } = await import('../storage/l1.mjs');
  const l1 = prepareL1(db);

  app.post('/provider/compress', {
    schema: {
      body: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          session: { type: 'string' },
          turns: { type: 'array', items: { type: 'object' } },
          protect_tokens: { type: 'number' },
        },
        required: ['agent', 'turns'],
      },
    },
  }, async (req) => {
    const { protect, candidates } = findProtectBoundary(req.body.turns, req.body.protect_tokens);
    const l1Ids = new Set(candidates.map((t) => t.l1_id).filter(Boolean));
    const l1Summaries = new Map();
    for (const id of l1Ids) {
      const row = l1.getById(id);
      if (row) l1Summaries.set(id, row);
    }
    const result = assembleWindow(candidates, protect, l1Summaries);
    return result;
  });

  const { runDreaming } = await import('../consolidation/dreaming.mjs');

  app.post('/provider/session_end', {
    schema: { body: { type: 'object', properties: { agent: { type: 'string' }, session: { type: 'string' } }, required: ['agent', 'session'] } },
  }, async (req) => {
    const dreamResult = await runDreaming(db, llmClient, {
      agent: req.body.agent,
      session: req.body.session,
      log: (...args) => {},
    }).catch(() => ({ insights: 0 }));
    return { status: 'session_end_acknowledged', agent: req.body.agent, dreaming: dreamResult };
  });

  // --- MCP endpoints (L2-only — Design rule) ---
  const { graphSearch } = await import('../retrieval/search.mjs');
  const { prepareL2 } = await import('../storage/l2.mjs');
  const l2 = prepareL2(db, graph);

  // /mcp/query — agent-facing pull retrieval (graph activation + full count-rule gate).
  // Uses same graphSearch engine as prefetch but with gateMode='full' (count-rule).
  // cortex_query tool calls this, NOT /mcp/search.
  app.post('/mcp/query', {
    schema: {
      body: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          agent: { type: 'string' },
        },
        required: ['query'],
      },
    },
  }, async (req) => {
    const result = graphSearch(db, graph, {
      query: req.body.query,
      agent: req.body.agent ?? (process.env.CORTEX_DEFAULT_AGENT || 'default'),
      gateMode: 'full',
      limit: req.body.limit ?? 10,
    });
    return {
      facts: result.facts.map((f) => ({
        id: f.id,
        text: f.fact_text,
        confidence: f.confidence,
        source_type: f.source_type,
        injection_status: f.injectionStatus,
      })),
      entity_count: result.entity_count,
      activated_nodes: result.activated_nodes,
      elapsed_ms: result.elapsed_ms,
    };
  });

  app.post('/mcp/search', {
    schema: { body: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  }, async (req) => {
    // L2-only (Design rule — no L0/L1 exposure)
    return l2.search(req.body.query, req.body.limit ?? 10);
  });

  const { resolveRef } = await import('../cognitive/r1-page-fault.mjs');

  app.get('/mcp/fact/:id', async (req) => {
    let factId = req.params.id;
    // R1: resolve session-scoped ref_N aliases to real fact IDs
    if (factId.startsWith('ref_')) {
      const resolved = resolveRef(factId);
      if (resolved) factId = resolved;
    }
    const fact = l2.getById(factId);
    if (!fact) return { error: 'not_found' };
    l2.touchAccess(factId);
    return fact;
  });

  app.post('/mcp/remember', {
    schema: {
      body: {
        type: 'object',
        properties: { fact_text: { type: 'string' }, entities: { type: 'array' }, source_type: { type: 'string' } },
        required: ['fact_text'],
      },
    },
  }, async (req) => {
    return l2.insert({ ...req.body, prompt_hash: null, judge_model_id: null });
  });

  // --- Additional MCP endpoints ---

  app.post('/mcp/observe', {
    schema: {
      body: {
        type: 'object',
        properties: {
          agent: { type: 'string' }, session: { type: 'string' },
          type: { type: 'string' }, source_type: { type: 'string' },
          content: { type: 'string' }, entities: { type: 'array', items: { type: 'string' } },
        },
        required: ['agent', 'session', 'content'],
      },
    },
  }, async (req) => {
    return l0.insert(req.body);
  });

  app.get('/mcp/graph/neighbors/:nodeId', async (req) => {
    const edges = graph.getEdges(req.params.nodeId)
      .filter((e) => e.invalid_at == null)
      .map((e) => ({ target: e.target, relation: e.relation, weight: e.weight }));
    const node = graph.getNode(req.params.nodeId);
    return { node: node ? { id: req.params.nodeId, label: node.label, type: node.type } : null, edges };
  });

  app.get('/mcp/graph/activate', {
    schema: { querystring: { type: 'object', properties: { entities: { type: 'string' }, agent: { type: 'string' } } } },
  }, async (req) => {
    const { activate } = await import('../graph/activation.mjs');
    const { canonEntity } = await import('../graph/entities.mjs');
    const entities = (req.query.entities || '').split(',').map((e) => e.trim()).filter(Boolean);
    const seeds = [];
    for (const e of entities) {
      const canon = canonEntity(e);
      for (const [id, node] of graph.nodes) {
        if (canonEntity(node.label) === canon) { seeds.push({ id, score: 1.0 }); break; }
      }
    }
    const activated = activate(graph.nodes, graph.edges, seeds, req.query.agent);
    return activated.slice(0, 20).map((a) => ({ id: a.id, score: a.score, label: a.node?.label }));
  });

  app.get('/mcp/slots/:agent/:key', async (req) => {
    const row = db.prepare('SELECT value, updated_at FROM slots WHERE agent=? AND key=?').get(req.params.agent, req.params.key);
    if (!row) return { error: 'not_found' };
    return { key: req.params.key, value: JSON.parse(row.value), updated_at: row.updated_at };
  });

  app.put('/mcp/slots/:agent/:key', {
    schema: { body: { type: 'object', properties: { value: {} }, required: ['value'] } },
  }, async (req) => {
    slots.set(req.params.agent, req.params.key, req.body.value);
    return { status: 'ok' };
  });

  app.get('/mcp/timeline', {
    schema: { querystring: { type: 'object', properties: { entity: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, limit: { type: 'number' } } } },
  }, async (req) => {
    // /Inv 2: L2-only timeline (no L0/L1 exposure)
    let query = 'SELECT id, created_at, fact_text, entities, confidence FROM l2_semantic WHERE confidence > 0';
    const params = [];
    if (req.query.entity) {
      query += ' AND entities LIKE ?';
      params.push(`%${req.query.entity}%`);
    }
    if (req.query.from) { query += ' AND created_at >= ?'; params.push(req.query.from); }
    if (req.query.to) { query += ' AND created_at <= ?'; params.push(req.query.to); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(req.query.limit ?? 20);
    return db.prepare(query).all(...params);
  });

  // --- Admin ---
  app.get('/health', async () => ({
    status: 'ok',
    schema_version: db.prepare('SELECT MAX(version) v FROM schema_version').get().v,
    graph_nodes: graph.nodeCount(),
    uptime_ms: process.uptime() * 1000,
  }));

  app.get('/stats', async () => {
    const l0Count = db.prepare('SELECT COUNT(*) c FROM l0_raw').get().c;
    const l1Count = db.prepare('SELECT COUNT(*) c FROM l1_episodic').get().c;
    const l2Count = db.prepare('SELECT COUNT(*) c FROM l2_semantic').get().c;
    return { l0: l0Count, l1: l1Count, l2: l2Count, graph_nodes: graph.nodeCount() };
  });

  app.post('/admin/reload-graph', async () => {
    const { invalidateSearchCache } = await import('../retrieval/search.mjs');
    const loaded = graph.load();
    invalidateSearchCache();
    return { status: 'reloaded', nodes: loaded.nodes, edges: loaded.edges };
  });

  // L3 proposal management
  app.get('/admin/l3/pending', async () => {
    return db.prepare('SELECT id, agent, text, entities, confidence, pending, created_at FROM l3_rules WHERE pending = 1 ORDER BY created_at DESC').all();
  });

  app.post('/admin/l3/approve/:id', async (req) => {
    const result = db.prepare('UPDATE l3_rules SET pending = 0 WHERE id = ? AND pending = 1').run(req.params.id);
    return { status: result.changes > 0 ? 'approved' : 'not_found', id: req.params.id };
  });

  app.delete('/admin/l3/reject/:id', async (req) => {
    const result = db.prepare('DELETE FROM l3_rules WHERE id = ? AND pending = 1').run(req.params.id);
    return { status: result.changes > 0 ? 'rejected' : 'not_found', id: req.params.id };
  });

  // Supersession admin endpoints (approve/skip via agent tools)
  app.post('/admin/supersession/apply/:vid', async (req) => {
    const sv = db.prepare('SELECT fact_a, fact_b FROM scan_verdicts WHERE id = ?').get(req.params.vid);
    if (!sv) return { status: 'not_found' };
    db.prepare("UPDATE l2_semantic SET confidence = 0, contradicted_by = ? WHERE id = ? AND confidence > 0")
      .run('superseded:' + sv.fact_b, sv.fact_a);
    db.prepare("INSERT OR IGNORE INTO scan_verdicts_applied (verdict_id, applied_at, action) VALUES (?, ?, ?)")
      .run(req.params.vid, Date.now(), 'owner_approve');
    return { status: 'applied', verdict_id: req.params.vid };
  });

  app.post('/admin/supersession/skip/:vid', async (req) => {
    db.prepare("INSERT OR IGNORE INTO scan_verdicts_applied (verdict_id, applied_at, action) VALUES (?, ?, ?)")
      .run(req.params.vid, Date.now(), 'owner_skip');
    return { status: 'skipped', verdict_id: req.params.vid };
  });

  // Telegram callback handler (inline keyboard button taps)
  const { handleCallback } = await import('../notifications/telegram.mjs');
  app.post('/webhook/telegram', async (req) => {
    const cb = req.body?.callback_query;
    if (!cb?.data) return { ok: false };
    const result = handleCallback(db, cb.data);
    // Answer callback to remove loading spinner in Telegram
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: result }),
      }).catch(() => {});
    }
    return { ok: true, result };
  });

  // Force-trigger consolidation (don't wait for croner schedule).
  // Runs in background — returns immediately, consolidation continues async.
  app.post('/admin/consolidate', async (req) => {
    const modules = req.body?.modules ?? ['l0l1', 'l1l2'];
    // Fire-and-forget: don't block HTTP response on long consolidation
    setImmediate(async () => {
      try {
        if (modules.includes('l0l1')) {
          const { runL0ToL1 } = await import('../consolidation/l0-to-l1.mjs');
          await runL0ToL1(db, llmClient, { log: (...a) => console.log('consolidate:l0l1', ...a) });
        }
        if (modules.includes('l1l2')) {
          const { runL1ToL2 } = await import('../consolidation/l1-to-l2.mjs');
          await runL1ToL2(db, llmClient, { graph, log: (...a) => console.log('consolidate:l1l2', ...a) });
        }
        if (modules.includes('l2l3')) {
          const { runL2ToL3 } = await import('../consolidation/l2-to-l3.mjs');
          await runL2ToL3(db, llmClient, { log: (...a) => console.log('consolidate:l2l3', ...a) });
        }
        const { invalidateSearchCache } = await import('../retrieval/search.mjs');
        graph.load();
        invalidateSearchCache();
        console.log('consolidate: done', modules);
      } catch (e) { console.error('consolidate error:', e.message); }
    });
    return { status: 'consolidation_started', modules };
  });

  await app.listen({ host: cfg.bindHost, port: cfg.port });
  return app;
}
