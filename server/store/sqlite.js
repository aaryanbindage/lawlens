// Local-development account store (used when MONGODB_URI is not set).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createSqliteStore() {
  const path = process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'lawlens.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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

  const toUser = (r) =>
    r && { id: String(r.id), email: r.email, name: r.name, pwHash: r.pw_hash, salt: r.salt, settings: JSON.parse(r.settings || '{}') };
  const toItem = (r) => ({
    key: r.doc_key, src: r.src, id: r.doc_id, title: r.title, citation: r.citation, meta: r.meta, url: r.url,
    progress: r.progress, anchor: r.anchor, openedAt: r.opened_at, updatedAt: r.updated_at,
  });
  const upsert = db.prepare(`
    INSERT INTO history (user_id, doc_key, src, doc_id, title, citation, meta, url, progress, anchor, opened_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, doc_key) DO UPDATE SET
      title = excluded.title, citation = excluded.citation, meta = excluded.meta, url = excluded.url,
      progress = excluded.progress, anchor = excluded.anchor, updated_at = excluded.updated_at
    WHERE excluded.updated_at >= history.updated_at`);

  return {
    kind: 'sqlite',
    async findUserByEmail(email) {
      return toUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email));
    },
    async createUser({ email, name, pwHash, salt }) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (email, name, pw_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(email, name, pwHash, salt, Date.now());
      return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid));
    },
    async updateSettings(userId, settings) {
      db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), Number(userId));
    },
    async createSession(token, userId, expiresAt) {
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, Number(userId), expiresAt);
    },
    async userForSession(token) {
      return toUser(
        db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?').get(token, Date.now()),
      );
    },
    async deleteSession(token) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },
    async listHistory(userId, limit) {
      return db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').all(Number(userId), limit).map(toItem);
    },
    async upsertHistory(userId, it) {
      upsert.run(Number(userId), it.key, it.src, it.id, it.title, it.citation, it.meta, it.url, it.progress, it.anchor, it.openedAt, it.updatedAt);
    },
    async deleteHistory(userId, key) {
      if (key) db.prepare('DELETE FROM history WHERE user_id = ? AND doc_key = ?').run(Number(userId), key);
      else db.prepare('DELETE FROM history WHERE user_id = ?').run(Number(userId));
    },
  };
}
