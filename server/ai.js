// Proxy to free-tier, OpenAI-compatible chat APIs. The user's key is passed per request and never stored.
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (free tier)',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq (free tier)',
    base: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter (free models)',
    base: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
  },
};

function provider(req) {
  const p = PROVIDERS[req.body?.provider || req.query.provider];
  const key = req.get('x-ai-key');
  if (!p) throw Object.assign(new Error('Unknown AI provider'), { status: 400 });
  if (!key) throw Object.assign(new Error('Add your AI API key in Settings.'), { status: 400 });
  return { p, key };
}

export async function listModels(req, res) {
  try {
    const { p, key } = provider(req);
    const r = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || `Provider returned ${r.status}` });
    let models = (data.data || []).map((m) => m.id.replace(/^models\//, ''));
    if (req.query.provider === 'openrouter') models = models.filter((m) => m.endsWith(':free'));
    res.json({ models: models.sort() });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}

// Streams the provider's SSE response straight through to the browser.
export async function chat(req, res) {
  try {
    const { p, key } = provider(req);
    const { model, messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages' });
    const upstream = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/aaryanbindage/lawlens',
        'X-Title': 'LawLens',
      },
      body: JSON.stringify({ model: model || p.defaultModel, messages, stream: true, temperature: 0.2 }),
      signal: AbortSignal.timeout(120000),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = (Array.isArray(j) ? j[0] : j).error?.message || text;
      } catch {}
      return res.status(upstream.status).json({ error: `${p.label}: ${String(msg).slice(0, 400)}` });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (res.headersSent) return res.end();
    res.status(err.status || 502).json({ error: err.message });
  }
}
