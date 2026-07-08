/* Grok (xAI) helper - simplified and more reliable */
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const MODEL = process.env.GROK_MODEL || 'grok-4.3';

async function fetchPageText(url) {
  // same as before
  if (!url || !/^https?:\/\//i.test(url)) return 'FETCH ERROR: invalid url';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return 'FETCH ERROR ' + r.status;
    const html = await r.text();
    const og = html.match(/<meta[^>]+property=["']og:image[^"']*["'][^>]*content=["']([^"']+)["']/i);
    const ogLine = og ? '\nOG_IMAGE: ' + og[1].replace(/&amp;/g, '&') : '';
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                     .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
    return text.slice(0, 12000) + ogLine;
  } catch (e) {
    return 'FETCH ERROR: ' + String(e.message || e);
  }
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = fence ? fence[1] : text;
  const start = s.search(/\[|\{/);
  if (start === -1) throw new Error('No JSON found');
  s = s.slice(start).replace(/[\x00-\x1F]+/g, ' ').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    // Try to fix common truncation
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (end > 0) {
      try { return JSON.parse(s.slice(0, end + 1) + (s[0] === '[' ? ']' : '}')); } catch {}
    }
    throw new Error('JSON parse failed');
  }
}

export async function runGrokSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter(f => f.vote > 0).slice(0, 20);
  const bad = (feedback || []).filter(f => f.vote < 0).slice(0, 20);

  const prompt = `You are Parts Sniper, an expert at finding vehicle parts for sale.
Goal: ${project.goal}

Categories: ${(cfg.categories || []).join(', ')}
Queries: ${(cfg.queries || []).join(', ')}
Rules: ${(cfg.rules || []).join('; ')}

${good.length ? 'Good examples: ' + good.map(f => f.listing_url).join(', ') : ''}
${bad.length ? 'Avoid: ' + bad.map(f => f.listing_url).join(', ') : ''}

Search the web thoroughly and return ONLY a valid JSON array of listings. Each item: {"section", "title", "description", "price", "currency", "condition", "seller", "url", "image", "badges"}`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
      temperature: 0.7,
    });

    const content = completion.choices[0].message.content;
    return extractJson(content);
  } catch (error) {
    console.error('Grok API error:', error);
    throw error;
  }
}
