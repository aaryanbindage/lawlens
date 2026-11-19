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
  })().finally(() => {
    jobs.delete(juris);
    prefixCache.delete(juris);
  });
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

// The US Code file carries more than one annual edition of some sections, e.g. "… § 602 (2024)" and "(2026)".
const editionless = (citation) => citation.replace(/\s*\(\d{4}\)$/, '');
const editionYear = (citation) => Number((/\((\d{4})\)$/.exec(citation) || [])[1] || 0);

// Keeps rank order but collapses editions of the same section to the newest one.
function newestEditions(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = editionless(r.citation);
    const prev = byKey.get(key);
    if (!prev || editionYear(r.citation) > editionYear(prev.citation)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export function searchCorpus(juris, q, limit = 25) {
  // Exact phrase first ("security deposit"), then every word, then any word — merged in that order.
  const words = toFtsQuery(q, ' ');
  if (!words) return [];
  const tiers = [words.includes(' ') ? `"${words.replace(/"/g, '')}"` : null, toFtsQuery(q, ' AND '), toFtsQuery(q, ' OR ')];
  const seen = new Set();
  let out = [];
  for (const fq of tiers) {
    if (!fq) continue;
    for (const r of searchStmt.all(fq, juris, limit * 2)) {
      if (seen.has(r.act_id)) continue;
      seen.add(r.act_id);
      out.push(r);
    }
    out = newestEditions(out);
    if (out.length >= Math.min(limit, 10)) break;
  }
  return out.slice(0, limit);
}

export function getSection(actId) {
  return db.prepare('SELECT * FROM sections WHERE act_id = ?').get(actId);
}

/* ------------------------------------------------ citation lookup ------------------------------------------------ */

db.exec('CREATE INDEX IF NOT EXISTS sections_cite ON sections (juris, citation COLLATE NOCASE)');

const CITE_COLS = 'act_id, kind, citation, heading, path, status, amended, substr(text, 1, 160) AS lead, substr(text, 1, 220) AS snip';

// Exact section by full citation ("Cal. PEN § 1170"), ignoring a trailing "(2026)" edition year.
export function findCitation(juris, citation) {
  const rows = db
    .prepare(`SELECT ${CITE_COLS} FROM sections WHERE juris = ? AND (citation = ? COLLATE NOCASE OR citation LIKE ?)`)
    .all(juris, citation, `${citation} (%`);
  return newestEditions(rows)[0] || null;
}

// Every section numbered `num` in any code of the jurisdiction: "1170" → PEN § 1170, CIV § 1170, …
export function findSectionNumber(juris, num, limit = 30) {
  const rows = db
    .prepare(`SELECT ${CITE_COLS} FROM sections WHERE juris = ? AND (citation LIKE ? OR citation LIKE ? OR citation LIKE ?) LIMIT ?`)
    .all(juris, `%§ ${num}`, `%§ ${num} (%`, `%/${num}`, limit * 2);
  return newestEditions(rows).slice(0, limit);
}

// Citation prefixes in use, e.g. "Cal. PEN § " or "Tex. Estates Code § " — used to resolve "Penal Code 1170".
const prefixCache = new Map();
export function citationPrefixes(juris) {
  if (!prefixCache.has(juris)) {
    const rows = db
      .prepare("SELECT DISTINCT substr(citation, 1, instr(citation, '§') + 1) AS p FROM sections WHERE juris = ? AND instr(citation, '§') > 0")
      .all(juris);
    if (!rows.length) return [];
    prefixCache.set(juris, rows.map((r) => r.p));
  }
  return prefixCache.get(juris);
}
