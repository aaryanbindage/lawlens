import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'lawlens.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT,
    pw_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_key TEXT NOT NULL,
    src TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    title TEXT,
    citation TEXT,
    meta TEXT,
    url TEXT,
    progress REAL NOT NULL DEFAULT 0,
    anchor INTEGER NOT NULL DEFAULT 0,
    opened_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, doc_key)
  );
  CREATE INDEX IF NOT EXISTS history_recent ON history(user_id, updated_at DESC);
`);
