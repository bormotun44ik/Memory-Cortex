#!/usr/bin/env node
// Memory-Cortex CLI — single entry point for all operations.
// Usage: cortex <command> [options]

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');

// --- .env loader (no dependencies) ---
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// --- ANSI helpers ---
const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// --- Arg parsing ---
const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

// --- Config ---
function getConfig() {
  return {
    dbPath: process.env.CORTEX_DB_PATH || join(ROOT, 'data', 'cortex.db'),
    host: process.env.CORTEX_BIND_HOST || '127.0.0.1',
    port: Number(process.env.CORTEX_PORT || 7100),
    secret: process.env.CORTEX_SECRET || '',
    agent: process.env.CORTEX_DEFAULT_AGENT || 'default',
  };
}

// --- Commands ---

async function cmdInit() {
  const cfg = getConfig();
  const dir = dirname(cfg.dbPath);
  mkdirSync(dir, { recursive: true });

  const { migrate } = await import(join(ROOT, 'scripts', 'migrate.mjs'));
  const db = migrate(cfg.dbPath);
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  db.close();

  console.log(C.green('Database initialized'));
  console.log(`  path: ${cfg.dbPath}`);
  console.log(`  schema: v${v}`);
}

async function cmdStart() {
  console.log(C.cyan('Starting Memory-Cortex daemon...'));
  await import(join(ROOT, 'src', 'daemon.mjs'));
}

async function cmdStatus() {
  const cfg = getConfig();
  const url = `http://${cfg.host}:${cfg.port}/health`;
  try {
    const res = await fetch(url, {
      headers: cfg.secret ? { 'Authorization': `Bearer ${cfg.secret}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(C.green('Daemon running'));
    console.log(`  schema: v${data.schema_version}`);
    console.log(`  graph:  ${data.graph_nodes} nodes`);
    console.log(`  uptime: ${Math.round(data.uptime_ms / 60000)} min`);

    const statsRes = await fetch(`http://${cfg.host}:${cfg.port}/stats`, {
      headers: cfg.secret ? { 'Authorization': `Bearer ${cfg.secret}` } : {},
    });
    if (statsRes.ok) {
      const stats = await statsRes.json();
      console.log(`  L0:     ${stats.l0} records`);
      console.log(`  L1:     ${stats.l1} episodes`);
      console.log(`  L2:     ${stats.l2} facts`);
    }
  } catch {
    console.log(C.red(`Daemon not running on ${cfg.host}:${cfg.port}`));
    try {
      const Database = (await import('better-sqlite3')).default;
      if (!existsSync(cfg.dbPath)) {
        console.log(C.dim(`  No database at ${cfg.dbPath}. Run: cortex init`));
        return;
      }
      const db = new Database(cfg.dbPath, { readonly: true });
      const l0 = db.prepare('SELECT count(*) c FROM l0_raw').get().c;
      const l1 = db.prepare('SELECT count(*) c FROM l1_episodic').get().c;
      const l2 = db.prepare('SELECT count(*) c FROM l2_semantic').get().c;
      const nodes = db.prepare('SELECT count(*) c FROM graph_nodes').get().c;
      db.close();
      console.log(C.dim('  Database exists (daemon offline):'));
      console.log(`  L0: ${l0} | L1: ${l1} | L2: ${l2} | Graph: ${nodes} nodes`);
    } catch { /* no DB yet */ }
  }
}

async function cmdImport() {
  const target = args[1];
  if (!target) {
    console.log(C.red('Usage: cortex import <path> [--format auto|json|jsonl|markdown|chat] [--agent name] [--source-type type]'));
    process.exit(1);
  }
  const targetPath = resolve(target);
  if (!existsSync(targetPath)) {
    console.log(C.red(`Path not found: ${targetPath}`));
    process.exit(1);
  }

  const cfg = getConfig();
  if (!existsSync(cfg.dbPath)) {
    console.log(C.red(`Database not found at ${cfg.dbPath}. Run: cortex init`));
    process.exit(1);
  }

  const { migrate } = await import(join(ROOT, 'scripts', 'migrate.mjs'));
  const db = migrate(cfg.dbPath);
  const { prepareL0 } = await import(join(ROOT, 'src', 'storage', 'l0.mjs'));
  const l0 = prepareL0(db);

  const { runImport } = await import(join(ROOT, 'src', 'cli', 'import.mjs'));
  const format = flag('format') ?? 'auto';
  const agent = flag('agent') ?? cfg.agent;
  const sourceType = flag('source-type') ?? 'user_authored';

  await runImport(db, l0, targetPath, { format, agent, sourceType });
  db.close();
}

async function cmdConsolidate() {
  const module = args[1] ?? flag('module') ?? 'all';
  const cfg = getConfig();

  const url = `http://${cfg.host}:${cfg.port}/admin/consolidate`;
  const modules = module === 'all' ? ['l0l1', 'l1l2'] : [module];
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.secret ? { 'Authorization': `Bearer ${cfg.secret}` } : {}),
      },
      body: JSON.stringify({ modules }),
    });
    if (res.ok) {
      console.log(C.green(`Consolidation started: ${modules.join(', ')}`));
      console.log(C.dim('Running in background on daemon. Check logs for progress.'));
      return;
    }
  } catch { /* daemon not available */ }

  console.log(C.yellow('Daemon not available, running directly...'));
  if (!existsSync(cfg.dbPath)) {
    console.log(C.red(`Database not found at ${cfg.dbPath}. Run: cortex init`));
    process.exit(1);
  }

  const { getDb } = await import(join(ROOT, 'src', 'storage', 'db.mjs'));
  const { createLlmClient } = await import(join(ROOT, 'src', 'llm', 'client.mjs'));
  const db = getDb(cfg.dbPath);
  const llm = createLlmClient();

  if (module === 'all' || module === 'l0l1') {
    console.log(C.cyan('Running L0 → L1...'));
    const { runL0ToL1 } = await import(join(ROOT, 'src', 'consolidation', 'l0-to-l1.mjs'));
    const r = await runL0ToL1(db, llm);
    console.log(`  ${r.groups} groups → ${r.l1_created} L1 records`);
  }
  if (module === 'all' || module === 'l1l2') {
    console.log(C.cyan('Running L1 → L2...'));
    const { runL1ToL2 } = await import(join(ROOT, 'src', 'consolidation', 'l1-to-l2.mjs'));
    const { GraphStore } = await import(join(ROOT, 'src', 'graph', 'store.mjs'));
    const graph = new GraphStore(db);
    graph.load();
    await runL1ToL2(db, llm, { graph });
  }

  console.log(C.green('Consolidation complete.'));
}

