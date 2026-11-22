// Full-text state statutes, constitutions and the US Code from the Open US Law corpus
// (https://github.com/Vaquill-AI/open-us-law, data CC BY-NC 4.0). Each jurisdiction lives in its own SQLite
// FTS5 file under data/index/. A jurisdiction is fetched the first time it is searched: as a prebuilt index
// (built by .github/workflows/build-index.yml and published as a GitHub release) when one exists, otherwise
// by downloading the raw parquet files and indexing them here.
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createGunzip } from 'node:zlib';

const BASE = 'https://oss-data-us.vaquill.ai';
// Empty INDEX_URL turns prebuilt downloads off, so every jurisdiction is indexed locally from the parquet files.
const INDEX_URL = (process.env.INDEX_URL ?? 'https://github.com/aaryanbindage/lawlens/releases/download/index').replace(/\/$/, '');
const INDEX_DIR = process.env.CORPUS_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'index');
mkdirSync(INDEX_DIR, { recursive: true });

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS loaded (file TEXT PRIMARY KEY, version TEXT, rows INTEGER, loaded_at INTEGER);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sections (
    act_id TEXT PRIMARY KEY, juris TEXT, kind TEXT, citation TEXT, heading TEXT, path TEXT,
    text TEXT, status TEXT, source_url TEXT, amended INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
    citation, heading, path, text, content='sections', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE INDEX IF NOT EXISTS sections_cite ON sections (citation COLLATE NOCASE);
`;

const KINDS = ['statutes', 'constitutions'];
export const jurisFile = (juris) => join(INDEX_DIR, `${juris}.db`);

/* ------------------------------------------------ per-jurisdiction databases ------------------------------------------------ */

const handles = new Map(); // juris → { db, stmt(sql) }

function open(juris, create = false) {
  if (handles.has(juris)) return handles.get(juris);
  if (!create && !existsSync(jurisFile(juris))) return null;
  const db = new DatabaseSync(jurisFile(juris));
  db.exec(SCHEMA);
  const stmts = new Map();
  const h = { db, stmt: (sql) => stmts.get(sql) || stmts.set(sql, db.prepare(sql)).get(sql) };
  handles.set(juris, h);
  return h;
}

export function closeJuris(juris) {
  handles.get(juris)?.db.close();
  handles.delete(juris);
}

// "STATE_CA_Cpen_S156" → ca, "SCONST_GA_…" → ga, "USC_T42_…" → federal.
function jurisOf(actId) {
  if (/^USC/.test(actId)) return 'federal';
  return (/^S(?:TATE|CONST)_([A-Z]{2})_/.exec(actId) || [])[1]?.toLowerCase() || null;
}

/* ------------------------------------------------ manifests ------------------------------------------------ */

function cachedJson(url, ttlMs) {
  let entry;
  return async () => {
    if (entry && entry.expires > Date.now()) return entry.value;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw Object.assign(new Error(`${url} returned ${res.status}`), { status: res.status });
    entry = { value: await res.json(), expires: Date.now() + ttlMs };
    return entry.value;
  };
}

const getManifest = cachedJson(`${BASE}/index.json`, 6 * 3600 * 1000);
// { version, files: { ca: { bytes }, … } } — written by scripts/build-index.mjs.
const getPrebuiltIndex = INDEX_URL ? cachedJson(`${INDEX_URL}/index.json`, 3600 * 1000) : null;

// "ca" → ["us_ca_statutes.parquet", "us_ca_constitutions.parquet"], "federal" → US Code only.
async function filesFor(juris) {
  const m = await getManifest();
  const wanted = juris === 'federal' ? ['statutes'] : KINDS;
  return m.files.filter((f) => wanted.some((k) => f.file === `us_${juris}_${k}.parquet`)).map((f) => ({ ...f, version: m.version }));
}

// Every jurisdiction with statutes or a constitution in the current snapshot: ["ak", "al", …, "federal"].
export async function corpusJurisdictions() {
  const m = await getManifest();
  const found = m.files.map((f) => (/^us_(\w+?)_(?:statutes|constitutions)\.parquet$/.exec(f.file) || [])[1]).filter(Boolean);
  return { version: m.version, juris: [...new Set(found)].sort() };
}

/* ------------------------------------------------ loading ------------------------------------------------ */

const jobs = new Map(); // juris → { promise, progress, message }

export function loadStatus(juris) {
  const job = jobs.get(juris);
  return job ? { loading: true, progress: job.progress, message: job.message } : { loading: false };
}

// Downloads the prebuilt index. Returns true when installed, false when the corpus has nothing for this
// jurisdiction, or null when no prebuilt index can be fetched (the caller then indexes locally).
async function fetchPrebuilt(juris, job) {
  let entry;
  try {
    entry = (await getPrebuiltIndex()).files?.[juris];
  } catch (err) {
    console.warn(`[corpus] prebuilt index unavailable (${err.message}); indexing ${juris} locally`);
    return null;
  }
  if (!entry) return false;
  const tmp = `${jurisFile(juris)}.download`;
  try {
    job.message = `Downloading the ${juris === 'federal' ? 'US Code' : juris.toUpperCase()} search index (${Math.round(entry.bytes / 1e6)} MB)`;
    const res = await fetch(`${INDEX_URL}/${juris}.db.gz`, { signal: AbortSignal.timeout(15 * 60000) });
    if (!res.ok) throw new Error(`download returned ${res.status}`);
    let received = 0;
    const progress = new Transform({
      transform(chunk, enc, cb) {
        received += chunk.length;
        job.progress = Math.min(0.99, received / entry.bytes);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), progress, createGunzip(), createWriteStream(tmp));
    // Replace any partial local index left by an interrupted build.
    closeJuris(juris);
    for (const ext of ['', '-wal', '-shm']) rmSync(jurisFile(juris) + ext, { force: true });
    renameSync(tmp, jurisFile(juris));
    return true;
  } catch (err) {
    rmSync(tmp, { force: true });
    console.warn(`[corpus] prebuilt ${juris} failed (${err.message}); indexing locally`);
    return null;
  }
}

// One import at a time: each holds a whole parquet file in memory and SQLite's write lock for its transaction.
let queue = Promise.resolve();
function indexFile(juris, f, job) {
  const run = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./corpus-worker.js', import.meta.url), { workerData: { dbPath: jurisFile(juris), juris, file: f } });
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

const isPrebuilt = (juris) => open(juris)?.stmt("SELECT value FROM meta WHERE key = 'prebuilt'").get()?.value;
const hasData = (juris) => !!open(juris)?.stmt('SELECT 1 FROM loaded LIMIT 1').get();

// Resolves once the jurisdiction is searchable. Returns false if the corpus has no data for it.
export function ensureLoaded(juris) {
  if (jobs.has(juris)) return jobs.get(juris).promise;
  const job = { progress: 0, message: 'Checking Open US Law snapshot', done: 0, total: 1 };
  job.promise = (async () => {
    if (INDEX_URL && !isPrebuilt(juris) && !hasData(juris)) {
      const got = await fetchPrebuilt(juris, job);
      if (got !== null) return got;
    }
    // A downloaded index is refreshed by a newer release (picked up on the next restart), not rebuilt here.
    if (isPrebuilt(juris)) return true;
    const files = await filesFor(juris);
    if (!files.length) return false;
    const { stmt } = open(juris, true);
    const stale = files.filter((f) => !stmt('SELECT 1 FROM loaded WHERE file = ? AND version = ?').get(f.file, f.version));
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
  return !!open(juris)?.stmt('SELECT 1 FROM loaded WHERE file = ?').get(`us_${juris}_statutes.parquet`);
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

const SEARCH_SQL = `
  SELECT s.act_id, s.kind, s.citation, s.heading, s.path, s.status, s.amended,
         snippet(sections_fts, 3, '', '', '…', 28) AS snip, substr(s.text, 1, 160) AS lead
  FROM sections_fts JOIN sections s ON s.rowid = sections_fts.rowid
  WHERE sections_fts MATCH ?
  ORDER BY bm25(sections_fts, 2.0, 6.0, 2.0, 1.0)
  LIMIT ?`;

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
  const h = open(juris);
  if (!h) return [];
  // Exact phrase first ("security deposit"), then every word, then any word — merged in that order.
  const words = toFtsQuery(q, ' ');
  if (!words) return [];
  const tiers = [words.includes(' ') ? `"${words.replace(/"/g, '')}"` : null, toFtsQuery(q, ' AND '), toFtsQuery(q, ' OR ')];
  const seen = new Set();
  let out = [];
  for (const fq of tiers) {
    if (!fq) continue;
    for (const r of h.stmt(SEARCH_SQL).all(fq, limit * 2)) {
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
  return open(jurisOf(actId))?.stmt('SELECT * FROM sections WHERE act_id = ?').get(actId);
}

/* ------------------------------------------------ citation lookup ------------------------------------------------ */

const CITE_COLS = 'act_id, kind, citation, heading, path, status, amended, substr(text, 1, 160) AS lead, substr(text, 1, 220) AS snip';

// Exact section by full citation ("Cal. PEN § 1170"), ignoring a trailing "(2026)" edition year.
export function findCitation(juris, citation) {
  const rows = open(juris)
    ?.stmt(`SELECT ${CITE_COLS} FROM sections WHERE citation = ? COLLATE NOCASE OR citation LIKE ?`)
    .all(citation, `${citation} (%`);
  return newestEditions(rows || [])[0] || null;
}

// Every section numbered `num` in any code of the jurisdiction: "1170" → PEN § 1170, CIV § 1170, …
export function findSectionNumber(juris, num, limit = 30) {
  const rows = open(juris)
    ?.stmt(`SELECT ${CITE_COLS} FROM sections WHERE citation LIKE ? OR citation LIKE ? OR citation LIKE ? LIMIT ?`)
    .all(`%§ ${num}`, `%§ ${num} (%`, `%/${num}`, limit * 2);
  return newestEditions(rows || []).slice(0, limit);
}

// Citation prefixes in use, e.g. "Cal. PEN § " or "Tex. Estates Code § " — used to resolve "Penal Code 1170".
const prefixCache = new Map();
export function citationPrefixes(juris) {
  if (!prefixCache.has(juris)) {
    const rows = open(juris)
      ?.stmt("SELECT DISTINCT substr(citation, 1, instr(citation, '§') + 1) AS p FROM sections WHERE instr(citation, '§') > 0")
      .all();
    if (!rows?.length) return [];
    prefixCache.set(juris, rows.map((r) => r.p));
  }
  return prefixCache.get(juris);
}
