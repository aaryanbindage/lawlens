/* LawLens front end — hash-routed single page app, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

/* ---------------------------------- storage ---------------------------------- */

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`lawlens.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`lawlens.${key}`, JSON.stringify(value));
    } catch {}
  },
};

const DEFAULT_SETTINGS = { state: '', aiEnabled: false, provider: 'gemini', model: '', theme: 'system', contextChars: 30000 };
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
let keys = store.get('keys', {}); // API keys never leave this browser except as request headers
let meta = { states: [], providers: {}, serverKeys: {} };
let user = null;

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  store.set('settings', settings);
  applyTheme();
  if (user) api('/api/settings', { method: 'PUT', body: settings }).catch(() => {});
}
function saveKeys(patch) {
  keys = { ...keys, ...patch };
  store.set('keys', keys);
}
function applyTheme() {
  if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = settings.theme;
}
const aiReady = () => settings.aiEnabled && !!keys[`ai_${settings.provider}`];
const stateName = (code) => meta.states.find((s) => s.code === code)?.name || '';

/* ---------------------------------- helpers ---------------------------------- */

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(keys.openstates ? { 'x-openstates-key': keys.openstates } : {}),
      ...(keys.govinfo ? { 'x-govinfo-key': keys.govinfo } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

const readHref = (src, id) => `#/read?src=${encodeURIComponent(src)}&id=${encodeURIComponent(id)}`;

// Tiny, safe markdown renderer for AI output (escapes first, then formats).
function md(src) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^(#{1,4})\s+(.*)/.exec(line))) {
      closeList();
      out.push(`<h4>${inline(m[2])}</h4>`);
    } else if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) {
      if (list !== 'ul') closeList(), out.push('<ul>'), (list = 'ul');
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
      if (list !== 'ol') closeList(), out.push('<ol>'), (list = 'ol');
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

/* ---------------------------------- history ---------------------------------- */

async function loadHistory() {
  if (user) {
    try {
      return (await api('/api/history')).items;
    } catch {}
  }
  return store.get('history', []).sort((a, b) => b.updatedAt - a.updatedAt);
}

function findLocalHistory(key) {
  return store.get('history', []).find((x) => x.key === key);
}

const pendingSync = new Map();
let syncTimer;
function recordHistory(entry) {
  const item = { ...entry, key: `${entry.src}:${entry.id}`, updatedAt: Date.now() };
  const list = store.get('history', []);
  const prev = list.find((x) => x.key === item.key);
  item.openedAt = prev?.openedAt || Date.now();
  store.set('history', [item, ...list.filter((x) => x.key !== item.key)].slice(0, 300));
  if (user) {
    pendingSync.set(item.key, item);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushHistory, 1500);
  }
}
function flushHistory() {
  if (!user || !pendingSync.size) return;
  const items = [...pendingSync.values()];
  pendingSync.clear();
  const body = JSON.stringify({ items });
  // keepalive lets the final save survive navigation / tab close
  fetch('/api/history', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
addEventListener('pagehide', flushHistory);

async function removeHistory(key) {
  store.set('history', store.get('history', []).filter((x) => x.key !== key));
  if (user) await api(`/api/history?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
}

/* ---------------------------------- AI ---------------------------------- */

async function streamChat(messages, onDelta) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ai-key': keys[`ai_${settings.provider}`] || '' },
    body: JSON.stringify({ provider: settings.provider, model: settings.model || meta.providers[settings.provider]?.defaultModel, messages }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `AI request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === '[DONE]') continue;
      try {
        const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(full);
        }
      } catch {}
    }
  }
  return full;
}

const DISCLAIMER = 'AI output can be wrong or out of date and is not legal advice. Always read the actual law and consult a licensed attorney for your situation.';

function lawSystemPrompt(doc, text) {
  return `You are LawLens Analyst, a careful legal research assistant for people in the United States${settings.state ? ` (the user lives in ${stateName(settings.state)})` : ''}.
You are helping the user understand ONE specific legal text, provided below. Base your answers on that text; quote the relevant language and point to the subsection when you can. If the text does not answer a question, say so plainly and suggest what other law might. Use plain English, short headings and bullet points. You are not a lawyer and this is not legal advice — mention that only briefly when it matters.

LAW: ${doc.citation} — ${doc.title}
SOURCE: ${doc.meta} (${doc.url})
${text.truncated ? `NOTE: Only the first ${text.value.length.toLocaleString()} characters are included.\n` : ''}
--- BEGIN TEXT ---
${text.value}
--- END TEXT ---`;
}

