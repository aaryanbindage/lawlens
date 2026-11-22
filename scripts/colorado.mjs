// Colorado isn't in the Open US Law corpus, so its index is built from the official Colorado Revised
// Statutes downloads published by the Office of Legislative Legal Services (one HTML file per title;
// title 00 is the state constitution). Only the law text is kept: the "Source:" history notes, editor's
// notes, cross references and case annotations that follow each section are skipped.
const PAGE = (year) => `https://content.leg.colorado.gov/agencies/office-legislative-legal-services/${year}-crs-titles-download`;
const UA = { 'user-agent': 'LawLens index builder (+https://github.com/aaryanbindage/lawlens)' };
const SKIP = /\((?:Repealed|Reserved|Transferred|Relocated)\)\.?$|^(?:Repealed|Reserved)\b/i;

// Newest published edition: [{ title: "42", url }, …] plus the download page itself.
async function titleFiles() {
  const now = new Date().getFullYear();
  for (const year of [now, now - 1, now - 2]) {
    const res = await fetch(PAGE(year), { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!res.ok) continue;
    const html = await res.text();
    const urls = [...new Set(html.match(new RegExp(`https://olls\\.info/crs/crs${year}-title-[\\d.]+\\.htm`, 'g')) || [])];
    if (urls.length) return { year, page: PAGE(year), titles: urls.map((url) => ({ title: /title-([\d.]+)\.htm$/.exec(url)[1], url })) };
  }
  throw new Error('No Colorado Revised Statutes download page found');
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const text = (html) =>
  html
    .replace(/<br[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(And|Of|The|To|For|In|On|Or)\b/g, (w) => w.toLowerCase()) : s);

// Splits one title file into sections: { num, heading, body[], path[] }.
function parseTitle(html, isConstitution) {
  const body = html.slice(html.search(/<body/i));
  const paras = body.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
  const startRe = isConstitution ? /^(Section \d+(?:\.\d+)?[a-z]?\.|Preamble\.?)(?:\s+(.*))?$/ : /^(\d+(?:\.\d+)?-\d+(?:\.\d+)?-\d+(?:\.\d+)?)\.\s+(.*)$/;
  const levels = {}; // TITLE / ARTICLE / PART / SUBPART → "Article 4"
  const out = [];
  let cur = null;
  let pendingLevel = null;
  for (const p of paras) {
    const t = text(p);
    if (!t) continue;
    const lv = /^(TITLE|ARTICLE|PART|SUBPART)\s+([\dIVXLC.]+[A-Z]?)\b\s*(.*)$/.exec(t);
    if (lv && !/^<p[^>]*>\s*<b>[^<]*\d+-\d+/i.test(p)) {
      const [, kind, n, name] = lv;
      if (kind === 'TITLE') Object.keys(levels).forEach((k) => delete levels[k]);
      if (kind === 'ARTICLE') ['PART', 'SUBPART'].forEach((k) => delete levels[k]);
      if (kind === 'PART') delete levels.SUBPART;
      levels[kind] = `${titleCase(kind)} ${n}${name ? ` ${titleCase(name)}` : ''}`;
      pendingLevel = name ? null : kind; // the constitution puts the article's name in the next paragraph
      cur = null;
      continue;
    }
    const bold = /^<p[^>]*>\s*(?:<span[^>]*>\s*)?<b>/i.test(p);
    const start = bold && startRe.exec(t);
    if (start) {
      // "<b>42-4-1301.</b> <b>Heading.</b> optional body…" — the heading is the second bold run.
      const runs = [...p.matchAll(/<b>([\s\S]*?)<\/b>/gi)].map((m) => text(m[1])).filter(Boolean);
      const num = start[1].replace(/\.$/, '');
      const heading = (num === 'Preamble' ? 'Preamble' : runs.length > 1 ? runs.slice(1).join(' ') : start[2] || '').replace(/\s+$/, '');
      const rest = text(p.slice(p.lastIndexOf('</b>') + 4));
      cur = { num, heading, body: rest ? [rest] : [], path: Object.values(levels) };
      out.push(cur);
      pendingLevel = null;
      continue;
    }
    // The constitution's closing schedule has no ARTICLE heading, only this preamble sentence.
    if (isConstitution && (t === 'SCHEDULE' || /^That no inconvenience may arise by reason of the change/.test(t))) {
      levels.ARTICLE = 'Schedule';
      cur = null;
      continue;
    }
    // A level's name in its own paragraph: "ARTICLE II" then "Bill of Rights", or "PART 13" then "ALCOHOL AND DRUG OFFENSES".
    if (pendingLevel && (bold || (t === t.toUpperCase() && t.length < 200)) && !/^(Source|Editor|Cross references|ANNOTATION)/.test(t)) {
      levels[pendingLevel] += ` ${titleCase(t)}`;
      pendingLevel = null;
      continue;
    }
    if (!cur) continue;
    if (/^(Source:|Editor's note|Cross references|ANNOTATION$|Law reviews?:|Done in Convention)/.test(t)) {
      cur = null; // history and annotations follow the law text
      continue;
    }
    cur.body.push(t);
  }
  return out.filter((s) => !SKIP.test(s.heading) && !(s.body.length === 1 && SKIP.test(s.body[0])) && s.body.length);
}

// Writes every Colorado section into db (opened with the corpus schema). Returns the number of sections.
export async function buildColorado(db, log = console.log) {
  const { year, page, titles } = await titleFiles();
  log(`co: Colorado Revised Statutes ${year}, ${titles.length} title files`);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO sections (act_id, juris, kind, citation, heading, path, text, status, source_url, amended)
    VALUES (?, 'co', ?, ?, ?, ?, ?, 'in_force', ?, NULL)`);
  const counts = { Statute: 0, Constitution: 0 };
  db.exec('BEGIN');
  try {
    for (const { title, url } of titles) {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(5 * 60000) });
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      const html = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
      const isConst = Number(title) === 0;
      for (const s of parseTitle(html, isConst)) {
        if (isConst) {
          const level = s.path.find((p) => /^(Article|Schedule)/.test(p)) || '';
          const art = /^Article ([IVXLC]+[A-Z]?)/.exec(level)?.[1] || (level === 'Schedule' ? 'SCHED' : null);
          const sec = s.num === 'Preamble' ? null : s.num.replace(/^Section /, '');
          if (sec && !art) continue;
          const citation = !sec ? 'Colo. Const. pmbl.' : art === 'SCHED' ? `Colo. Const. sched. § ${sec}` : `Colo. Const. art. ${art}, § ${sec}`;
          const id = sec ? `SCONST_CO_A${art}_S${sec}` : 'SCONST_CO_PREAMBLE';
          insert.run(id, 'Constitution', citation, s.heading, ['Colorado Constitution', ...s.path, s.num].join(' / '), s.body.join('\n'), url);
          counts.Constitution++;
        } else {
          insert.run(`STATE_CO_T${title}_S${s.num}`, 'Statute', `Colo. Rev. Stat. § ${s.num}`, s.heading.replace(/\.$/, ''),
            ['Colorado Revised Statutes', ...s.path, `Section ${s.num}`].join(' / '), s.body.join('\n'), url);
          counts.Statute++;
        }
      }
      log(`co: title ${title} done (${(counts.Statute + counts.Constitution).toLocaleString()} sections so far)`);
    }
    db.exec(`INSERT INTO sections_fts (rowid, citation, heading, path, text) SELECT rowid, citation, heading, path, text FROM sections`);
    // The server checks these rows to know a jurisdiction's statutes/constitution are indexed.
    const loaded = db.prepare('INSERT OR REPLACE INTO loaded (file, version, rows, loaded_at) VALUES (?, ?, ?, ?)');
    loaded.run('us_co_statutes.parquet', `crs${year}`, counts.Statute, Date.now());
    loaded.run('us_co_constitutions.parquet', `crs${year}`, counts.Constitution, Date.now());
    const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    meta.run('credit', `Colorado Revised Statutes ${year}, Office of Legislative Legal Services`);
    meta.run('credit_url', page);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return counts.Statute + counts.Constitution;
}

// Quick check without a database: node scripts/colorado.mjs <title-file.htm> [const]
if (process.argv[1]?.endsWith('colorado.mjs') && process.argv[2]) {
  const { readFileSync } = await import('node:fs');
  const secs = parseTitle(new TextDecoder('windows-1252').decode(readFileSync(process.argv[2])), process.argv[3] === 'const');
  console.log(secs.length, 'sections');
  for (const s of [secs[0], secs[1], secs[Math.floor(secs.length / 2)], secs.at(-1)]) console.log(JSON.stringify({ ...s, body: s.body.slice(0, 2).map((b) => b.slice(0, 120)), bodyLen: s.body.length }));
}

