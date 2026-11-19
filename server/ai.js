// AI runs on the site owner's key from .env (AI_PROVIDER / AI_API_KEY / AI_MODEL) — visitors never supply one.
// Every provider here exposes an OpenAI-compatible chat endpoint with a free tier.
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  groq: {
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
};

function config() {
  const provider = PROVIDERS[(process.env.AI_PROVIDER || 'gemini').toLowerCase()];
  const key = process.env.AI_API_KEY || '';
  return {
    provider,
    key,
    enabled: !!(provider && key),
    model: process.env.AI_MODEL || provider?.defaultModel,
    requireAccount: process.env.AI_REQUIRE_ACCOUNT !== 'false',
    perHour: Number(process.env.AI_REQUESTS_PER_HOUR) || 30,
    contextChars: Number(process.env.AI_CONTEXT_CHARS) || 30000,
  };
}

// What the browser needs to know (never the key).
export function aiStatus() {
  const c = config();
  return {
    enabled: c.enabled,
    provider: c.provider?.label || null,
    model: c.enabled ? c.model : null,
    requireAccount: c.requireAccount,
    perHour: c.perHour,
    contextChars: c.contextChars,
  };
}

// Per-user (or per-IP for guests) hourly cap so one visitor can't exhaust the shared free quota.
const usage = new Map();
function takeQuota(who, perHour) {
  const now = Date.now();
  const recent = (usage.get(who) || []).filter((t) => now - t < 3600000);
  if (recent.length >= perHour) {
    usage.set(who, recent);
    return Math.ceil((recent[0] + 3600000 - now) / 60000);
  }
  recent.push(now);
  usage.set(who, recent);
  return 0;
}

const MAX_CHARS = 200000; // hard cap on a single request's prompt size

// Streams the provider's SSE response straight through to the browser.
export async function chat(req, res) {
  const c = config();
  if (!c.enabled) return res.status(503).json({ error: 'AI isn’t set up on this site yet.' });
  if (c.requireAccount && !req.user) return res.status(401).json({ error: 'Sign in to use the AI Analyst.' });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages' });
  const clean = messages
    .filter((m) => ['system', 'user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  if (clean.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) return res.status(413).json({ error: 'That conversation is too long — start a new one.' });

  const who = req.user ? `u${req.user.id}` : `ip${req.ip}`;
  const wait = takeQuota(who, c.perHour);
  if (wait) return res.status(429).json({ error: `You’ve reached the limit of ${c.perHour} AI requests per hour. Try again in about ${wait} min.` });
  const refund = () => usage.get(who)?.pop(); // failed calls don't count against the user

  try {
    const upstream = await fetch(`${c.provider.base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/aaryanbindage/lawlens',
        'X-Title': 'LawLens',
      },
      body: JSON.stringify({ model: c.model, messages: clean, stream: true, temperature: 0.2 }),
      signal: AbortSignal.timeout(120000),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      console.error(`[ai] ${c.provider.label} ${upstream.status}: ${text.slice(0, 300)}`);
      refund();
      const msg =
        upstream.status === 429
          ? 'The site’s free AI quota is used up for now. Please try again later.'
          : 'The AI service returned an error. Please try again in a moment.';
      return res.status(upstream.status === 429 ? 429 : 502).json({ error: msg });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (res.headersSent) return res.end();
    refund();
    console.error('[ai]', err.message);
    res.status(502).json({ error: 'Couldn’t reach the AI service. Please try again.' });
  }
}
