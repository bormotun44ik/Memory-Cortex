// Generic import logic for Memory-Cortex CLI.
// Supports: JSON arrays, JSONL, Markdown (semantic chunking), chat logs.
// All paths produce L0 records via prepareL0().

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const CHUNK_MAX = 6000;
const CHUNK_OVERLAP = 200;

// --- Entity extraction (self-contained, no dependency on graph/entities.mjs) ---

const CASE_SENSITIVE_RE = /(?:\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|\b[A-Z][A-Z0-9_]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\/[\w\-.\/]{3,}(?:\.\w+)?\b|\b\d+\.\d+(?:\.\d+)+\b)/g;
const KNOWN_NAMES_RE = /\b(?:node\.?js|npm|python|pip|docker|systemd|nginx|redis|postgres|mysql|sqlite|fastify|express|react|vue|angular|typescript|webpack|vite|git|github|gitlab|aws|gcp|azure|kubernetes|terraform|ansible|grafana|prometheus|elasticsearch|kafka|rabbitmq|mongodb|graphql|rest|grpc|openai|anthropic|claude|hermes|ollama|langchain)\b/gi;
const GENERIC_VOCAB_RE = /\b(?:server|network|backup|port|config|proxy|tunnel|firewall|deploy|disk|certificate|database|daemon|cron|migration|cluster|replica|snapshot|container|volume|route|gateway|endpoint|middleware|cache|queue|worker|scheduler|socket|pipeline|monitor|webhook|secret|credential|token|session)\b/gi;
const STOP_CAPS = new Set(['API', 'HTTP', 'HTTPS', 'JSON', 'SQL', 'SSH', 'DNS', 'TCP', 'UDP', 'URL', 'SSL', 'TLS', 'HTML', 'CSS', 'RAM', 'CPU', 'GPU', 'SSD', 'UUID', 'CLI', 'SDK', 'MCP', 'LLM', 'VPN', 'VPS', 'ORM', 'EOF', 'ENV', 'GET', 'PUT', 'SET', 'RUN', 'POST', 'JWT', 'UTC', 'ISO', 'NOT', 'AND', 'THE', 'FOR', 'HAS', 'WAS', 'ARE', 'BUT', 'NULL', 'TRUE', 'FALSE', 'NONE']);

export function extractEntities(text) {
  const entities = new Set();
  for (const m of text.matchAll(CASE_SENSITIVE_RE)) {
    const raw = m[0];
    if (raw.length < 2 || raw.length > 60) continue;
    if (STOP_CAPS.has(raw.toUpperCase())) continue;
    if (/^\d+$/.test(raw)) continue;
    entities.add(raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  }
  for (const m of text.matchAll(KNOWN_NAMES_RE)) {
    entities.add(m[0].toLowerCase());
  }
  for (const m of text.matchAll(GENERIC_VOCAB_RE)) {
    if (m[0].length >= 3) entities.add(m[0].toLowerCase());
  }
  return [...entities].filter((e) => e.length >= 2);
}

// --- Markdown chunking ---

function chunkMarkdown(text) {
  if (text.length <= CHUNK_MAX) return [{ content: text, section: null, index: 0, total: 1 }];

  const sections = [];
  const headerRe = /^(#{1,3}\s+.+)$/gm;
  let lastIdx = 0;
  let lastTitle = null;
  for (const m of text.matchAll(headerRe)) {
    if (m.index > lastIdx) {
      sections.push({ title: lastTitle, text: text.slice(lastIdx, m.index) });
    }
    lastTitle = m[1].replace(/^#+\s*/, '').trim();
    lastIdx = m.index;
  }
  if (lastIdx < text.length) sections.push({ title: lastTitle, text: text.slice(lastIdx) });
  if (sections.length === 0) sections.push({ title: null, text });

  const chunks = [];
  for (const sec of sections) {
    if (sec.text.trim().length < 10) continue;
    if (sec.text.length <= CHUNK_MAX) {
      chunks.push({ content: sec.text.trim(), section: sec.title });
      continue;
    }
    const paras = sec.text.split(/\n\n+/);
    let buf = '';
    for (const p of paras) {
      if (buf.length + p.length + 2 > CHUNK_MAX && buf.length > 0) {
        chunks.push({ content: buf.trim(), section: sec.title });
        buf = buf.slice(-CHUNK_OVERLAP) + '\n\n' + p;
      } else {
        buf += (buf ? '\n\n' : '') + p;
      }
    }
    if (buf.trim()) chunks.push({ content: buf.trim(), section: sec.title });
  }

  const total = chunks.length;
  return chunks.map((c, i) => ({ ...c, index: i, total }));
}

// --- Format handlers ---
// Each returns an array of {content, session, type, source_type, entities, ts}

function importJson(filepath, opts) {
  const text = readFileSync(filepath, 'utf8');
  const data = JSON.parse(text);
  const records = Array.isArray(data) ? data : [data];
  return records.filter((r) => r.content || r.text || r.message).map((r) => ({
    content: r.content ?? r.text ?? r.message ?? JSON.stringify(r),
    session: `import:json:${basename(filepath)}`,
    type: r.type ?? 'exchange',
    source_type: opts.sourceType,
    entities: r.entities ?? extractEntities(r.content ?? r.text ?? ''),
    ts: r.ts ?? r.timestamp ?? r.created_at ?? Date.now(),
  }));
}

function importJsonl(filepath, opts) {
  const text = readFileSync(filepath, 'utf8');
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!r.content && !r.text && !r.message) continue;
      records.push({
        content: r.content ?? r.text ?? r.message ?? JSON.stringify(r),
        session: `import:jsonl:${basename(filepath)}`,
        type: r.type ?? 'exchange',
        source_type: opts.sourceType,
        entities: r.entities ?? extractEntities(r.content ?? r.text ?? ''),
        ts: r.ts ?? r.timestamp ?? r.created_at ?? Date.now(),
      });
    } catch { /* skip malformed lines */ }
  }
  return records;
}