async function cmdExport() {
  const level = args[1] ?? flag('level') ?? 'l2';
  const cfg = getConfig();
  if (!existsSync(cfg.dbPath)) {
    console.log(C.red(`Database not found at ${cfg.dbPath}. Run: cortex init`));
    process.exit(1);
  }
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(cfg.dbPath, { readonly: true });

  let rows;
  switch (level) {
    case 'l0':
      rows = db.prepare('SELECT id, ts, session, agent, type, source_type, content, entities FROM l0_raw ORDER BY ts').all();
      break;
    case 'l1':
      rows = db.prepare('SELECT id, ts, session, agent, summary_text, source_type, entities FROM l1_episodic ORDER BY ts').all();
      break;
    case 'l2':
      rows = db.prepare('SELECT id, fact_text, confidence, source_type, entities, scope, created_at FROM l2_semantic WHERE confidence > 0 ORDER BY created_at').all();
      break;
    case 'graph': {
      const nodes = db.prepare('SELECT id, label, weight, evidence_count, aliases FROM graph_nodes').all();
      const edges = db.prepare('SELECT source_id, target_id, weight, evidence_count FROM graph_edges').all();
      rows = { nodes, edges };
      break;
    }
    default:
      console.error(C.red(`Unknown level: ${level}. Use: l0, l1, l2, graph`));
      db.close();
      process.exit(1);
  }

  db.close();
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

async function cmdSeed() {
  const cfg = getConfig();
  if (!existsSync(cfg.dbPath)) {
    console.log(C.yellow('No database found, initializing...'));
    await cmdInit();
  }

  const { migrate } = await import(join(ROOT, 'scripts', 'migrate.mjs'));
  const db = migrate(cfg.dbPath);
  const { prepareL0 } = await import(join(ROOT, 'src', 'storage', 'l0.mjs'));
  const l0 = prepareL0(db);

  const DEMO = [
    { content: 'Set up PostgreSQL 16 on Ubuntu 24.04 with WAL archiving. Config: max_connections=200, shared_buffers=4GB, wal_level=replica.', type: 'exchange', source_type: 'user_authored', entities: ['PostgreSQL', 'Ubuntu', 'WAL'] },
    { content: 'Deployed Redis 7.2 as session cache. Eviction: allkeys-lru, maxmemory 2GB. Persistence: RDB every 300s + AOF appendfsync everysec.', type: 'exchange', source_type: 'user_authored', entities: ['Redis'] },
    { content: "Nginx reverse proxy configured: upstream backend on port 8080, SSL via Let's Encrypt certbot, HTTP/2 enabled. Gzip on text/html and application/json.", type: 'exchange', source_type: 'tool_result', entities: ['nginx', 'certbot'] },
    { content: 'Docker Compose stack: web (Node 20), api (Python 3.12 FastAPI), db (PostgreSQL 16), cache (Redis 7.2). Networks: frontend, backend.', type: 'exchange', source_type: 'user_authored', entities: ['Docker', 'FastAPI', 'PostgreSQL', 'Redis'] },
    { content: 'CI/CD pipeline: GitHub Actions → build → test → deploy to AWS ECS Fargate. Blue/green deployment with ALB target groups. Rollback on health check failure.', type: 'exchange', source_type: 'tool_result', entities: ['GitHub Actions', 'AWS', 'ECS'] },
    { content: 'Monitoring: Prometheus scrapes /metrics every 15s. Grafana dashboards for request latency (p99 < 200ms target), error rate, CPU/memory.', type: 'exchange', source_type: 'user_authored', entities: ['Prometheus', 'Grafana'] },
    { content: 'Database migration strategy: numbered SQL files (0001_init.sql, 0002_add_users.sql). Custom runner tracks applied versions in schema_version table.', type: 'exchange', source_type: 'user_authored', entities: ['migration', 'database'] },
    { content: 'Auth: JWT access tokens (15min TTL) + refresh tokens (7d, stored in Redis). PBKDF2 password hashing, 600K iterations. Rate limit: 5 login attempts / 15 min / IP.', type: 'exchange', source_type: 'tool_result', entities: ['JWT', 'Redis'] },
    { content: 'Backup strategy: pg_dump daily at 03:00 UTC → S3 with 30-day lifecycle. WAL archiving for point-in-time recovery. Monthly restore test.', type: 'exchange', source_type: 'user_authored', entities: ['backup', 'PostgreSQL', 'S3'] },
    { content: 'Load test results (k6, 500 VUs, 10 min): p50=45ms, p95=120ms, p99=280ms. Bottleneck: DB connection pool (20 → 50). Zero errors after fix.', type: 'exchange', source_type: 'tool_result', entities: ['k6', 'database'] },
  ];

  const session = `demo:seed:${new Date().toISOString().slice(0, 10)}`;
  let imported = 0;
  for (const rec of DEMO) {
    l0.insert({ ...rec, ts: Date.now() - (DEMO.length - imported) * 60000, session, agent: cfg.agent });
    imported++;
  }
  console.log(C.green(`Seeded ${imported} L0 records`));

  console.log(C.cyan('Running consolidation (requires LLM backend)...'));
  try {
    const { createLlmClient } = await import(join(ROOT, 'src', 'llm', 'client.mjs'));
    const llm = createLlmClient();
    const { runL0ToL1 } = await import(join(ROOT, 'src', 'consolidation', 'l0-to-l1.mjs'));
    const r1 = await runL0ToL1(db, llm);
    console.log(`  L0 → L1: ${r1.l1_created} episodes`);

    if (r1.l1_created > 0) {
      const { runL1ToL2 } = await import(join(ROOT, 'src', 'consolidation', 'l1-to-l2.mjs'));
      const { GraphStore } = await import(join(ROOT, 'src', 'graph', 'store.mjs'));
      const graph = new GraphStore(db);
      graph.load();
      await runL1ToL2(db, llm, { graph });

      const l2Count = db.prepare('SELECT count(*) c FROM l2_semantic WHERE confidence > 0').get().c;
      const nodeCount = db.prepare('SELECT count(*) c FROM graph_nodes').get().c;
      console.log(C.green(`  L2: ${l2Count} facts, Graph: ${nodeCount} nodes`));
    }
  } catch (e) {
    console.log(C.yellow(`  Consolidation skipped: ${e.message?.slice(0, 100)}`));
    console.log(C.dim('  Configure CORTEX_LLM_BACKEND and API key, then run: cortex consolidate'));
  }

  db.close();
}

async function cmdMcp() {
  console.log(C.cyan('Starting MCP server (stdio)...'));
  try {
    await import(join(ROOT, 'src', 'mcp', 'server.mjs'));
  } catch (e) {
    console.error(C.red(`MCP server failed: ${e.message}`));
    console.log(C.dim('Ensure @modelcontextprotocol/sdk is installed: npm install'));
    process.exit(1);
  }
}

// --- Help ---
function printHelp() {
  console.log(`
${C.bold('Memory-Cortex')} — brain-like memory for AI agents

${C.bold('Usage:')} cortex <command> [options]

${C.bold('Commands:')}
  ${C.cyan('init')}                        Initialize database and run migrations
  ${C.cyan('start')}                       Start the daemon (HTTP + croner)
  ${C.cyan('status')}                      Show daemon status and memory stats
  ${C.cyan('import')} <path>               Import data to L0 (json/jsonl/markdown/chat)
  ${C.cyan('consolidate')} [module]        Run consolidation (l0l1, l1l2, or all)
  ${C.cyan('export')} [level]              Export data as JSON (l0, l1, l2, graph)
  ${C.cyan('seed')}                        Populate with demo data
  ${C.cyan('mcp')}                         Start MCP server (stdio transport)

${C.bold('Import options:')}
  --format <auto|json|jsonl|markdown|chat>   File format (default: auto-detect)
  --agent <name>                             Agent name (default: $CORTEX_DEFAULT_AGENT)
  --source-type <type>                       Trust level (default: user_authored)

${C.bold('Environment:')}
  CORTEX_DB_PATH          Database path (default: ./data/cortex.db)
  CORTEX_SECRET           Auth secret for HTTP API
  CORTEX_BIND_HOST        Bind address (default: 127.0.0.1)
  CORTEX_PORT             HTTP port (default: 7100)
  CORTEX_DEFAULT_AGENT    Default agent name (default: "default")
  CORTEX_LLM_BACKEND      LLM provider: anthropic, openrouter, openai (default: anthropic)
  ANTHROPIC_API_KEY       API key for Anthropic direct
  OPENROUTER_API_KEY      API key for OpenRouter
  CORTEX_LLM_URL          OpenAI-compat base URL (for openai backend)
  CORTEX_LLM_KEY          API key for openai backend
  CORTEX_WORKER_MODEL     Worker model (default: claude-haiku-4-5-20251001)
  CORTEX_JUDGE_MODEL      Judge model (default: claude-sonnet-4-6)

${C.bold('Quick start:')}
  cortex init && cortex seed && cortex start

${C.bold('Claude Code integration:')}
  cortex hooks install     Install push/pull/compress hooks into Claude Code
  cortex hooks status      Show installed hooks
  cortex hooks remove      Remove Cortex hooks from Claude Code
`);
}

// --- Hooks management ---
async function cmdHooks() {
  const sub = args[1] || 'status';
  const hooksDir = join(ROOT, 'hooks');
  const settingsPath = join(ROOT, '.claude', 'settings.json');
  const globalSettings = join(process.env.HOME || '', '.claude', 'settings.json');

  const target = existsSync(join(ROOT, '.claude'))
    ? settingsPath
    : globalSettings;

  if (sub === 'install') {
    mkdirSync(dirname(settingsPath), { recursive: true });
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    }
    if (!settings.hooks) settings.hooks = {};

    const cortexEnv = [
      `CORTEX_URL=http://${process.env.BIND_HOST || '127.0.0.1'}:${process.env.PORT || '7100'}`,
      `CORTEX_SECRET=${process.env.CORTEX_SECRET || 'changeme'}`,
      `CORTEX_DEFAULT_AGENT=${process.env.CORTEX_DEFAULT_AGENT || 'default'}`,
    ].join(' ');

    const hooks = {
      UserPromptSubmit: [{
        hooks: [{
          type: 'command',
          command: `${cortexEnv} node ${join(hooksDir, 'prefetch.mjs')}`,
          timeout: 5,
        }],
      }],
      Stop: [{
        hooks: [{
          type: 'command',
          command: `${cortexEnv} node ${join(hooksDir, 'sync.mjs')}`,
          timeout: 10,
          async: true,
        }],
      }],
      PreCompact: [{
        hooks: [{
          type: 'command',
          command: `${cortexEnv} node ${join(hooksDir, 'precompact.mjs')}`,
          timeout: 30,
        }],
      }],
    };

    for (const [event, config] of Object.entries(hooks)) {
      if (!settings.hooks[event]) settings.hooks[event] = [];
      const existing = settings.hooks[event].find(
        (h) => h.hooks?.[0]?.command?.includes('memory-cortex') || h.hooks?.[0]?.command?.includes('cortex')
      );
      if (existing) {
        const idx = settings.hooks[event].indexOf(existing);
        settings.hooks[event][idx] = config[0];
      } else {
        settings.hooks[event].push(config[0]);
      }
    }

    const { writeFileSync } = await import('node:fs');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(C.green('Hooks installed to ') + settingsPath);
    console.log('  UserPromptSubmit → prefetch (push memory before each turn)');
    console.log('  Stop             → sync (record exchanges to L0)');
    console.log('  PreCompact       → precompact (save context before compression)');
    console.log(`\nRestart Claude Code to activate.`);
    return;
  }

  if (sub === 'remove') {
    if (!existsSync(settingsPath)) {
      console.log('No project settings found.');
      return;
    }
    let settings = {};
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    if (settings.hooks) {
      for (const event of ['UserPromptSubmit', 'Stop', 'PreCompact']) {
        if (settings.hooks[event]) {
          settings.hooks[event] = settings.hooks[event].filter(
            (h) => !h.hooks?.[0]?.command?.includes('cortex')
          );
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    const { writeFileSync } = await import('node:fs');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(C.green('Cortex hooks removed from ') + settingsPath);
    return;
  }

  // status
  const paths = [settingsPath, globalSettings].filter(existsSync);
  if (paths.length === 0) {
    console.log('No Claude Code settings found. Run ' + C.bold('cortex hooks install'));
    return;
  }
  for (const p of paths) {
    let s = {};
    try { s = JSON.parse(readFileSync(p, 'utf8')); } catch {}
    const hooks = s.hooks || {};
    const cortexHooks = [];
    for (const [event, cfgs] of Object.entries(hooks)) {
      for (const cfg of cfgs) {
        if (cfg.hooks?.[0]?.command?.includes('cortex')) {
          cortexHooks.push(`  ${event} → ${cfg.hooks[0].command.split('/').pop()}`);
        }
      }
    }
    if (cortexHooks.length > 0) {
      console.log(C.bold(p) + ':');
      cortexHooks.forEach((h) => console.log(h));
    } else {
      console.log(C.dim(p) + ': no Cortex hooks');
    }
  }
}

// --- Dispatch ---
const COMMANDS = {
  init: cmdInit,
  start: cmdStart,
  status: cmdStatus,
  import: cmdImport,
  consolidate: cmdConsolidate,
  export: cmdExport,
  seed: cmdSeed,
  mcp: cmdMcp,
  hooks: cmdHooks,
  help: printHelp,
  '--help': printHelp,
  '-h': printHelp,
};

if (!command || !COMMANDS[command]) {
  if (command) console.log(C.red(`Unknown command: ${command}\n`));
  printHelp();
  process.exit(command ? 1 : 0);
}

try {
  await COMMANDS[command]();
} catch (e) {
  console.error(C.red(`Error: ${e.message}`));
  if (hasFlag('verbose')) console.error(e.stack);
  process.exit(1);
}