function analystSystemPrompt() {
  const st = settings.state ? stateName(settings.state) : null;
  return `You are LawLens Analyst, a legal research assistant that helps people in the United States find the specific laws that apply to their situation.
${st ? `The user lives in ${st}. Prioritize ${st} state statutes and regulations, then federal law.` : 'The user has not chosen a state; cover federal law and explain how state law usually varies, and suggest they pick a state.'}

For each question:
1. Briefly restate the legal issue(s).
2. List the most relevant laws with precise citations (e.g. "${st ? 'the state code section, e.g. Tex. Est. Code § 201.001' : '42 U.S.C. § 1983'}"), each with a one or two sentence plain-English explanation of why it matters to this situation.
3. Explain which facts would change the answer and what questions to look into.
4. Suggest practical next steps (documents to request, agencies, when to see an attorney).
Be accurate. If you are not sure a citation exists, say "verify this citation". Never invent section numbers confidently. Keep it concise and use markdown headings and bullet points. This is legal information, not legal advice.

On the very last line, output exactly: SEARCH: <2 to 4 short keyword phrases separated by semicolons> — phrases the user could search in official law databases (e.g. "intestate succession; probate small estate").`;
}

function docTextForAI(doc) {
  const max = Number(settings.contextChars) || 30000;
  const t = doc.text || '';
  return { value: t.slice(0, max), truncated: t.length > max };
}

/* ---------------------------------- auth UI ---------------------------------- */

function renderAccountBtn() {
  const btn = $('#accountBtn');
  btn.textContent = user ? user.name || user.email.split('@')[0] : 'Sign in';
  btn.title = user ? `Signed in as ${user.email} — click to sign out` : 'Sign in or create an account';
}

let authMode = 'login';
function openAuth(mode = 'login') {
  authMode = mode;
  const reg = mode === 'register';
  $('#authTitle').textContent = reg ? 'Create your account' : 'Sign in';
  $('#authSub').textContent = reg
    ? 'Save your reading history and pick up where you left off on any device.'
    : 'Sync your reading history across devices.';
  $('#nameField').hidden = !reg;
  $('#authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('#authSwitchText').textContent = reg ? 'Already have an account?' : 'No account?';
  $('#authSwitch').textContent = reg ? 'Sign in' : 'Create one';
  $('#authForm [name=password]').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authError').hidden = true;
  $('#authDialog').showModal();
}

$('#authSwitch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
$('#authCancel').onclick = () => $('#authDialog').close();
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  const err = $('#authError');
  err.hidden = true;
  try {
    const data = await api(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: form });
    await onSignedIn(data.user);
    $('#authDialog').close();
    e.target.reset();
    toast(authMode === 'register' ? 'Account created — your reading is now saved.' : `Welcome back${user.name ? `, ${user.name}` : ''}.`);
    route();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#accountBtn').onclick = async () => {
  if (!user) return openAuth('login');
  if (!confirm(`Sign out of ${user.email}?`)) return;
  flushHistory();
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  user = null;
  renderAccountBtn();
  toast('Signed out.');
  route();
};

async function onSignedIn(u) {
  user = u;
  // Server settings win, except a state picked as a guest is kept if the account has none.
  settings = { ...DEFAULT_SETTINGS, ...settings, ...u.settings, state: u.settings?.state || settings.state };
  store.set('settings', settings);
  applyTheme();
  renderAccountBtn();
  syncStatePicker();
  // Push guest reading history up to the account.
  const local = store.get('history', []);
  if (local.length) await api('/api/history', { method: 'PUT', body: { items: local } }).catch(() => {});
}

/* ---------------------------------- state picker ---------------------------------- */

function syncStatePicker() {
  $('#stateSelect').value = settings.state || '';
}
$('#stateSelect').addEventListener('change', (e) => {
  saveSettings({ state: e.target.value });
  toast(e.target.value ? `State set to ${stateName(e.target.value)}.` : 'State cleared — federal law only.');
  const { name, params } = parseHash();
  if (name === 'search' && params.get('q')) route();
});

/* ---------------------------------- router ---------------------------------- */

function parseHash() {
  const [path, qs] = (location.hash.slice(2) || 'search').split('?');
  return { name: path || 'search', params: new URLSearchParams(qs || '') };
}

let cleanup = () => {};
function route() {
  cleanup();
  cleanup = () => {};
  const { name, params } = parseHash();
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  const views = { search: renderSearch, read: renderReader, analyst: renderAnalyst, reading: renderReading, settings: renderSettings };
  (views[name] || renderSearch)(params);
}
addEventListener('hashchange', () => {
  route();
  if (parseHash().name !== 'read') scrollTo(0, 0);
});

/* ---------------------------------- Search view ---------------------------------- */

const EXAMPLES = ['car ownership', 'inheritance', 'tenant rights', 'minimum wage', 'firearm purchase', 'child custody', 'small claims', 'data privacy'];

async function renderSearch(params) {
  const q = params.get('q') || '';
  const scope = params.get('scope') || 'all';
  const st = settings.state;
  view.innerHTML = `
    <section class="hero">
      <h1>Find the law that applies to you</h1>
      <p>Search ${st ? `<strong>${esc(stateName(st))}</strong> and ` : ''}federal statutes, acts and regulations by keyword — then read them in full, with your place saved.</p>
      <form class="searchbar" id="searchForm" role="search">
        <input id="q" name="q" type="search" placeholder="Try “car ownership”, “inheritance”, “security deposit”…" value="${esc(q)}" autocomplete="off" aria-label="Search laws" />
        <button class="btn primary" type="submit">Search</button>
      </form>
      <div class="scope" role="group" aria-label="Scope">
        ${['all', 'state', 'federal']
          .map((s) => `<button type="button" class="chip" data-scope="${s}" aria-pressed="${s === scope}">${s === 'all' ? 'State + federal' : s === 'state' ? `${st ? esc(stateName(st)) : 'State'} only` : 'Federal only'}</button>`)
          .join('')}
      </div>
      ${q ? '' : `<div class="examples">${EXAMPLES.map((e) => `<button type="button" class="chip" data-example="${esc(e)}">${esc(e)}</button>`).join('')}</div>`}
    </section>
    <div id="continueSlot"></div>
    <section id="results"></section>`;

  const go = (query, sc = scope) => {
    location.hash = `#/search?q=${encodeURIComponent(query)}&scope=${sc}`;
  };
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#q').value.trim();
    if (v) go(v);
  };
  view.querySelectorAll('[data-scope]').forEach((b) => (b.onclick = () => (q ? go(q, b.dataset.scope) : (location.hash = `#/search?scope=${b.dataset.scope}`))));
  view.querySelectorAll('[data-example]').forEach((b) => (b.onclick = () => go(b.dataset.example)));

  if (!q) {
    $('#q').focus();
    const hist = (await loadHistory()).find((x) => x.progress < 0.98);
    if (hist && parseHash().name === 'search')
      $('#continueSlot').append(
        h(`<div style="max-width:760px;margin:24px auto 0">
            <div class="muted small" style="margin-bottom:6px">Continue where you left off</div>
            ${historyCard(hist, true)}
          </div>`),
      );
    return;
  }

  const results = $('#results');
  if (scope === 'state' && !st) {
    results.innerHTML = `<p class="notice">Pick your state at the top of the page to search state law.</p>`;
    return;
  }
  results.innerHTML = `<div class="results-head"><h2>Results for “${esc(q)}”</h2></div><div class="cards">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&state=${encodeURIComponent(st)}&scope=${scope}`);
    if (parseHash().params.get('q') !== q) return; // user moved on
    renderResults(results, data, q);
  } catch (err) {
    results.innerHTML = `<p class="notice">Search failed: ${esc(err.message)}</p>`;
  }
}

