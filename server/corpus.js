// Full-text state statutes, constitutions and the US Code from the Open US Law corpus
// (https://github.com/Vaquill-AI/open-us-law, data CC BY-NC 4.0). Each jurisdiction's parquet files are
// downloaded the first time it is searched and indexed into a local SQLite FTS5 table.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const BASE = 'https://oss-data-us.vaquill.ai';
const DATA_DIR = process.env.DB_PATH ? dirname(process.env.DB_PATH) : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = join(DATA_DIR, 'corpus.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS loaded (file TEXT PRIMARY KEY, version TEXT, rows INTEGER, loaded_at INTEGER);
  CREATE TABLE IF NOT EXISTS sections (
    act_id TEXT PRIMARY KEY, juris TEXT, kind TEXT, citation TEXT, heading TEXT, path TEXT,
    text TEXT, status TEXT, source_url TEXT, amended INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
    citation, heading, path, text, content='sections', content_rowid='rowid', tokenize='porter unicode61'
  );
  PRAGMA wal_checkpoint(TRUNCATE);
`);

const KINDS = ['statutes', 'constitutions'];

/* ------------------------------------------------ manifest ------------------------------------------------ */

let manifest;
async function getManifest() {
  if (manifest && manifest.expires > Date.now()) return manifest.value;
  const res = await fetch(`${BASE}/index.json`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Open US Law manifest returned ${res.status}`);
  const value = await res.json();
  manifest = { value, expires: Date.now() + 6 * 3600 * 1000 };
  return value;
}

// "ca" → ["us_ca_statutes.parquet", "us_ca_constitutions.parquet"], "federal" → US Code only.
async function filesFor(juris) {
  const m = await getManifest();
  const wanted = juris === 'federal' ? ['statutes'] : KINDS;
  return m.files.filter((f) => wanted.some((k) => f.file === `us_${juris}_${k}.parquet`)).map((f) => ({ ...f, version: m.version }));
}

/* ------------------------------------------------ loading ------------------------------------------------ */

const jobs = new Map(); // juris → { promise, progress, message }

export function loadStatus(juris) {
  const job = jobs.get(juris);
  return job ? { loading: true, progress: job.progress, message: job.message } : { loading: false };
}

// One import at a time: each holds SQLite's write lock for its whole transaction.
let queue = Promise.resolve();
function indexFile(juris, f, job) {
  const run = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./corpus-worker.js', import.meta.url), { workerData: { dbPath: DB_FILE, juris, file: f } });
      worker.on('message', (m) => {
        if (m.type === 'progress') {
          job.progress = (job.done + m.progress) / job.total;
          job.message = m.message;
        } else if (m.type === 'done') resolve(m.rows);
      });
      worker.on('error', reject);
      worker.on('exit', (code) => code !== 0 && reject(new Error(`Indexing ${f.file} failed (exit ${code})`)));
    });
  job.message = `Waiting for another code to finish indexing`;
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

// Resolves when the jurisdiction is indexed at the current snapshot version. Returns false if the corpus has no data for it.
export function ensureLoaded(juris) {
  if (jobs.has(juris)) return jobs.get(juris).promise;
  const job = { progress: 0, message: 'Checking Open US Law snapshot', done: 0, total: 1 };
  job.promise = (async () => {
    const files = await filesFor(juris);
    if (!files.length) return false;
    const isCurrent = db.prepare('SELECT 1 FROM loaded WHERE file = ? AND version = ?');
    const stale = files.filter((f) => !isCurrent.get(f.file, f.version));
    job.total = stale.length || 1;
    for (const f of stale) {
      await indexFile(juris, f, job);
      job.done++;
    }
    return true;
  })().finally(() => jobs.delete(juris));
  jobs.set(juris, job);
  return job.promise;
}

export function isLoaded(juris) {
  return !!db.prepare("SELECT 1 FROM loaded WHERE file = ?").get(`us_${juris}_statutes.parquet`);
}

/* ------------------------------------------------ search & read ------------------------------------------------ */

const toFtsQuery = (q, joiner) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => `"${w}"`)
    .join(joiner);
const STOP = new Set(['the', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'a', 'an', 'is', 'my', 'law', 'laws', 'what', 'about']);

const searchStmt = db.prepare(`
  SELECT s.act_id, s.kind, s.citation, s.heading, s.path, s.status, s.amended,
         snippet(sections_fts, 3, '', '', '…', 28) AS snip, substr(s.text, 1, 160) AS lead
  FROM sections_fts JOIN sections s ON s.rowid = sections_fts.rowid
  WHERE sections_fts MATCH ? AND s.juris = ?
  ORDER BY bm25(sections_fts, 2.0, 6.0, 2.0, 1.0)
  LIMIT ?`);

export function searchCorpus(juris, q, limit = 25) {
  // Prefer sections containing every word; fall back to any word.
  // Exact phrase first ("security deposit"), then every word, then any word — merged in that order.
  const words = toFtsQuery(q, ' ');
  if (!words) return [];
  const tiers = [words.includes(' ') ? `"${words.replace(/"/g, '')}"` : null, toFtsQuery(q, ' AND '), toFtsQuery(q, ' OR ')];
  const seen = new Set();
  const out = [];
  for (const fq of tiers) {
    if (!fq) continue;
    for (const r of searchStmt.all(fq, juris, limit)) {
      if (seen.has(r.act_id)) continue;
      seen.add(r.act_id);
      out.push(r);
    }
    if (out.length >= Math.min(limit, 10)) break;
  }
  return out.slice(0, limit);
}

export function getSection(actId) {
  return db.prepare('SELECT * FROM sections WHERE act_id = ?').get(actId);
}
