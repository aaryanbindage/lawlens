// Builds one gzipped SQLite search index per jurisdiction plus index.json, ready to publish as the
// "index" GitHub release that the server downloads (see INDEX_URL in server/corpus.js).
//   node scripts/build-index.mjs <out-dir> [juris …]     e.g. node scripts/build-index.mjs dist/index ca federal
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const [outArg, ...only] = process.argv.slice(2);
if (!outArg) {
  console.error('usage: node scripts/build-index.mjs <out-dir> [juris …]');
  process.exit(2);
}
const out = resolve(outArg);
const work = join(out, '.work');
mkdirSync(work, { recursive: true });

// corpus.js reads these at import time: index straight from the parquet files into the work directory.
process.env.INDEX_URL = '';
process.env.CORPUS_DIR = work;
const { corpusJurisdictions, ensureLoaded, closeJuris, jurisFile } = await import('../server/corpus.js');

const { version, juris: all } = await corpusJurisdictions();
const list = only.length ? only : all;
// Rebuilding a few jurisdictions keeps the others listed in an existing index.json of the same snapshot.
const prev = existsSync(join(out, 'index.json')) ? JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) : null;
const files = only.length && prev?.version === version ? prev.files : {};

for (const j of list) {
  const t0 = Date.now();
  if (!(await ensureLoaded(j))) {
    console.log(`${j}: no data in ${version}, skipped`);
    continue;
  }
  closeJuris(j);
  const db = new DatabaseSync(jurisFile(j));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('prebuilt', ?)").run(version);
  db.exec("INSERT INTO sections_fts (sections_fts) VALUES ('optimize'); PRAGMA journal_mode = DELETE; VACUUM;");
  const sections = db.prepare('SELECT count(*) AS n FROM sections').get().n;
  db.close();
  const gz = join(out, `${j}.db.gz`);
  await pipeline(createReadStream(jurisFile(j)), createGzip({ level: 6 }), createWriteStream(gz));
  files[j] = { bytes: statSync(gz).size, raw_bytes: statSync(jurisFile(j)).size, sections };
  rmSync(jurisFile(j), { force: true });
  console.log(`${j}: ${sections} sections, ${(files[j].bytes / 1e6).toFixed(1)} MB gz, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

rmSync(work, { recursive: true, force: true });
writeFileSync(join(out, 'index.json'), JSON.stringify({ version, built_at: new Date().toISOString(), files }, null, 2));
console.log(`wrote ${Object.keys(files).length} indexes for ${version} to ${out}`);
process.exit(0); // the manifest fetch keeps no handles, but worker threads may linger briefly