function resultCard(it) {
  return `<a class="card" href="${readHref(it.src, it.id)}">
    <div class="cite">${esc(it.citation)}</div>
    <div class="ttl">${esc(it.title)}</div>
    <div class="meta">${esc(it.meta)}</div>
    ${it.snippet ? `<div class="snip">${esc(it.snippet)}</div>` : ''}
  </a>`;
}

function renderResults(container, data, q) {
  const total = data.groups.reduce((n, g) => n + (g.items?.length || 0), 0);
  container.innerHTML = `
    <div class="results-head">
      <h2>Results for “${esc(q)}”</h2>
      <span class="muted small">${data.searchedAs ? `Searched as “${esc(data.searchedAs)}” · ` : ''}${total} documents${data.state ? ` · ${esc(data.state.name)} + federal` : ' · federal only (choose a state for state law)'}</span>
    </div>
    ${aiReady() ? `<p class="notice">Not sure which of these applies to you? <a href="#/analyst?ask=${encodeURIComponent(`What laws apply to "${q}"?`)}">Ask the Analyst</a> to explain your situation.</p>` : ''}`;

  for (const g of data.groups) {
    const sec = h(`<section class="group">
      <div class="group-head"><span class="badge ${g.level}">${g.level}</span><h3>${esc(g.label)}</h3>${g.items ? `<span class="count">${g.items.length}</span>` : ''}</div>
      <div class="cards"></div>
    </section>`);
    const cards = $('.cards', sec);
    if (g.loading) {
      const pct = Math.round((g.loading.progress || 0) * 100);
      cards.innerHTML = `<div class="notice">
        <strong>Preparing the full text of this code for search (first time only).</strong> ${esc(g.loading.message || '')}
        <div class="bar"><div style="width:${pct}%"></div></div>
        <div class="small" style="margin-top:6px">Results will appear here automatically.</div></div>`;
    } else if (g.links) {
      cards.innerHTML = g.links
        .map((l) => `<a class="card ext" href="${esc(l.url)}" target="_blank" rel="noopener"><div class="ttl">${esc(l.title)}</div><div class="meta">${esc(l.note)}</div></a>`)
        .join('');
      if (aiReady())
        cards.append(
          h(`<a class="card" href="#/analyst?ask=${encodeURIComponent(`Which ${data.state.name} statutes cover "${q}"? Give exact code sections.`)}">
            <div class="cite">Analyst</div><div class="ttl">Ask AI which ${esc(data.state.name)} code sections cover “${esc(q)}”</div>
            <div class="meta">Gets exact citations you can look up, explained in plain English.</div></a>`),
        );
    } else if (g.error) {
      cards.innerHTML = `<p class="notice">${esc(g.error)}${g.needsKey ? ` <a href="#/settings">Open Settings</a>` : ''}</p>`;
    } else if (!g.items.length) {
      cards.innerHTML = `<p class="notice">${g.note ? esc(g.note) : 'No matches here.'}</p>`;
    } else {
      if (g.note) sec.insertBefore(h(`<p class="notice" style="margin-bottom:10px">${esc(g.note)}</p>`), cards);
      const first = g.items.slice(0, 5);
      cards.innerHTML = first.map(resultCard).join('');
      if (g.items.length > 5) {
        const more = h(`<button class="btn sm more" type="button">Show ${g.items.length - 5} more</button>`);
        more.onclick = () => {
          cards.innerHTML = g.items.map(resultCard).join('');
          more.remove();
        };
        sec.append(more);
      }
    }
    container.append(sec);
  }

  // Re-run the search while a code is still being indexed for the first time.
  if (data.groups.some((g) => g.loading)) {
    const timer = setTimeout(async () => {
      const { name, params } = parseHash();
      if (name !== 'search' || params.get('q') !== q) return;
      try {
        const fresh = await api(`/api/search?q=${encodeURIComponent(q)}&state=${encodeURIComponent(settings.state)}&scope=${params.get('scope') || 'all'}`);
        if (parseHash().params.get('q') === q) renderResults(container, fresh, q);
      } catch {}
    }, 3000);
    const prev = cleanup;
    cleanup = () => {
      clearTimeout(timer);
      prev();
    };
  }
}

