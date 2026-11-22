import './env.js';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store/index.js';
import { useStore, sessionMiddleware, requireUser, register, login, logout, publicUser } from './auth.js';
import { searchAll, getDocument } from './sources.js';
import { STATES } from './states.js';
import { ensureLoaded } from './corpus.js';
import { aiStatus, chat } from './ai.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = await openStore();
useStore(store);

// Async route handlers: forward rejections to Express's error handler (Express 4 doesn't do it itself).
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
// Behind a hosting proxy (Render…) set TRUST_PROXY=1 so per-IP limits see the real client IP.
const trust = process.env.TRUST_PROXY;
app.set('trust proxy', trust ? (/^\d+$/.test(trust) ? Number(trust) : trust === 'true' || trust) : 'loopback');
app.use(express.json({ limit: '2mb' }));
app.use(sessionMiddleware);

// Data-source keys come only from the server's environment; visitors never supply any.
const userKeys = () => ({});

app.get('/api/meta', (req, res) => {
  res.json({
    states: STATES,
    ai: aiStatus(),
    serverKeys: { openstates: !!process.env.OPENSTATES_API_KEY, govinfo: !!process.env.GOVINFO_API_KEY },
  });
});

/* auth */
app.post('/api/auth/register', wrap(register));
app.post('/api/auth/login', wrap(login));
app.post('/api/auth/logout', wrap(logout));
app.get('/api/auth/me', (req, res) => res.json({ user: publicUser(req.user) || null }));

app.put('/api/settings', requireUser, wrap(async (req, res) => {
  const settings = req.body && typeof req.body === 'object' ? req.body : {};
  for (const k of Object.keys(settings)) if (/key/i.test(k)) delete settings[k];
  if (JSON.stringify(settings).length > 10000) return res.status(413).json({ error: 'Settings too large' });
  await store.updateSettings(req.user.id, settings);
  res.json({ ok: true });
}));

/* search + documents */
app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'Enter a keyword' });
  const scope = ['all', 'state', 'federal'].includes(req.query.scope) ? req.query.scope : 'all';
  res.json(await searchAll({ q, stateCode: req.query.state, scope, keys: userKeys(req) }));
}));

app.get('/api/doc', async (req, res) => {
  try {
    res.json(await getDocument(String(req.query.src), String(req.query.id), userKeys(req)));
  } catch (err) {
    const msg =
      err.status === 429
        ? 'This source is busy right now (rate-limited). Please try again in a few minutes'
        : err.message;
    res.status(err.status === 404 ? 404 : 502).json({ error: msg });
  }
});

/* reading history */
function cleanHistoryItem(it) {
  if (!it?.src || !it?.id) return null;
  const s = (v, n = 500) => (v == null ? null : String(v).slice(0, n));
  return {
    key: `${it.src}:${it.id}`.slice(0, 300),
    src: s(it.src, 20),
    id: s(it.id, 280),
    title: s(it.title),
    citation: s(it.citation, 200),
    meta: s(it.meta),
    url: s(it.url, 1000),
    progress: Math.max(0, Math.min(1, Number(it.progress) || 0)),
    anchor: Math.max(0, Math.floor(Number(it.anchor) || 0)),
    openedAt: Number(it.openedAt) || Date.now(),
    updatedAt: Number(it.updatedAt) || Date.now(),
  };
}

app.get('/api/history', requireUser, wrap(async (req, res) => {
  res.json({ items: await store.listHistory(req.user.id, 300) });
}));

app.put('/api/history', requireUser, wrap(async (req, res) => {
  const items = (Array.isArray(req.body?.items) ? req.body.items.slice(0, 300) : [req.body]).map(cleanHistoryItem).filter(Boolean);
  for (const it of items) await store.upsertHistory(req.user.id, it);
  res.json({ ok: true });
}));

app.delete('/api/history', requireUser, wrap(async (req, res) => {
  await store.deleteHistory(req.user.id, req.query.key ? String(req.query.key) : null);
  res.json({ ok: true });
}));

/* AI */
app.post('/api/ai/chat', chat);

app.use(express.static(join(ROOT, 'public'), { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(join(ROOT, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[server]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`LawLens running at http://localhost:${PORT} (accounts: ${store.kind})`);
  // Fetch the most-used indexes in the background (US Code + California by default) so the first search is instant.
  for (const juris of (process.env.PRELOAD ?? 'federal,ca').split(',').map((j) => j.trim().toLowerCase()).filter(Boolean)) {
    ensureLoaded(juris)
      .then((ok) => ok && console.log(`[corpus] ${juris} index ready`))
      .catch((err) => console.error(`[corpus] ${juris}:`, err.message));
  }
});
