// Database singleton — opens SQLite with WAL + FK, runs migrations.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function migrate(dbPath) {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map((r) => r.version));
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

  let ran = 0;
  for (const f of files) {
    const version = Number(f.slice(0, 4));
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(version, f, Date.now());
    })();
    console.log(`applied ${f}`);
    ran++;
  }
  if (ran === 0) console.log('schema up to date');
  return db;
}

let _db = null;

export function getDb(dbPath) {
  if (_db) return _db;
  _db = migrate(dbPath);
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