/* ---------------------------------- Reader view ---------------------------------- */

async function renderReader(params) {
  const src = params.get('src');
  const id = params.get('id');
  const key = `${src}:${id}`;
  view.innerHTML = `<div class="reader no-ai"><div><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:400px;margin-top:18px"></div></div></div>`;

  let doc;
  try {
    doc = await api(`/api/doc?src=${encodeURIComponent(src)}&id=${encodeURIComponent(id)}`);
  } catch (err) {
    view.innerHTML = `<p class="notice">Couldn’t load this document: ${esc(err.message)}. ${err.message.includes('key') ? '<a href="#/settings">Open Settings</a>' : ''}</p>`;
    return;
  }
  if (parseHash().params.get('id') !== id) return;

  const prior = user ? (await loadHistory()).find((x) => x.key === key) : findLocalHistory(key);
  const showAI = aiReady();

  view.innerHTML = `
    <div class="progress-rail"><div id="rail"></div></div>
    <div class="reader ${showAI ? '' : 'no-ai'}">
      <article>
        <div class="doc-head">
          <a href="javascript:history.back()" class="small">← Back</a>
          <div class="cite" style="margin-top:10px">${esc(doc.citation)}</div>
          <h1>${esc(doc.title)}</h1>
          <div class="muted small">${esc(doc.meta)}</div>
          <div class="row">
            <a class="btn sm" href="${esc(doc.url)}" target="_blank" rel="noopener">Official source ↗</a>
            <button class="btn sm" type="button" id="copyCite">Copy citation</button>
            ${showAI ? '' : `<a class="btn sm" href="#/settings">✦ Enable AI summaries</a>`}
            <span class="muted small" id="saveState">${user ? '' : 'Saved on this device · sign in to sync'}</span>
          </div>
          ${doc.partial ? `<p class="notice" style="margin-top:14px">The full bill text is published as a file on the legislature’s site — use the version links below to read it.</p>` : ''}
        </div>
        <div class="doc" id="docBody">${doc.html}</div>
      </article>
      ${showAI ? lawPanelHTML() : ''}
    </div>`;

  $('#copyCite').onclick = () => navigator.clipboard?.writeText(`${doc.citation} — ${doc.title}`).then(() => toast('Citation copied.'));

  /* progress tracking */
  const body = $('#docBody');
  const blocks = [...body.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, pre, tr, blockquote')];
  const topOffset = () => $('.topbar').offsetHeight + 12;
  const measure = () => {
    const rect = body.getBoundingClientRect();
    const seen = innerHeight - rect.top;
    const progress = Math.max(0, Math.min(1, seen / rect.height));
    let anchor = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].getBoundingClientRect().bottom > topOffset()) {
        anchor = i;
        break;
      }
    }
    return { progress: progress > 0.985 ? 1 : progress, anchor };
  };
  const save = () => {
    const { progress, anchor } = measure();
    $('#rail').style.width = `${progress * 100}%`;
    recordHistory({ src, id, title: doc.title, citation: doc.citation, meta: doc.meta, url: doc.url, progress, anchor });
    const s = $('#saveState');
    if (s && user) s.textContent = `Saved · ${Math.round(progress * 100)}% read`;
  };
  let t;
  const onScroll = () => {
    $('#rail').style.width = `${measure().progress * 100}%`;
    clearTimeout(t);
    t = setTimeout(save, 600);
  };
  addEventListener('scroll', onScroll, { passive: true });
  cleanup = () => {
    removeEventListener('scroll', onScroll);
    clearTimeout(t);
    flushHistory();
  };

  // Resume at the saved paragraph (by element index, so it survives font/window size changes).
  if (prior && prior.anchor > 0 && blocks[prior.anchor] && prior.progress < 1) {
    const target = blocks[prior.anchor];
    requestAnimationFrame(() => {
      scrollTo({ top: target.getBoundingClientRect().top + scrollY - topOffset(), behavior: 'instant' });
      target.classList.add('resume-flag');
      setTimeout(() => target.classList.remove('resume-flag'), 2500);
      toast(`Resumed at ${Math.round(prior.progress * 100)}% — where you left off.`);
    });
  } else {
    scrollTo(0, 0);
  }
  setTimeout(save, 400);

  if (showAI) wireLawPanel(doc);
}

