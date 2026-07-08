/* Grok (xAI) API helper — parallel to _anthropic.js */
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const MODEL = process.env.GROK_MODEL || 'grok-4.3';
const MAX_STEPS = Number(process.env.SEARCH_MAX_STEPS || 14);
const PAGE_CHARS = Number(process.env.FETCH_PAGE_CHARS || 12000);

async function fetchPageText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'FETCH ERROR: invalid url';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    const r = await fetch(url, { 
      signal: c.signal, 
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } 
    });
    clearTimeout(t);
    if (!r.ok) return 'FETCH ERROR ' + r.status + ' for ' + url;
    
    const html = await r.text();
    const og = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i);
    const ogLine = og ? '\nOG_IMAGE: ' + og[1].replace(/&amp;/g, '&') : '';
    
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, PAGE_CHARS) + ogLine;
  } catch (e) {
    return 'FETCH ERROR: ' + String((e && e.message) || e);
  }
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = (fence ? fence[1] : text);
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('Model did not return JSON. Raw start: ' + text.slice(0, 300));
  s = s.slice(start).replace(/[\x00-\x1F]+/g, ' ').trim();
  
  const candidates = [];
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (end !== -1) candidates.push(s.slice(0, end + 1));
  if (s[0] === '[') {
    const lastObj = s.lastIndexOf('}');
    if (lastObj !== -1) candidates.push(s.slice(0, lastObj + 1).replace(/,\s*$/, '') + ']');
  }
  candidates.push(s);
  
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) {}
  }
  throw new Error('Could not parse JSON');
}

export async function runGrokSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  const system = `You are a thorough research agent for vehicle parts. Use web_search and browse pages. 
Follow the goal, categories, queries and rules exactly. Never fabricate. Output ONLY a JSON array.`;

  const parts = [
    'PROJECT GOAL: ' + project.goal,
    'CATEGORIES: ' + (cfg.categories || []).join(' | '),
    'SEARCH QUERIES:\n- ' + (cfg.queries || []).join('\n- '),
    'RULES:\n- ' + (cfg.rules || []).join('\n- ')
  ];
  if (good.length) parts.push('GOOD EXAMPLES:\n' + good.map(f => f.listing_title + ' — ' + f.listing_url).join('\n'));
  if (bad.length) parts.push('AVOID:\n' + bad.map(f => f.listing_title).join('\n'));

  let messages = [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') + '\n\nDo the research and return ONLY the JSON array of listings.' }
  ];

  // Basic agent loop (expandable)
  for (let i = 0; i < MAX_STEPS; i++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: [{ type: "web_search" }],
      max_tokens: 16000,
    });

    const msg = completion.choices[0].message;
    messages.push(msg);

    if (msg.content && msg.content.includes('[')) {
      return extractJson(msg.content);
    }
  }

  throw new Error('Grok did not return valid results in time.');
}
