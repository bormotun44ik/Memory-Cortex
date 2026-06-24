// Lexical primitives for the evaluation harness — zero LLM, zero embeddings ().
// Token heuristic, 4-gram leakage containment, artifact extraction (LBDR targets),
// regex salience (mirrors the write-time scorer the spine will use; same bands).

import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';

export const estTokens = (s) => Math.round(Buffer.byteLength(s, 'utf8') / 4); // stated RU bias (heuristic)

export const sha16 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

export function ulid(prefix) {
  // Sortable-enough id, dependency-free (repo convention: "<prefix>_<id>")
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

// Word tokens: RU/EN letters + digits, lowercased (FTS-style unicode word chars)
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_.\-:/]*/gu;
export const words = (s) => (s.toLowerCase().match(WORD_RE) ?? []);

export function ngramSet(tokens, n = 4) {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

// Leakage guard (no-embeddings v0): share of the QA's word 4-grams contained in
// the protected corpus. 0 when the QA has fewer than n words.
export function containment(qaText, protectedGrams, n = 4) {
  const qa = ngramSet(words(qaText), n);
  if (qa.size === 0) return 0;
  let shared = 0;
  for (const g of qa) if (protectedGrams.has(g)) shared++;
  return shared / qa.size;
}

// Load-bearing artifact extraction (LBDR targets): code values / paths / ports /
// numbers / commands — step 4 list, deterministic.
const ARTIFACT_RES = [
  /(?:^|[\s"'`(=])(\/[\w@.\-/]{2,})/g,               // absolute paths
  /\b[\w.\-]+\.(?:mjs|js|ts|tsx|json|sql|sh|py|rs|toml|yaml|yml|md|service|db|jsonl|env|conf|lock)\b/gi, // filenames
  /\bhttps?:\/\/[^\s"'`)>\]]+/gi,                    // URLs
  /(?<=[\s:])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, // IPs
  /(?<=\w):\d{2,5}\b/g,                              // :ports
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,              // ENV_VARS / CONSTANTS — underscore required
                                                     // (scoring v2: bare CAPS words like GREEN/YELLOW are noise, not artifacts)
  /\b[0-9a-f]{7,40}\b/gi,                            // hashes / hex ids
  /\b\d+(?:\.\d+)?(?:%|ms|s|mb|gb|kb|k|d|h)\b/gi,    // numbers with units
  /`([^`\n]{2,80})`/g,                               // backticked commands/values
];

export function extractArtifacts(text, cap = 8) {
  const found = [];
  const seen = new Set();
  for (const re of ARTIFACT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const a = (m[1] ?? m[0]).trim();
      const key = a.toLowerCase();
      if (a.length < 2 || a.length > 120 || seen.has(key)) continue;
      seen.add(key);
      found.push(a);
      if (found.length >= cap) return found;
    }
  }
  return found;
}

// LBDR: substring match of gold artifacts inside the answer on a canonical
// punctuation-free form (scoring v2): ":5432" matches "5432", ":5432"
// contains "5432" as a token run. Lowercased, every non-alphanumeric run -> one space.
const canon = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function lbdr(goldArtifacts, answerText) {
  const hay = ` ${canon(answerText)} `;
  let hits = 0;
  for (const a of goldArtifacts) {
    const c = canon(a);
    if (c && hay.includes(` ${c} `)) hits++;
  }
  return { hits, total: goldArtifacts.length };
}

// Write-time salience bands from the v0 schema (errors 0.9, config 0.8, code 0.7),
// RU/EN markers — mirrors what the spine's regex scorer will do.
const SALIENCE_BANDS = [
  [0.9, /\b(error|fail(?:ed|ure)?|exception|fatal|panic|refused|denied|critical|crash)\b|ошибк|сбо[йя]|упал|слома|не работает|отказ/i],
  [0.8, /\b(port|host|secret|token|config|env|systemd|cron|endpoint|migration|schema|backup)\b|конфиг|настройк|секрет|порт|бэкап|миграци/i],
  [0.8, /\b(resolved?|fixed|changed to|migrated? to|switched to|works?|working|connected|installed|deployed|completed|restored)\b|решено|исправлен|работает|подключен|установлен|перенес|сменил|настроен/i],
  [0.7, /```|\$\s\w+|\bsudo\b|\bgit (?:commit|push|rebase|merge)\b/],
];

export function salience(text) {
  for (const [score, re] of SALIENCE_BANDS) if (re.test(text)) return score;
  return 0.5;
}

// Hard deterministic truncation (design rule spirit — never judge trust).
export function truncate(text, maxTokens, marker = '\n[...truncated deterministically...]') {
  const maxBytes = maxTokens * 4;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  cut = cut.replace(/�+$/, ''); // drop a split multibyte char
  return cut + marker;
}
