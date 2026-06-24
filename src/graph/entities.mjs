// Entity extraction, alias dictionary, and canonical resolution.
// Shared infra: consumed by contradiction pre-filter, retrieval, dedup.
//
// Dictionaries are EMPTY by default — each deployment builds its own
// vocabulary organically as facts and entities accumulate. Add domain-specific
// aliases to RU_EN_ALIASES if your corpus is bilingual.

const NORM_RE = /[^\p{L}\p{N}]+/gu;

// RU/EN alias dictionary for bilingual retrieval.
// Maps lowercase terms to their canonical English forms.
// Empty by default — add your own domain terms here.
// Example: ['сервер', 'server'] makes "сервер" queries find "server" facts.
export const RU_EN_ALIASES = new Map([
  // Add your aliases here:
  // ['сервер', 'server'],
  // ['бэкап', 'backup'],
]);

// Russian suffix stripping — algorithmic declension normalization.
const RU_SUFFIXES = [
  'ями', 'ами', 'ией', 'ием', 'ого', 'его', 'ому', 'ему',
  'ых', 'их', 'ой', 'ей', 'ом', 'ем', 'ов', 'ев', 'ах', 'ях',
  'ам', 'ям', 'ые', 'ие', 'ую', 'юю', 'ая', 'яя', 'ое', 'ее',
  'а', 'я', 'у', 'ю', 'о', 'е', 'и', 'ы',
];

function stemRu(word) {
  if (!/[а-яё]/i.test(word)) return word;
  for (const suf of RU_SUFFIXES) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

export function canonEntity(s) {
  const norm = s.toLowerCase().replace(NORM_RE, ' ').trim();
  if (RU_EN_ALIASES.has(norm)) return RU_EN_ALIASES.get(norm);
  const stemmed = stemRu(norm);
  if (stemmed !== norm && RU_EN_ALIASES.has(stemmed)) return RU_EN_ALIASES.get(stemmed);
  return norm;
}

export function buildAliasMap(db) {
  const map = new Map();
  const rows = db.prepare('SELECT label, aliases FROM graph_nodes').all();
  for (const r of rows) {
    const canon = canonEntity(r.label);
    map.set(canon, canon);
    if (r.aliases) {
      try {
        for (const a of JSON.parse(r.aliases)) map.set(canonEntity(a), canon);
      } catch {}
    }
  }
  return map;
}

export function resolveEntity(token, aliasMap) {
  const c = canonEntity(token);
  return aliasMap.get(c) ?? c;
}

export function parseEntities(entitiesJson, aliasMap) {
  const out = new Set();
  if (!entitiesJson) return out;
  try {
    for (const e of JSON.parse(entitiesJson)) out.add(resolveEntity(String(e), aliasMap));
  } catch {}
  return out;
}

export function entityOverlap(setA, setB) {
  let count = 0;
  for (const e of setA) if (setB.has(e)) count++;
  return count;
}

// --- Text entity extraction (from fact_text / document chunks) ---
// Structural patterns — these work for ANY language/domain without dictionaries.
const CASE_SENSITIVE_RE = /(?:\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b|\b[A-Z][A-Z0-9_]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\/[\w\-.\/]{3,}(?:\.\w+)?\b|\b\d+\.\d+(?:\.\d+)+\b|[А-ЯЁ][а-яё]{2,})/g;

// Known tool/project names — universal tech names only.
const KNOWN_NAMES_RE = /\b(?:node\.?js|npm|python|pip|docker|systemd|nginx|sqlite|fastify|telegram|github|cloudflare|ollama)\b/gi;

// Composite names — empty by default. Add domain-specific multi-word entities.
// Example: /\b(?:Smart Money|Order Block)\b/gi
const COMPOSITE_NAMES_RE = null;

// Stop words — common abbreviations and Cyrillic nouns that are NOT entities.
const STOP_CAPS = new Set(['API','HTTP','HTTPS','JSON','SQL','SSH','DNS','TCP','UDP','URL','SSL','TLS','FTS','HTML','CSS','RAM','CPU','GPU','SSD','NVME','UUID','CLI','SDK','MCP','LLM','VPN','VPS','ORM','EOF','ENV','PID','GID','UID','GET','PUT','SET','RUN','POST','JWT','UTC','ISO','DOM','NOT','AND','THE','FOR','HAS','WAS','ARE','BUT','BOT','BASE','NONE','NULL','TRUE','FALSE']);
const STOP_CYR = new Set(['также','основной','новый','старый','текущий','первый','второй','третий','общий','полный','другой','важный','следующий','последний','этот','после','перед','через','между','только','более','менее','далее','затем','потом','ещё','уже','все','вот','при','для','как','что','или','без','это','настройки','настройка','обновление','удаление','создание','установка','изменение','результат','проблема','ошибка','процесс','система','версия','статус','режим','формат','метод','модель','модуль','функция','параметр','значение','запрос','ответ','список','файл','каталог','папка','задача','проект','сервис','клиент','пользователь','время','дата','тип','имя','код','лог','тест','порт','путь','ключ','токен']);

// Generic infrastructure vocabulary.
const GENERIC_VOCAB_RE = /\b(?:server|network|backup|port|config|proxy|tunnel|firewall|deploy|disk|certificate|database|daemon|cron|migration|cluster|replica|snapshot|container|volume|mount|route|gateway|endpoint|middleware|cache|queue|worker|scheduler|socket|pipeline|monitor|alert|metric|secret|credential|token|session|webhook|reboot|restart|shutdown|update|upgrade|rollback)\b/gi;

export function extractEntitiesFromText(text) {
  const entities = new Set();
  if (COMPOSITE_NAMES_RE) {
    for (const match of text.matchAll(COMPOSITE_NAMES_RE)) {
      const canon = match[0].toLowerCase().replace(/\s+/g, ' ').trim();
      if (canon.length >= 3) entities.add(canon);
    }
  }
  for (const match of text.matchAll(CASE_SENSITIVE_RE)) {
    const raw = match[0];
    if (raw.length < 2 || raw.length > 60) continue;
    if (STOP_CAPS.has(raw.toUpperCase())) continue;
    if (STOP_CYR.has(raw.toLowerCase())) continue;
    if (/^\d+$/.test(raw)) continue;
    const canon = canonEntity(raw);
    if (canon.length >= 2) entities.add(canon);
  }
  for (const match of text.matchAll(KNOWN_NAMES_RE)) {
    const canon = canonEntity(match[0]);
    if (canon.length >= 2) entities.add(canon);
  }
  for (const match of text.matchAll(GENERIC_VOCAB_RE)) {
    const canon = match[0].toLowerCase();
    if (canon.length >= 3) entities.add(canon);
  }
  return [...entities];
}

// Topic detection — empty by default. Add domain rules for thematic tagging.
// Example: { topic: 'security', re: /(?:pentest|vulnerability|exploit|XSS|SQLi)/i }
const TOPIC_RULES = [];

export function detectTopics(text) {
  const topics = [];
  for (const { topic, re } of TOPIC_RULES) {
    if (re.test(text)) topics.push(topic);
  }
  return topics;
}
