import sanitizeHtml from 'sanitize-html';
import { findState, officialLinks } from './states.js';

const UA = 'LawLens/0.1 (+https://github.com/aaryanbindage/lawlens)';
const TIMEOUT_MS = 15000;

// Small in-memory cache so repeated searches don't burn rate limits (DEMO_KEY is 30 req/hr/IP).
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { value, expires: Date.now() + CACHE_TTL });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

async function get(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${new URL(url).host} returned ${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    throw err;
  }
  return res;
}
const getJson = async (url, opts) => (await get(url, opts)).json();
const getText = async (url, opts) => (await get(url, { ...opts, headers: { Accept: 'text/html,*/*', ...(opts?.headers || {}) } })).text();

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export function cleanHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'sup', 'sub', 'span', 'center']),
    allowedAttributes: { a: ['href', 'name', 'id'], '*': ['id', 'class'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
    exclusiveFilter: (frame) => frame.tag === 'a' && !frame.text.trim() && !frame.attribs.id && !frame.attribs.name,
  });
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#167;|&sect;/g, '§')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/* ---------------------------- Federal: US Code / Public Laws (GovInfo) ---------------------------- */

function govinfoKey(keys) {
  return keys.govinfo || process.env.GOVINFO_API_KEY || 'DEMO_KEY';
}

function uscCitation(granuleId) {
  const m = /title(\d+[a-z]?).*-sec(.+)$/i.exec(granuleId || '');
  return m ? `${m[1]} U.S.C. § ${m[2]}` : granuleId;
}

async function govinfoSearch(collection, q, keys, size = 12) {
  const data = await getJson(`https://api.govinfo.gov/search?api_key=${govinfoKey(keys)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `collection:${collection} AND (${q})`,
      pageSize: size * 2,
      offsetMark: '*',
      sorts: [{ field: 'score', sortOrder: 'DESC' }],
    }),
  });
  return data.results || [];
}

async function searchUSCode(q, keys) {
  const results = await govinfoSearch('USCODE', q, keys);
  // The same section appears once per annual edition — keep the newest.
  const bySection = new Map();
  for (const r of results) {
    const sectionKey = String(r.granuleId || r.packageId).replace(/^USCODE-\d{4}-/, '');
    const prev = bySection.get(sectionKey);
    if (!prev || r.dateIssued > prev.dateIssued) bySection.set(sectionKey, r);
  }
  return [...bySection.values()].slice(0, 12).map((r) => ({
    src: 'usc',
    id: `${r.packageId}|${r.granuleId || ''}`,
    title: r.title,
    citation: uscCitation(r.granuleId),
    meta: `United States Code · ${r.dateIssued?.slice(0, 4)} edition`,
    url: `https://www.govinfo.gov/app/details/${r.packageId}/${r.granuleId || ''}`,
  }));
}

async function searchPublicLaws(q, keys) {
  const results = await govinfoSearch('PLAW', q, keys, 8);
  return results.slice(0, 8).map((r) => ({
    src: 'plaw',
    id: r.packageId,
    title: r.title,
    citation: r.packageId.replace(/^PLAW-(\d+)publ(\d+)$/, 'Pub. L. $1-$2'),
    meta: `Public Law (Act of Congress) · enacted ${r.dateIssued}`,
    url: `https://www.govinfo.gov/app/details/${r.packageId}`,
  }));
}

async function docGovinfo(src, id, keys) {
  const [pkg, granule] = id.split('|');
  if (!/^[A-Za-z0-9_.-]+$/.test(pkg) || (granule && !/^[A-Za-z0-9_.-]+$/.test(granule))) throw new Error('Bad id');
  const base = granule ? `https://api.govinfo.gov/packages/${pkg}/granules/${granule}` : `https://api.govinfo.gov/packages/${pkg}`;
  const key = govinfoKey(keys);
  const [summary, html] = await Promise.all([
    getJson(`${base}/summary?api_key=${key}`),
    getText(`${base}/htm?api_key=${key}`),
  ]);
  return {
    src,
    id,
    title: summary.title,
    citation: src === 'usc' ? uscCitation(granule) : pkg.replace(/^PLAW-(\d+)publ(\d+)$/, 'Pub. L. $1-$2'),
    meta: src === 'usc' ? 'United States Code' : 'Public Law',
    url: summary.detailsLink || `https://www.govinfo.gov/app/details/${pkg}/${granule || ''}`,
    html: cleanHtml(html.replace(/<link[^>]*>/g, '')),
  };
}

/* ---------------------------- Federal: eCFR (regulations) ---------------------------- */

function cfrCitation(h) {
  if (h.section) return `${h.title} CFR § ${h.section}`;
  if (h.appendix) return `${h.title} CFR ${h.appendix}`;
  return `${h.title} CFR Part ${h.part}`;
}

