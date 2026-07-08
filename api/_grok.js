/* Grok (xAI) helper - improved for parts hunting */
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const MODEL = process.env.GROK_MODEL || 'grok-4.3';

async function fetchPageText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'FETCH ERROR: invalid url';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return 'FETCH ERROR ' + r.status + ' for ' + url;
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

  const prompt = `You are Parts Sniper — a ruthless expert at finding real vehicle parts for sale right now.

PROJECT GOAL: ${project.goal}

CATEGORIES: ${(cfg.categories || []).join(', ')}

START WITH THESE QUERIES but search further and browse pages:
${(cfg.queries || []).join('\n')}

RULES (follow exactly):
${(cfg.rules || []).join('\n')}

${good.length ? 'GOOD EXAMPLES (find similar): ' + good.map(f => f.listing_url).join(', ') : ''}
${bad.length ? 'AVOID similar to: ' + bad.map(f => f.listing_url).join(', ') : ''}

Search aggressively, open listing pages, extract accurate price, condition, seller, image. 
Return ONLY a JSON array of real current listings.`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
      temperature: 0.5,
    });

    const content = completion.choices[0].message.content;
    return extractJson(content);
  } catch (error) {
    console.error('Grok search error:', error);
    throw error;
  }
}
