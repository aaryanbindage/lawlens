import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { db } from './db.js';
import { sessionMiddleware, requireUser, register, login, logout, publicUser } from './auth.js';
import { searchAll, getDocument } from './sources.js';
import { STATES } from './states.js';
import { ensureLoaded } from './corpus.js';
import { PROVIDERS, chat, listModels } from './ai.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so no extra dependency is needed.
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '2mb' }));
app.use(sessionMiddleware);

const userKeys = (req) => ({ openstates: req.get('x-openstates-key') || '', govinfo: req.get('x-govinfo-key') || '' });

app.get('/api/meta', (req, res) => {
  res.json({
    states: STATES,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel, keyUrl: v.keyUrl }])),
    serverKeys: { openstates: !!process.env.OPENSTATES_API_KEY, govinfo: !!process.env.GOVINFO_API_KEY },
  });
});

/* auth */
app.post('/api/auth/register', register);
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user) || null }));

app.put('/api/settings', requireUser, (req, res) => {
  const settings = req.body || {};
  // API keys stay in the browser; strip anything that looks like one.
  for (const k of Object.keys(settings)) if (/key/i.test(k)) delete settings[k];
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings).slice(0, 10000), req.user.id);
  res.json({ ok: true });
});

/* search + documents */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Enter a keyword' });
  const scope = ['all', 'state', 'federal'].includes(req.query.scope) ? req.query.scope : 'all';
  res.json(await searchAll({ q, stateCode: req.query.state, scope, keys: userKeys(req) }));
});

app.get('/api/doc', async (req, res) => {
  try {
    res.json(await getDocument(String(req.query.src), String(req.query.id), userKeys(req)));
  } catch (err) {
    const msg =
      err.status === 429
        ? 'This source is rate-limited right now. If it is the US Code, add a free api.data.gov key in Settings'
        : err.message;
    res.status(err.status === 404 ? 404 : 502).json({ error: msg });
  }
});

/* reading history */
const historyRow = (r) => ({
  key: r.doc_key,
  src: r.src,
  id: r.doc_id,
  title: r.title,
  citation: r.citation,
  meta: r.meta,
  url: r.url,
  progress: r.progress,
  anchor: r.anchor,
  openedAt: r.opened_at,
  updatedAt: r.updated_at,
});

app.get('/api/history', requireUser, (req, res) => {
  const rows = db.prepare('SELECT * FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300').all(req.user.id);
  res.json({ items: rows.map(historyRow) });
});

const upsertHistory = db.prepare(`
  INSERT INTO history (user_id, doc_key, src, doc_id, title, citation, meta, url, progress, anchor, opened_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, doc_key) DO UPDATE SET
    title = excluded.title, citation = excluded.citation, meta = excluded.meta, url = excluded.url,
    progress = excluded.progress, anchor = excluded.anchor, updated_at = excluded.updated_at
  WHERE excluded.updated_at >= history.updated_at
`);

function saveHistory(userId, it) {
  if (!it?.src || !it?.id) return;
  const s = (v, n = 500) => (v == null ? null : String(v).slice(0, n));
  upsertHistory.run(
    userId,
    `${it.src}:${it.id}`.slice(0, 300),
    s(it.src, 20),
    s(it.id, 280),
    s(it.title),
    s(it.citation, 200),
    s(it.meta),
    s(it.url, 1000),
    Math.max(0, Math.min(1, Number(it.progress) || 0)),
    Math.max(0, Math.floor(Number(it.anchor) || 0)),
    Number(it.openedAt) || Date.now(),
    Number(it.updatedAt) || Date.now(),
  );
}

app.put('/api/history', requireUser, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 300) : [req.body];
  for (const it of items) saveHistory(req.user.id, it);
  res.json({ ok: true });
});

app.delete('/api/history', requireUser, (req, res) => {
  if (req.query.key) db.prepare('DELETE FROM history WHERE user_id = ? AND doc_key = ?').run(req.user.id, req.query.key);
  else db.prepare('DELETE FROM history WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* AI */
app.post('/api/ai/chat', chat);
app.get('/api/ai/models', listModels);

app.use(express.static(join(ROOT, 'public'), { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(join(ROOT, 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`LawLens running at http://localhost:${PORT}`);
  // Build the US Code index in the background so federal search doesn't depend on GovInfo's demo key.
  ensureLoaded('federal')
    .then((ok) => ok && console.log('[corpus] US Code index ready'))
    .catch((err) => console.error('[corpus] federal:', err.message));
});