function lawPanelHTML() {
  return `<aside class="ai-panel" aria-label="Analyst">
    <header>
      <h3><span class="spark">✦</span> Analyst</h3>
      <div class="row" style="margin-top:10px">
        <button class="btn sm primary" type="button" id="sumBtn">Summarize</button>
        <button class="btn sm" type="button" data-q="Who does this law apply to, and what does it require of them?">Who it applies to</button>
        <button class="btn sm" type="button" data-q="What are the penalties or consequences for violating this, and are there exceptions?">Penalties & exceptions</button>
      </div>
    </header>
    <div class="msgs" id="lawMsgs"><p class="muted small">Ask anything about this law — e.g. “Does this apply if the car is a gift?”</p></div>
    <form id="lawForm">
      <textarea class="input" id="lawInput" rows="1" placeholder="Ask about this law…"></textarea>
      <button class="btn primary" type="submit">Ask</button>
    </form>
  </aside>`;
}

function wireLawPanel(doc) {
  const text = docTextForAI(doc);
  const history = [{ role: 'system', content: lawSystemPrompt(doc, text) }];
  const msgs = $('#lawMsgs');
  let busy = false;

  async function ask(display, prompt = display) {
    if (busy) return;
    busy = true;
    if (history.length === 1) msgs.innerHTML = '';
    msgs.append(h(`<div class="msg user">${esc(display)}</div>`));
    const out = h(`<div class="msg ai typing"></div>`);
    msgs.append(out);
    msgs.scrollTop = msgs.scrollHeight;
    history.push({ role: 'user', content: prompt });
    try {
      const full = await streamChat(history, (s) => {
        out.innerHTML = md(s);
        msgs.scrollTop = msgs.scrollHeight;
      });
      history.push({ role: 'assistant', content: full });
      out.classList.remove('typing');
      if (!full) out.innerHTML = '<p class="muted">(No response — try another model in Settings.)</p>';
    } catch (err) {
      history.pop();
      out.className = 'msg err';
      out.textContent = err.message;
    }
    busy = false;
  }

  $('#sumBtn').onclick = () =>
    ask(
      'Summarize this law',
      'Summarize this law in plain English. Use these headings: What it covers; Who it applies to; Key rules and requirements; Rights it gives people; Penalties or consequences; Exceptions; Key definitions. Keep it tight and cite subsections.' +
        (text.truncated ? ' Note that only part of the text was provided.' : ''),
    );
  document.querySelectorAll('.ai-panel [data-q]').forEach((b) => (b.onclick = () => ask(b.dataset.q)));
  $('#lawForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#lawInput').value.trim();
    if (!v) return;
    $('#lawInput').value = '';
    ask(v);
  };
  $('#lawInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#lawForm').requestSubmit();
    }
  };
}

/* ---------------------------------- Analyst view ---------------------------------- */

let analystThread = store.get('analystThread', []);