function importMarkdown(filepath, opts) {
  const text = readFileSync(filepath, 'utf8');
  if (text.trim().length < 10) return [];

  const chunks = chunkMarkdown(text);
  const entities = extractEntities(text);
  const dateMatch = filepath.match(/(\d{4}-\d{2}-\d{2})/);
  const ts = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();

  return chunks.map((chunk) => {
    const prefix = chunk.total > 1
      ? `[doc:${basename(filepath)} | chunk ${chunk.index + 1}/${chunk.total}${chunk.section ? ` | ${chunk.section}` : ''}]\n\n`
      : '';
    return {
      content: prefix + chunk.content,
      session: `import:markdown:${basename(filepath)}`,
      type: 'document_chunk',
      source_type: opts.sourceType,
      entities,
      ts,
    };
  });
}

function importChat(filepath, opts) {
  const text = readFileSync(filepath, 'utf8');
  const data = JSON.parse(text);

  // Support [{role, content}] (OpenAI/Anthropic) and {messages: [{role, content}]}
  const messages = Array.isArray(data) ? data : (data.messages ?? []);
  const session = `import:chat:${basename(filepath)}`;

  return messages
    .filter((m) => m.content && typeof m.content === 'string' && m.content.trim().length >= 5)
    .map((m, i) => ({
      content: `[${m.role ?? 'unknown'}] ${m.content}`,
      session,
      type: 'exchange',
      source_type: m.role === 'user' ? 'user_authored' : opts.sourceType,
      entities: extractEntities(m.content),
      ts: m.timestamp ?? m.created_at ?? (Date.now() - (messages.length - i) * 1000),
    }));
}

// --- Format detection ---

function detectFormat(filepath) {
  const ext = extname(filepath).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.md' || ext === '.txt' || ext === '.markdown') return 'markdown';
  if (ext === '.json') {
    const text = readFileSync(filepath, 'utf8').trim();
    // Heuristic: if it starts with [ and items have "role" → chat
    try {
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : (data.messages ?? null);
      if (Array.isArray(items) && items.length > 0 && items[0].role) return 'chat';
    } catch { /* not valid json */ }
    return 'json';
  }
  return 'json';
}

// --- Directory walk ---

function walkFiles(dir, exts = ['.json', '.jsonl', '.ndjson', '.md', '.txt', '.markdown']) {
  const results = [];
  const extSet = new Set(exts);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) results.push(...walkFiles(p, exts));
      else if (entry.isFile() && extSet.has(extname(entry.name).toLowerCase())) results.push(p);
    }
  } catch { /* permission errors etc */ }
  return results;
}

// --- Main import function ---

const HANDLERS = { json: importJson, jsonl: importJsonl, markdown: importMarkdown, chat: importChat };

export async function runImport(db, l0, targetPath, { format = 'auto', agent = 'default', sourceType = 'user_authored', log = console.log } = {}) {
  const opts = { sourceType };
  let allRecords = [];

  const stat = statSync(targetPath);
  const files = stat.isDirectory() ? walkFiles(targetPath) : [targetPath];

  if (files.length === 0) {
    log('No importable files found.');
    return { imported: 0, skipped: 0 };
  }

  for (const filepath of files) {
    const fmt = format === 'auto' ? detectFormat(filepath) : format;
    const handler = HANDLERS[fmt];
    if (!handler) {
      log(`  skip ${filepath} (unknown format: ${fmt})`);
      continue;
    }
    try {
      const records = handler(filepath, opts);
      allRecords.push(...records);
      log(`  ${basename(filepath)}: ${records.length} records (${fmt})`);
    } catch (e) {
      log(`  ${basename(filepath)}: error — ${e.message}`);
    }
  }

  let imported = 0, skipped = 0, truncated = 0;
  for (const rec of allRecords) {
    if (!rec.content || rec.content.trim().length < 5) { skipped++; continue; }
    const result = l0.insert({
      ts: rec.ts ?? Date.now(),
      session: rec.session,
      agent,
      type: rec.type ?? 'exchange',
      source_type: rec.source_type ?? sourceType,
      content: rec.content,
      entities: rec.entities?.length > 0 ? rec.entities : undefined,
    });
    if (result.truncated) truncated++;
    imported++;
  }

  log(`\nImported ${imported} records to L0 (${skipped} skipped, ${truncated} truncated)`);
  return { imported, skipped, truncated };
}