async function searchECFR(q) {
  const data = await getJson(
    `https://www.ecfr.gov/api/search/v1/results?query=${encodeURIComponent(q)}&per_page=12&order=relevance&date=current`,
  );
  return (data.results || []).map((r) => {
    const h = r.hierarchy || {};
    const heads = r.headings || {};
    return {
      src: 'ecfr',
      id: `${h.title}|${h.section || ''}|${h.part || ''}`,
      title: stripTags(heads.section || heads.part || 'Regulation'),
      citation: cfrCitation(h),
      meta: `Code of Federal Regulations · ${stripTags(heads.title)} › ${stripTags(heads.part)}`,
      snippet: stripTags(r.full_text_excerpt),
      url: h.section
        ? `https://www.ecfr.gov/current/title-${h.title}/section-${h.section}`
        : `https://www.ecfr.gov/current/title-${h.title}/part-${h.part}`,
    };
  });
}

async function docECFR(id) {
  const [title, section, part] = id.split('|');
  if (!/^\d+$/.test(title)) throw new Error('Bad id');
  const render = (qs) => getText(`https://www.ecfr.gov/api/renderer/v1/content/enhanced/current/title-${title}?${qs}`);
  let html;
  try {
    html = await render(section ? `section=${encodeURIComponent(section)}` : `part=${encodeURIComponent(part)}`);
  } catch (err) {
    // The search index occasionally lists sections the renderer no longer serves; show the whole part instead.
    if (!(section && part && err.status === 404)) throw err;
    html =
      `<p class="notice">§ ${section} is not currently published on its own, so the full Part ${part} is shown.</p>` +
      (await render(`part=${encodeURIComponent(part)}`));
  }
  const heading = stripTags((/<h[1-8][^>]*>([\s\S]*?)<\/h[1-8]>/i.exec(html) || [])[1] || '');
  return {
    src: 'ecfr',
    id,
    title: heading || `Title ${title} CFR`,
    citation: section ? `${title} CFR § ${section}` : `${title} CFR Part ${part}`,
    meta: 'Code of Federal Regulations (current)',
    url: section
      ? `https://www.ecfr.gov/current/title-${title}/section-${section}`
      : `https://www.ecfr.gov/current/title-${title}/part-${part}`,
    html: cleanHtml(html),
  };
}

/* ---------------------------- Federal: Federal Register (final rules) ---------------------------- */

const FR_FIELDS = ['title', 'document_number', 'abstract', 'publication_date', 'agencies', 'type', 'html_url', 'citation'];

async function searchFR(q) {
  const params = new URLSearchParams({ 'conditions[term]': q, per_page: '10', order: 'relevance' });
  params.append('conditions[type][]', 'RULE');
  FR_FIELDS.forEach((f) => params.append('fields[]', f));
  const data = await getJson(`https://www.federalregister.gov/api/v1/documents.json?${params}`);
  return (data.results || []).map((r) => ({
    src: 'fr',
    id: r.document_number,
    title: r.title,
    citation: r.citation || `FR Doc. ${r.document_number}`,
    meta: `Federal Register final rule · ${(r.agencies || []).map((a) => a.name).filter(Boolean).join(', ')} · ${r.publication_date}`,
    snippet: r.abstract,
    url: r.html_url,
  }));
}

async function docFR(id) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Bad id');
  const params = new URLSearchParams();
  [...FR_FIELDS, 'body_html_url'].forEach((f) => params.append('fields[]', f));
  const d = await getJson(`https://www.federalregister.gov/api/v1/documents/${id}.json?${params}`);
  const html = d.body_html_url ? await getText(d.body_html_url) : `<p>${d.abstract || ''}</p>`;
  return {
    src: 'fr',
    id,
    title: d.title,
    citation: d.citation || `FR Doc. ${id}`,
    meta: `Federal Register · ${(d.agencies || []).map((a) => a.name).filter(Boolean).join(', ')} · ${d.publication_date}`,
    url: d.html_url,
    html: cleanHtml(html),
  };
}

/* ---------------------------- State: Open States (legislation) ---------------------------- */

function openstatesKey(keys) {
  return keys.openstates || process.env.OPENSTATES_API_KEY || '';
}

async function searchOpenStates(q, state, keys) {
  const key = openstatesKey(keys);
  if (!key) {
    const err = new Error('Add a free Open States API key in Settings to search state legislation.');
    err.needsKey = 'openstates';
    throw err;
  }
  const params = new URLSearchParams({ jurisdiction: state.name, q, sort: 'latest_action_desc', per_page: '15' });
  params.append('include', 'abstracts');
  const data = await getJson(`https://v3.openstates.org/bills?${params}`, { headers: { 'X-API-KEY': key } });
  return (data.results || []).map((b) => ({
    src: 'os',
    id: b.id,
    title: b.title,
    citation: `${state.code} ${b.identifier} (${b.session})`,
    meta: `${state.name} legislation · ${b.latest_action_description || 'no action'} · ${b.latest_action_date || ''}`,
    snippet: b.abstracts?.[0]?.abstract,
    url: b.openstates_url,
  }));
}