function renderAnalyst(params) {
  if (!aiReady()) {
    view.innerHTML = `<div class="analyst"><div class="panel empty-state">
      <h2>✦ Meet the Analyst</h2>
      <p>Describe your situation in plain words and the Analyst finds the ${settings.state ? esc(stateName(settings.state)) + ' and ' : ''}federal laws that apply, explains them, and links you to the text.</p>
      <p>It runs on a <strong>free</strong> AI key (Google Gemini, Groq or OpenRouter). Turn it on in Settings — it takes about a minute.</p>
      <a class="btn primary" href="#/settings">Set up AI in Settings</a>
    </div></div>`;
    return;
  }
  const st = settings.state ? stateName(settings.state) : '';
  view.innerHTML = `
    <div class="analyst">
      <div class="results-head" style="margin-top:0">
        <h2 style="font-size:26px">✦ Analyst</h2>
        <div class="row"><span class="muted small">${st ? `Focusing on ${esc(st)} + federal law` : 'No state selected — federal focus'}</span>
        <button class="btn sm ghost" type="button" id="newChat">New conversation</button></div>
      </div>
      <div class="analyst-chat">
        <div class="msgs" id="aMsgs"></div>
        <form id="aForm">
          <textarea class="input" id="aInput" rows="2" placeholder="Describe your situation, e.g. “My friend says I haven’t inherited this money, I think I did — what laws help here?”"></textarea>
          <button class="btn primary" type="submit">Ask</button>
        </form>
      </div>
      <p class="disclaimer">${DISCLAIMER}</p>
    </div>`;

  const msgs = $('#aMsgs');
  const STARTERS = [
    'My friend says I haven’t inherited this money, I think I did. What laws will help here?',
    'I bought a used car but the seller never gave me the title. What are my rights?',
    'My landlord kept my whole security deposit. Which laws cover this?',
    'Can my employer refuse to pay overtime if I’m salaried?',
  ];

  function paint() {
    msgs.innerHTML = '';
    if (!analystThread.length) {
      const empty = h(`<div class="empty-state"><h2>What’s going on?</h2><p>Explain it like you would to a friend. The Analyst will point you to the exact laws.</p><div class="starter"></div></div>`);
      STARTERS.forEach((s) => {
        const b = h(`<button type="button"></button>`);
        b.textContent = s;
        b.onclick = () => send(s);
        $('.starter', empty).append(b);
      });
      msgs.append(empty);
      return;
    }
    for (const m of analystThread) msgs.append(m.role === 'user' ? h(`<div class="msg user">${esc(m.content)}</div>`) : aiMessage(m.content));
  }

  function splitSearch(text) {
    const m = /\n?\s*SEARCH:\s*(.+)\s*$/i.exec(text);
    if (!m) return { body: text, terms: [] };
    return { body: text.slice(0, m.index), terms: m[1].split(/[;|]/).map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 4) };
  }

  function aiMessage(text, el = h('<div class="msg ai"></div>')) {
    const { body, terms } = splitSearch(text);
    el.innerHTML = md(body);
    if (terms.length) {
      const box = h(`<div><div class="muted small" style="margin-top:6px">Look these up in official databases${st ? ` (${esc(st)} + federal)` : ''}:</div><div class="followups"></div><div class="inline-results"></div></div>`);
      terms.forEach((term) => {
        const chip = h(`<button type="button" class="chip">🔎 ${esc(term)}</button>`);
        chip.onclick = () => inlineSearch(term, $('.inline-results', box));
        $('.followups', box).append(chip);
      });
      el.append(box);
    }
    return el;
  }

  async function inlineSearch(term, box) {
    box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(term)}&state=${encodeURIComponent(settings.state)}&scope=all`);
      const parts = [];
      for (const g of data.groups) {
        if (g.links) parts.push(...g.links.slice(0, 1).map((l) => `<a class="card ext" href="${esc(l.url)}" target="_blank" rel="noopener"><div class="cite">${esc(g.label)}</div><div class="ttl">${esc(l.title)}</div></a>`));
        else if (g.items?.length) parts.push(...g.items.slice(0, 2).map(resultCard));
      }
      box.innerHTML = parts.join('') || '<p class="notice">No matches in the databases — try the chip with different words.</p>';
      box.prepend(h(`<a class="small" href="#/search?q=${encodeURIComponent(term)}&scope=all">See all results for “${esc(term)}” →</a>`));
    } catch (err) {
      box.innerHTML = `<p class="notice">${esc(err.message)}</p>`;
    }
  }

  let busy = false;
  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    if (!analystThread.length) msgs.innerHTML = '';
    analystThread.push({ role: 'user', content: text });
    msgs.append(h(`<div class="msg user">${esc(text)}</div>`));
    const out = h('<div class="msg ai typing"></div>');
    msgs.append(out);
    out.scrollIntoView({ block: 'nearest' });
    try {
      const full = await streamChat([{ role: 'system', content: analystSystemPrompt() }, ...analystThread.slice(-12)], (s) => {
        out.innerHTML = md(splitSearch(s).body.replace(/\n?\s*SEARCH:.*$/i, ''));
      });
      out.classList.remove('typing');
      analystThread.push({ role: 'assistant', content: full });
      store.set('analystThread', analystThread);
      aiMessage(full, out);
    } catch (err) {
      analystThread.pop();
      out.className = 'msg err';
      out.textContent = err.message;
    }
    busy = false;
  }

  $('#aForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#aInput').value;
    $('#aInput').value = '';
    send(v);
  };
  $('#aInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#aForm').requestSubmit();
    }
  };
  $('#newChat').onclick = () => {
    analystThread = [];
    store.set('analystThread', []);
    paint();
  };

  paint();
  const ask = params.get('ask');
  if (ask) {
    history.replaceState(null, '', '#/analyst');
    send(ask);
  }
}

/* ---------------------------------- Continue reading view ---------------------------------- */

function historyCard(it, hero = false) {
  const pct = Math.round((it.progress || 0) * 100);
  return `<a class="card ${hero ? 'continue-hero' : ''}" href="${readHref(it.src, it.id)}">
    <div class="cite">${esc(it.citation)}</div>
    <div class="ttl">${esc(it.title)}</div>
    <div class="meta">${pct >= 100 ? 'Finished' : `${pct}% read`} · ${timeAgo(it.updatedAt)}${hero ? ' · <strong>Resume →</strong>' : ''}</div>
    <div class="bar"><div style="width:${pct}%"></div></div>
  </a>`;
}

async function renderReading() {
  view.innerHTML = `<div class="settings" style="max-width:820px">
    <div class="results-head" style="margin-top:0"><h2 style="font-size:26px">Continue reading</h2>
      <button class="btn sm ghost danger" type="button" id="clearHist" hidden>Clear history</button></div>
    ${user ? '' : `<p class="notice">Your reading is saved on this device. <button class="link" type="button" id="signInHint">Sign in or create an account</button> to keep it across devices.</p>`}
    <div id="histList"><div class="skeleton"></div></div>
  </div>`;
  $('#signInHint')?.addEventListener('click', () => openAuth('register'));

  const items = await loadHistory();
  const list = $('#histList');
  if (!items.length) {
    list.innerHTML = `<div class="panel empty-state"><h2>Nothing here yet</h2><p>Open any law from a search and your place is saved automatically.</p><a class="btn primary" href="#/search">Search laws</a></div>`;
    return;
  }
  $('#clearHist').hidden = false;
  $('#clearHist').onclick = async () => {
    if (!confirm('Clear your entire reading history?')) return;
    store.set('history', []);
    if (user) await api('/api/history', { method: 'DELETE' }).catch(() => {});
    renderReading();
  };

  const inProgress = items.filter((x) => x.progress < 0.985);
  const done = items.filter((x) => x.progress >= 0.985);
  const section = (title, arr) =>
    arr.length
      ? `<h3 style="font:600 14px var(--sans);color:var(--muted);margin:18px 0 8px">${title}</h3><div class="hist">${arr
          .map((it) => `<div class="hist-item" data-key="${esc(it.key)}">${historyCard(it)}<button class="btn sm ghost" type="button" title="Remove">✕</button></div>`)
          .join('')}</div>`
      : '';
  list.innerHTML = section('In progress', inProgress) + section('Finished', done);
  list.querySelectorAll('.hist-item button').forEach(
    (b) =>
      (b.onclick = async () => {
        const row = b.closest('.hist-item');
        await removeHistory(row.dataset.key);
        row.remove();
      }),
  );
}

/* ---------------------------------- Settings view ---------------------------------- */

function renderSettings() {
  const p = meta.providers;
  const prov = settings.provider;
  view.innerHTML = `<div class="settings">
    <h2 style="font-size:26px;margin:0">Settings</h2>

    <section class="panel">
      <label class="switch"><span>✦ AI features (Analyst)<br><span class="hint">Summaries, chat with a law, and the Analyst tab.</span></span>
        <input type="checkbox" id="aiEnabled" ${settings.aiEnabled ? 'checked' : ''} /></label>
      <div id="aiFields" ${settings.aiEnabled ? '' : 'hidden'} style="margin-top:16px;display:grid;gap:12px">
        <div class="grid2">
          <label class="field">Provider
            <select id="provider">${Object.entries(p).map(([k, v]) => `<option value="${k}" ${k === prov ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
          </label>
          <label class="field">Model
            <input id="model" list="modelList" placeholder="${esc(p[prov]?.defaultModel || '')}" value="${esc(settings.model)}" />
            <datalist id="modelList"></datalist>
          </label>
        </div>
        <label class="field">API key
          <input id="aiKey" type="password" autocomplete="off" placeholder="Paste your free key" value="${esc(keys[`ai_${prov}`] || '')}" />
          <span class="hint">Get a free key: <a id="keyLink" href="${esc(p[prov]?.keyUrl)}" target="_blank" rel="noopener">${esc(p[prov]?.keyUrl)}</a>. Stored only in this browser; sent to the provider through this app’s server per request, never saved there.</span>
        </label>
        <div class="row"><button class="btn sm" type="button" id="testAI">Test connection</button><button class="btn sm ghost" type="button" id="loadModels">Load available models</button><span class="status" id="aiStatus"></span></div>
        <label class="field">Law text sent to AI (characters)
          <input id="contextChars" type="number" min="4000" max="400000" step="1000" value="${settings.contextChars}" />
          <span class="hint">Gemini handles very long laws; Groq’s free tier works best around 20,000.</span>
        </label>
      </div>
    </section>

    <section class="panel">
      <h2>Your state</h2>
      <p class="muted">Used to find state law and to focus the Analyst.</p>
      <select class="input" id="stateSetting"><option value="">Federal only</option>${meta.states.map((s) => `<option value="${s.code}" ${s.code === settings.state ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    </section>

    <section class="panel">
      <h2>Law data sources</h2>
      <p class="muted">Federal regulations and the Federal Register work without keys. These free keys unlock more.</p>
      <div style="display:grid;gap:12px">
        <label class="field">Open States API key ${meta.serverKeys.openstates ? '<span class="hint">(server key already configured — optional)</span>' : ''}
          <input id="osKey" type="password" autocomplete="off" value="${esc(keys.openstates || '')}" placeholder="Enables state legislation search" />
          <span class="hint">Free at <a href="https://openstates.org/accounts/signup/" target="_blank" rel="noopener">openstates.org</a> → profile → API key. Searches bills and enacted laws in all 50 states.</span>
        </label>
        <label class="field">api.data.gov key (GovInfo) ${meta.serverKeys.govinfo ? '<span class="hint">(server key already configured — optional)</span>' : ''}
          <input id="govKey" type="password" autocomplete="off" value="${esc(keys.govinfo || '')}" placeholder="Optional — raises US Code search limits" />
          <span class="hint">US Code and Public Law search uses a shared demo key (≈30 searches/hour). A free key from <a href="https://api.data.gov/signup/" target="_blank" rel="noopener">api.data.gov</a> raises that to 1,000/hour.</span>
        </label>
      </div>
    </section>

    <section class="panel">
      <h2>Appearance</h2>
      <div class="scope" style="justify-content:flex-start;margin-top:10px">${['system', 'light', 'dark'].map((t) => `<button type="button" class="chip" data-theme-opt="${t}" aria-pressed="${settings.theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    </section>

    <section class="panel">
      <h2>Account</h2>
      ${user ? `<p class="muted">Signed in as <strong>${esc(user.email)}</strong>. Reading history and settings sync to your account (API keys stay on this device).</p>` : `<p class="muted">You’re using LawLens as a guest — reading history is kept in this browser only.</p><div class="row"><button class="btn primary" type="button" id="regBtn">Create account</button><button class="btn" type="button" id="loginBtn">Sign in</button></div>`}
    </section>
  </div>`;

  const status = (msg, ok) => {
    const s = $('#aiStatus');
    s.textContent = msg;
    s.className = `status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
  };

  $('#aiEnabled').onchange = (e) => {
    saveSettings({ aiEnabled: e.target.checked });
    $('#aiFields').hidden = !e.target.checked;
  };
  $('#provider').onchange = (e) => {
    saveSettings({ provider: e.target.value, model: '' });
    renderSettings();
  };
  $('#model').onchange = (e) => saveSettings({ model: e.target.value.trim() });
  $('#aiKey').onchange = (e) => saveKeys({ [`ai_${settings.provider}`]: e.target.value.trim() });
  $('#contextChars').onchange = (e) => saveSettings({ contextChars: Math.max(4000, Number(e.target.value) || 30000) });
  $('#loadModels').onclick = async () => {
    status('Loading models…');
    try {
      const { models } = await api(`/api/ai/models?provider=${settings.provider}`, { headers: { 'x-ai-key': keys[`ai_${settings.provider}`] || '' } });
      $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
      status(`${models.length} models available — click the Model box to choose.`, true);
    } catch (err) {
      status(err.message, false);
    }
  };
  $('#testAI').onclick = async () => {
    status('Testing…');
    try {
      const reply = await streamChat([{ role: 'user', content: 'Reply with exactly: LawLens connected' }], () => {});
      status(reply ? `Connected ✓ (${settings.model || meta.providers[settings.provider].defaultModel})` : 'Connected, but the model returned nothing — try another model.', !!reply);
    } catch (err) {
      status(err.message, false);
    }
  };
  $('#stateSetting').onchange = (e) => {
    saveSettings({ state: e.target.value });
    syncStatePicker();
  };
  $('#osKey').onchange = (e) => {
    saveKeys({ openstates: e.target.value.trim() });
    toast('Open States key saved.');
  };
  $('#govKey').onchange = (e) => {
    saveKeys({ govinfo: e.target.value.trim() });
    toast('GovInfo key saved.');
  };
  view.querySelectorAll('[data-theme-opt]').forEach(
    (b) =>
      (b.onclick = () => {
        saveSettings({ theme: b.dataset.themeOpt });
        view.querySelectorAll('[data-theme-opt]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      }),
  );
  $('#regBtn')?.addEventListener('click', () => openAuth('register'));
  $('#loginBtn')?.addEventListener('click', () => openAuth('login'));
}

/* ---------------------------------- boot ---------------------------------- */

(async function boot() {
  applyTheme();
  try {
    meta = await api('/api/meta');
  } catch {}
  const sel = $('#stateSelect');
  meta.states.forEach((s) => sel.append(new Option(s.name, s.code)));
  syncStatePicker();
  try {
    const { user: u } = await api('/api/auth/me');
    if (u) await onSignedIn(u);
  } catch {}
  renderAccountBtn();
  route();
})();
