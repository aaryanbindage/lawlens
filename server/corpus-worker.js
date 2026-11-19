// Runs in a worker thread: downloads one Open US Law parquet file and indexes it into corpus.db,
// so the long decode + FTS build never blocks the web server.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const { dbPath, juris, file: f } = workerData;
const SKIP_STATUS = new Set(['repealed', 'reserved', 'superseded', 'expired', 'renumbered', 'transferred']);
const COLUMNS = ['act_id', 'citation', 'section_title', 'display_path', 'title_name', 'text', 'act_status', 'source_url', 'last_amended_year'];
const report = (progress, message) => parentPort.postMessage({ type: 'progress', progress, message });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 30000');

report(0, `Downloading ${f.file} (${Math.round(f.bytes / 1e6)} MB)`);
const res = await fetch(f.url, { signal: AbortSignal.timeout(10 * 60000) });
if (!res.ok) throw new Error(`${f.file}: download returned ${res.status}`);
const file = await res.arrayBuffer();
const meta = await parquetMetadataAsync(file);
const kind = /_constitutions\./.test(f.file) ? 'Constitution' : juris === 'federal' ? 'US Code' : 'Statute';

const insert = db.prepare(`
  INSERT OR REPLACE INTO sections (act_id, juris, kind, citation, heading, path, text, status, source_url, amended)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

db.exec('BEGIN IMMEDIATE');
try {
  // Remove an older snapshot of this file (FTS5 external-content rows must be deleted with their old values).
  const del = db.prepare("INSERT INTO sections_fts (sections_fts, rowid, citation, heading, path, text) VALUES ('delete', ?, ?, ?, ?, ?)");
  for (const r of db.prepare('SELECT rowid, citation, heading, path, text FROM sections WHERE juris = ? AND kind = ?').iterate(juris, kind))
    del.run(r.rowid, r.citation, r.heading, r.path, r.text);
  db.prepare('DELETE FROM sections WHERE juris = ? AND kind = ?').run(juris, kind);

  let rowStart = 0;
  let kept = 0;
  for (const [i, rg] of meta.row_groups.entries()) {
    const rowEnd = rowStart + Number(rg.num_rows);
    for (const r of await parquetReadObjects({ file, compressors, columns: COLUMNS, rowStart, rowEnd })) {
      if (!r.act_id || !r.text || SKIP_STATUS.has(r.act_status)) continue;
      insert.run(
        r.act_id, juris, kind, r.citation || r.act_id,
        r.section_title || '', r.display_path || r.title_name || '', r.text, r.act_status || '',
        r.source_url || '', r.last_amended_year == null ? null : Number(r.last_amended_year),
      );
      kept++;
    }
    rowStart = rowEnd;
    report((0.8 * (i + 1)) / meta.row_groups.length, `Indexing ${f.file} — ${kept.toLocaleString()} sections`);
  }
  report(0.85, `Building the search index for ${kept.toLocaleString()} sections`);
  db.prepare(`
    INSERT INTO sections_fts (rowid, citation, heading, path, text)
    SELECT rowid, citation, heading, path, text FROM sections WHERE juris = ? AND kind = ?`).run(juris, kind);
  db.prepare('INSERT OR REPLACE INTO loaded (file, version, rows, loaded_at) VALUES (?, ?, ?, ?)').run(f.file, f.version, kept, Date.now());
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // a bulk import leaves a WAL as large as the data itself
  parentPort.postMessage({ type: 'done', rows: kept });
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
} finally {
  db.close();
}