async function docOpenStates(id, keys) {
  if (!/^ocd-bill\/[a-f0-9-]+$/.test(id)) throw new Error('Bad id');
  const key = openstatesKey(keys);
  if (!key) throw new Error('An Open States API key is required (Settings).');
  const params = new URLSearchParams();
  ['abstracts', 'versions', 'actions', 'sponsorships', 'sources'].forEach((i) => params.append('include', i));
  const b = await getJson(`https://v3.openstates.org/bills/${id}?${params}`, { headers: { 'X-API-KEY': key } });
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // Try to inline the latest text version when the legislature publishes it as HTML.
  let inlineText = '';
  const versionLinks = (b.versions || []).flatMap((v) => v.links.map((l) => ({ ...l, note: v.note, date: v.date })));
  const htmlVersion = [...versionLinks].reverse().find((l) => /html|text\/plain/.test(l.media_type || ''));
  if (htmlVersion) {
    try {
      inlineText = cleanHtml(await getText(htmlVersion.url));
    } catch {
      inlineText = '';
    }
  }

  const parts = [
    `<h2>${esc(b.identifier)} — ${esc(b.title)}</h2>`,
    `<p><strong>Jurisdiction:</strong> ${esc(b.jurisdiction?.name)} · <strong>Session:</strong> ${esc(b.session)} · <strong>Chamber:</strong> ${esc(b.from_organization?.name)}</p>`,
    `<p><strong>Latest action:</strong> ${esc(b.latest_action_description)} (${esc(b.latest_action_date)})</p>`,
  ];
  if (b.abstracts?.length) parts.push('<h3>Summary</h3>', ...b.abstracts.map((a) => `<p>${esc(a.abstract)}</p>`));
  if (b.sponsorships?.length)
    parts.push('<h3>Sponsors</h3><ul>', ...b.sponsorships.map((s) => `<li>${esc(s.name)} (${esc(s.classification)})</li>`), '</ul>');
  if (versionLinks.length)
    parts.push(
      '<h3>Bill text versions</h3><ul>',
      ...versionLinks.map((l) => `<li><a href="${esc(l.url)}">${esc(l.note || 'Version')} ${esc(l.date)} (${esc(l.media_type)})</a></li>`),
      '</ul>',
    );
  if (b.actions?.length)
    parts.push('<h3>History</h3><ul>', ...b.actions.map((a) => `<li>${esc(a.date?.slice(0, 10))} — ${esc(a.description)}</li>`), '</ul>');
  if (inlineText) parts.push('<h3>Full text</h3>', inlineText);

  return {
    src: 'os',
    id,
    title: b.title,
    citation: `${b.jurisdiction?.name} ${b.identifier} (${b.session})`,
    meta: `${b.jurisdiction?.name} legislation`,
    url: b.openstates_url,
    html: cleanHtml(parts.join('\n')),
    partial: !inlineText,
  };
}

/* ---------------------------- Public API ---------------------------- */

const GROUPS = {
  usc: { label: 'Federal statutes — United States Code', level: 'federal', run: (q, s, k) => searchUSCode(q, k) },
  plaw: { label: 'Federal acts — Public Laws', level: 'federal', run: (q, s, k) => searchPublicLaws(q, k) },
  ecfr: { label: 'Federal regulations — Code of Federal Regulations', level: 'federal', run: (q) => searchECFR(q) },
  fr: { label: 'Federal rules — Federal Register', level: 'federal', run: (q) => searchFR(q) },
  os: { label: 'State legislation', level: 'state', run: (q, s, k) => searchOpenStates(q, s, k) },
};

export async function searchAll({ q, stateCode, scope = 'all', keys = {} }) {
  const state = findState(stateCode);
  const wanted = Object.entries(GROUPS).filter(([, g]) => {
    if (g.level === 'state' && !state) return false;
    return scope === 'all' || scope === g.level;
  });

  const groups = await Promise.all(
    wanted.map(async ([id, g]) => {
      const label = g.level === 'state' ? `${state.name} legislation — Open States` : g.label;
      // Keys are part of the cache key so a user adding a key isn't served a cached "needs key" error.
      const cacheKey = `${id}|${q}|${state?.code}|${id === 'os' ? openstatesKey(keys) : ''}`;
      try {
        const items = await cached(cacheKey, () => g.run(q, state, keys));
        return { id, label, level: g.level, items };
      } catch (err) {
        return { id, label, level: g.level, items: [], error: err.message, needsKey: err.needsKey || (err.status === 429 ? 'govinfo' : undefined) };
      }
    }),
  );

  if (state && scope !== 'federal') {
    groups.unshift({
      id: 'links',
      label: `${state.name} statutes — official sources`,
      level: 'state',
      links: officialLinks(state, q),
    });
  }
  return { q, state, groups };
}

export async function getDocument(src, id, keys = {}) {
  const key = `doc|${src}|${id}|${src === 'os' ? openstatesKey(keys) : ''}`;
  return cached(key, async () => {
    let doc;
    if (src === 'usc' || src === 'plaw') doc = await docGovinfo(src, id, keys);
    else if (src === 'ecfr') doc = await docECFR(id);
    else if (src === 'fr') doc = await docFR(id);
    else if (src === 'os') doc = await docOpenStates(id, keys);
    else throw new Error('Unknown source');
    doc.text = htmlToText(doc.html);
    return doc;
  });
}
