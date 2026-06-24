// Memory-Cortex configuration (+ anchors).
// Canonical: docs/memory-cortex-architecture.md, BLOCKERS-FIRST.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const DEFAULTS = Object.freeze({
  bindHost: '127.0.0.1', // loopback-only default — :7100 must never listen on a public IP in v0
  port: 7100,
  dbPath: './data/cortex.db',
});

export function loadConfig(env = process.env) {
  return {
    bindHost: env.CORTEX_BIND_HOST || DEFAULTS.bindHost,
    port: Number(env.CORTEX_PORT || DEFAULTS.port),
    dbPath: env.CORTEX_DB_PATH || DEFAULTS.dbPath,
    // shared env secret. v0 auth = loopback + this secret on every HTTP surface.
    // Per-agent HMAC is deliberately deferred to v1 (multi-host) — see .
    secret: env.CORTEX_SECRET || null,
    allowNonLoopback: env.CORTEX_ALLOW_NONLOOPBACK === '1',
  };
}

// Called by the daemon entrypoint before binding. Not used by offline scripts
export function assertServerConfig(cfg) {
  if (!cfg.secret) {
    throw new Error('CORTEX_SECRET is required (shared env secret, no unauthenticated surface)');
  }
  if (!LOOPBACK_HOSTS.has(cfg.bindHost) && !cfg.allowNonLoopback) {
    throw new Error(
      `Refusing to bind non-loopback host "${cfg.bindHost}". ` +
      'Set CORTEX_ALLOW_NONLOOPBACK=1 only with a real auth story (v1 multi-host).'
    );
  }
  return cfg;
}

//  + RELABEL A — retrieval-surface exposure contract.
// The api module MUST consult this map; violating it is a bug, not a tradeoff:
//   - L0 raw events are NEVER exposed via any agent-facing endpoint.
//   - L1 enters an agent's OWN live window via /provider/compress only (same-session).
//   - /mcp/search and /mcp/timeline serve L2 ONLY (membership-inference defense).
export const RETRIEVAL_SURFACES = Object.freeze({
  'provider/prefetch': 'l2-only',
  'provider/compress': 'l1-own-session',
  'mcp/search': 'l2-only',
  'mcp/timeline': 'l2-only',
  'mcp/query': 'l2-only',
  'mcp/fact': 'l2-only',
});
