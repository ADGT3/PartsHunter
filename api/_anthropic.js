/* Claude API helpers */
const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 280000);
const MAX_STEPS = Number(process.env.SEARCH_MAX_STEPS || 14);
const PAGE_CHARS = Number(process.env.FETCH_PAGE_CHARS || 12000);

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: Number(process.env.SEARCH_MAX_USES || 10)
};
const FETCH_TOOL = {
  name: 'fetch_page',
  description: 'Fetch the readable text of a web page so you can read what is actually on it. Search engines rarely index individual product/auction-lot pages, so use this to OPEN the category/listing pages that web_search returns and read the individual items on them, and to open a specific product or lot page to confirm its details, price, availability and image. Returns the page text plus its OG_IMAGE url when present.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full URL to fetch' } },
    required: ['url']
  }
};

async function rawCall(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('The search ran past the ' + Math.round(RUN_TIMEOUT_MS / 1000) + 's limit and was stopped. Lower SEARCH_MAX_STEPS/SEARCH_MAX_USES.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Anthropic API ' + r.status + ': ' + t.slice(0, 600));
  }
  return await r.json();
}

function textOf(data) {
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function call(body) {
  return textOf(await rawCall(body));
}

async function fetchPageText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'FETCH ERROR: invalid url';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
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

async function agentLoop(body) {
  let messages = body.messages.slice();
  let data;
  for (let i = 0; i < MAX_STEPS; i++) {
    data = await rawCall({ ...body, messages });
    const stop = data.stop_reason;
    if (stop === 'pause_turn') {
      messages = messages.concat([{ role: 'assistant', content: data.content }]);
      continue;
    }
    if (stop === 'tool_use') {
      messages = messages.concat([{ role: 'assistant', content: data.content }]);
      const results = [];
      for (const b of data.content || []) {
        if (b.type === 'tool_use') {
          const out = b.name === 'fetch_page' ? await fetchPageText(b.input && b.input.url) : ('Unsupported tool: ' + b.name);
          results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
        }
      }
      messages = messages.concat([{ role: 'user', content: results.length ? results : 'Now output the final JSON array.' }]);
      continue;
    }
    if (textOf(data)) return data;
    messages = messages.concat([{ role: 'user', content: 'Output ONLY the JSON array of results now.' }]);
  }
  const finalMessages = messages.concat([{
    role: 'user',
    content: 'Stop researching now. Using everything you have gathered, output ONLY the final JSON array of listings — do not call any tools, no prose.'
  }]);
  return await rawCall({ ...body, messages: finalMessages, tool_choice: { type: 'none' } });
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
    try { return JSON.parse(c); } catch (e) { /* try next */ }
  }
  throw new Error('Could not parse model JSON (likely truncated). Start: ' + s.slice(0, 200));
}

export async function expandGoal(goal) {
  const system = 'You configure a search. Given a plain-language goal, output a JSON object with exactly these keys: "categories" (array of 2-5 short section names to group results), "queries" (array of 6-10 web-search query strings using varied phrasing that would find matches for this goal), and "rules" (array of short guardrail strings capturing only the constraints the goal actually implies — do not invent unrelated constraints). Respond with ONLY the JSON object, no prose.';
  const text = await call({
    model: MODEL,
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: 'Goal: ' + goal }]
  });
  return extractJson(text);
}

export async function runSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  const system = `You are Parts Sniper — expert at finding real parts currently for sale to repair damaged cars.

Instructions:
- Search the web and browse actual listing pages.
- Extract real current listings with accurate price, condition, seller, and image.
- Never fabricate listings.
- Follow the RULES exactly.
- Output ONLY a JSON array of listings.`;

  const parts = [];
  parts.push('PROJECT GOAL: ' + project.goal);
  parts.push('CATEGORIES: ' + (cfg.categories || []).join(' | '));
  parts.push('SEARCH QUERIES (use these and expand with relevant part numbers and sellers):\n- ' + (cfg.queries || []).join('\n- '));
  parts.push('RULES (authoritative — follow exactly):\n- ' + (cfg.rules || []).join('\n- '));
  if (good.length) parts.push('GOOD LISTINGS (re-include similar):\n- ' + good.map((f) => f.listing_url).join('\n- '));
  if (bad.length) parts.push('AVOID similar to:\n- ' + bad.map((f) => f.listing_url).join('\n- '));
  parts.push('Do the research now and return ONLY the JSON array of current listings.');

  const data = await agentLoop({
    model: SEARCH_MODEL,
    max_tokens: 12000,
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    tools: [WEB_SEARCH_TOOL, FETCH_TOOL]
  });
  const text = textOf(data);
  if (!text) {
    const types = ((data && data.content) || []).map((b) => b.type).join(',') || 'none';
    throw new Error('Search returned no text (stop_reason=' + ((data && data.stop_reason) || '?') + ', blocks=' + types + ').');
  }
  const arr = extractJson(text);
  if (!Array.isArray(arr)) throw new Error('Search did not return a JSON array.');
  return arr;
}
