/* Claude API helpers - Automatic browser fallback + improved image extraction */
const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 280000);
// Keep the agent short — each step is a billed Messages call.
const MAX_STEPS = Number(process.env.SEARCH_MAX_STEPS || 8);
const MAX_BROWSER_FETCHES = Number(process.env.MAX_BROWSER_FETCHES || 5);
let browserBudget = MAX_BROWSER_FETCHES;
const PAGE_CHARS = Number(process.env.FETCH_PAGE_CHARS || 12000);

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: Number(process.env.SEARCH_MAX_USES || 8)
};

const FETCH_TOOL = {
  name: 'fetch_page',
  description: 'Fast normal fetch. Use this first for most sites. Only fetch a specific product or lot page, not a search-results index.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

const FETCH_BROWSER_TOOL = {
  name: 'fetch_page_browser',
  description: 'Use only when normal fetch returns very little content or for known JS-heavy sites. Budget is small — prefer fetch_page.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

const LISTING_SCHEMA = `Each listing MUST be an object with these keys:
- "section": string (exactly one CATEGORY name, copied verbatim)
- "title": string
- "description": string
- "price": string (as shown, or "")
- "currency": string (ISO code if known, else "")
- "condition": string
- "seller": string
- "url": string (https product/lot DETAIL page — not a search/category page)
- "image": string (direct image URL if seen, else "")
- "badges": array of short strings
Aliases (link/href, image_url) are not allowed — use "url" and "image".`;

function isPoorContent(text) {
  if (!text || text.startsWith('FETCH ERROR') || text.startsWith('BROWSER')) return true;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 800) return true;
  if (/loading|please enable javascript|enable js|javascript is required/i.test(clean)) return true;
  return false;
}

async function extractImage(html) {
  let image = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
              html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

  if (!image) {
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const json = JSON.parse(jsonLdMatch[1]);
        if (json.image) image = Array.isArray(json.image) ? json.image[0] : json.image;
        if (!image && json['@graph']) {
          const product = json['@graph'].find(item => item['@type']?.includes('Product'));
          if (product?.image) image = Array.isArray(product.image) ? product.image[0] : product.image;
        }
      } catch (e) {}
    }
  }

  if (!image) {
    const imgMatches = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi) || [];
    for (const img of imgMatches) {
      const src = img.match(/src=["']([^"']+)["']/)?.[1];
      if (src && !/logo|icon|sprite|placeholder|avatar|spinner/i.test(src) && src.length > 40) {
        image = src;
        break;
      }
    }
  }

  return image ? image.replace(/&amp;/g, '&') : '';
}

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
    const image = await extractImage(html);
    const ogLine = image ? '\nOG_IMAGE: ' + image : '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, PAGE_CHARS) + ogLine;
  } catch (e) {
    return 'FETCH ERROR: ' + String(e.message || e);
  }
}

async function fetchPageWithBrowser(url) {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) return 'BROWSERLESS_API_KEY not set';

  try {
    const response = await fetch(`https://chrome.browserless.io/content?token=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 },
        waitForTimeout: 5000,
        bestAttempt: true
      })
    });

    if (!response.ok) return 'BROWSER FETCH ERROR: ' + response.status;

    const html = await response.text();
    const image = await extractImage(html);
    const ogLine = image ? '\nOG_IMAGE: ' + image : '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, PAGE_CHARS) + ogLine;
  } catch (e) {
    return 'BROWSER FETCH ERROR: ' + e.message;
  }
}

async function smartFetch(url) {
  const normal = await fetchPageText(url);
  if (isPoorContent(normal)) {
    if (browserBudget <= 0) return normal;
    browserBudget--;
    console.log('Poor content from normal fetch, trying browser for:', url);
    return await fetchPageWithBrowser(url);
  }
  return normal;
}

const MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES || 5);
let thinkingSupported = true;

function withThinkingOff(body) {
  if (!thinkingSupported) return body;
  return { ...body, thinking: { type: 'disabled' } };
}

async function rawCall(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      let r;
      const payload = withThinkingOff(body);
      try {
        r = await fetch(API, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': VERSION
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('Search timed out.');
        throw e;
      }
      if (r.ok) return await r.json();

      const errText = await r.text();
      if (r.status === 400 && thinkingSupported && /thinking/i.test(errText)) {
        thinkingSupported = false;
        continue;
      }
      const retryable = r.status === 429 || r.status === 529 || (r.status >= 500 && r.status < 600);
      if (retryable && attempt < MAX_RETRIES) {
        const wait = Math.min(1500 * Math.pow(2, attempt), 20000);
        console.warn(`Anthropic ${r.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying in ${wait}ms`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      throw new Error('Anthropic API ' + r.status + ': ' + errText.slice(0, 600));
    }
  } finally {
    clearTimeout(timer);
  }
}

function textOf(data) {
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

function blockTypes(data) {
  return ((data && data.content) || []).map((b) => b.type).join(',') || 'none';
}

async function call(body) {
  return textOf(await rawCall(body));
}

const SERVER_TOOLS = new Set(['web_search', 'web_search_20250305']);

function collectSearchHits(content, into) {
  if (!content) return into;
  const blocks = Array.isArray(content) ? content : [content];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) {
        const url = r && (r.url || r.link);
        if (!url || !/^https?:\/\//i.test(url)) continue;
        into.push({
          title: String(r.title || r.page_title || '').trim(),
          url: String(url).trim(),
          description: String(r.snippet || r.description || '').trim()
        });
      }
    }
    if (b.type === 'web_search_result' && b.url) {
      into.push({ title: String(b.title || '').trim(), url: String(b.url).trim(), description: String(b.snippet || '').trim() });
    }
    if (Array.isArray(b.citations)) {
      for (const c of b.citations) {
        const url = c && (c.url || c.source);
        if (url && /^https?:\/\//i.test(url)) {
          into.push({ title: String(c.title || '').trim(), url: String(url).trim(), description: '' });
        }
      }
    }
    if (b.type === 'text' && typeof b.text === 'string') {
      const urls = b.text.match(/https?:\/\/[^\s)"'<>]+/g) || [];
      urls.forEach((u) => into.push({ title: '', url: u.replace(/[.,;]+$/, ''), description: '' }));
    }
    if (Array.isArray(b.content)) collectSearchHits(b.content, into);
  }
  return into;
}

function hitsToListings(hits, categories) {
  const seen = new Set();
  const cat = (categories && categories[0]) || 'Results';
  const out = [];
  for (const h of hits) {
    const url = (h.url || '').split('#')[0];
    if (!url) continue;
    const key = url.toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
    out.push({
      section: cat,
      title: h.title || host || url,
      description: h.description || '',
      price: '',
      currency: '',
      condition: '',
      seller: host,
      url,
      image: '',
      badges: ['web']
    });
  }
  return out;
}

async function agentLoop(body) {
  let messages = body.messages.slice();
  let data;
  const hits = [];
  let stopTools = false;

  for (let i = 0; i < MAX_STEPS; i++) {
    data = await rawCall({
      ...body,
      messages,
      ...(stopTools ? { tool_choice: { type: 'none' } } : {})
    });
    collectSearchHits(data && data.content, hits);
    const stop = data.stop_reason;

    if (stop === 'refusal') {
      throw new Error('Claude refused the search (stop_reason=refusal).');
    }

    if (stop === 'pause_turn') {
      messages = messages.concat([{ role: 'assistant', content: data.content }]);
      continue;
    }

    if (stop === 'tool_use') {
      messages = messages.concat([{ role: 'assistant', content: data.content }]);
      const results = [];
      let onlyServer = true;

      for (const b of data.content || []) {
        if (b.type !== 'tool_use') continue;
        if (SERVER_TOOLS.has(b.name)) continue;
        onlyServer = false;
        let out;
        if (b.name === 'fetch_page' || b.name === 'fetch_page_browser') {
          out = await smartFetch(b.input?.url || '');
        } else {
          out = 'Unsupported tool: ' + b.name + '. Output the JSON array of listings now.';
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
      }

      // Server-side web_search results should already be in this response.
      // Do not spin another tool-use turn — ask for JSON from hits we have.
      if (onlyServer) {
        stopTools = true;
        messages = messages.concat([{
          role: 'user',
          content: 'Using the search results already returned, output ONLY the JSON array of listings now. Include every for-sale result with its real URL. Empty array only if nothing for sale was found.\n' + LISTING_SCHEMA
        }]);
        continue;
      }
      messages = messages.concat([{
        role: 'user',
        content: results.length ? results : 'Now output the final JSON array of listings.'
      }]);
      continue;
    }

    if (textOf(data)) return { data, hits };
    messages = messages.concat([{ role: 'user', content: 'Output ONLY the JSON array of results now. Include real search-result URLs. ' + LISTING_SCHEMA }]);
  }

  const finalMessages = messages.concat([{
    role: 'user',
    content: 'Stop researching now. Output ONLY the final JSON array of listings. No prose.\n' + LISTING_SCHEMA
  }]);
  const last = await rawCall({ ...body, messages: finalMessages, tool_choice: { type: 'none' } });
  collectSearchHits(last && last.content, last && last.content ? hits : hits);
  return { data: last, hits };
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = (fence ? fence[1] : text);
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('Model did not return JSON. Start: ' + text.slice(0, 200));
  s = s.slice(start).replace(/[\x00-\x1F]+/g, ' ').trim();

  const candidates = [s];
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (end > 0) candidates.push(s.slice(0, end + 1));
  if (s[0] === '[') {
    const lastObj = s.lastIndexOf('}');
    if (lastObj > 0) candidates.push(s.slice(0, lastObj + 1).replace(/,\s*$/, '') + ']');
  }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (e) { /* try next */ }
  }
  throw new Error('Could not parse model JSON. Start: ' + s.slice(0, 200));
}

export function normalizeListing(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url || raw.link || raw.href || raw.listing_url || '').trim();
  const image = String(raw.image || raw.image_url || raw.img || raw.thumbnail || '').trim();
  const title = String(raw.title || raw.name || '').trim();
  if (!title && !url) return null;
  return {
    section: raw.section || raw.category || 'Results',
    title,
    description: String(raw.description || raw.desc || '').trim(),
    price: raw.price == null ? '' : String(raw.price),
    currency: String(raw.currency || '').trim(),
    condition: String(raw.condition || raw.damage || '').trim(),
    seller: String(raw.seller || raw.source || raw.site || '').trim(),
    url,
    image,
    badges: Array.isArray(raw.badges) ? raw.badges : []
  };
}

export async function expandGoal(goal) {
  const system = `You configure a parts search for repairing a damaged car.
Given a plain-language goal, output a JSON object with exactly these keys:
- "categories": array of 3-6 short section names to group results
- "queries": array of 8-12 strong web search queries (include OEM part numbers if possible, salvage, Copart, IAAI, etc.)
- "rules": array of short guardrail strings (only constraints implied by the goal)

Respond with ONLY the JSON object, no prose.`;
  const text = await call({
    model: MODEL,
    max_tokens: 1500,
    system,
    messages: [{ role: 'user', content: 'Goal: ' + goal }]
  });
  return extractJson(text);
}

export async function runSearch(project, feedback) {
  browserBudget = MAX_BROWSER_FETCHES;
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  let categories = cfg.categories || [];
  let queries = cfg.queries || [];
  let rules = cfg.rules || [];

  if (queries.length === 0) {
    try {
      const expanded = await expandGoal(project.goal);
      categories = expanded.categories || categories;
      queries = expanded.queries || queries;
      rules = expanded.rules || rules;
    } catch (e) {
      console.error('On-the-fly expand failed:', e.message);
    }
  }

  const system = `You are Parts Sniper — expert at finding real OEM and salvage parts for damaged cars.

Tool rules:
- Prefer web_search, then fetch_page on a SMALL number of the best DETAIL pages (not search indexes).
- The system will automatically upgrade to browser when the page is JavaScript-heavy.
- Use the search budget: run several DISTINCT queries from SEARCH QUERIES (part number, OEM, used, salvage). Do not stop after one query.
- Fetch at most 3 detail pages — spend the budget on more searches, not more fetches.
- Focus on salvage/auction and parts catalogues (Copart, IAAI, Pickles, eBay, OEM dealers) when relevant.
- Extract price, condition, seller, and image when shown.
- Never invent a URL. You MAY list a result using the exact URL + title from web_search even if you did not fetch the page.
- Return EVERY distinct for-sale hit from the search results (aim 12–25). Empty array only if search returned nothing relevant.
- After tools, output ONLY a JSON array.

${LISTING_SCHEMA}`;

  const parts = [
    'PROJECT GOAL: ' + project.goal,
    'CATEGORIES: ' + categories.join(' | '),
    'SEARCH QUERIES:\n- ' + queries.join('\n- '),
    'RULES:\n- ' + rules.join('\n- '),
    good.length ? 'GOOD EXAMPLES (find similar):\n- ' + good.map(f => f.listing_url).join('\n- ') : '',
    bad.length ? 'AVOID similar to:\n- ' + bad.map(f => f.listing_url).join('\n- ') : '',
    'Research now. Prefer real current detail-page listings. Return ONLY the JSON array.'
  ].filter(Boolean).join('\n\n');

  const loop = await agentLoop({
    model: SEARCH_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: parts }],
    tools: [WEB_SEARCH_TOOL, FETCH_TOOL, FETCH_BROWSER_TOOL]
  });
  const data = loop.data;
  const hits = loop.hits || [];

  if (data && data.stop_reason === 'refusal') {
    throw new Error('Claude refused the search.');
  }
  let parsed = [];
  const text = textOf(data);
  if (text) {
    try {
      const arr = extractJson(text);
      if (Array.isArray(arr)) parsed = arr.map(normalizeListing).filter(Boolean);
    } catch (e) {
      console.warn('Claude JSON parse failed, will use harvested search hits:', e.message);
    }
  } else {
    console.warn('Search returned no text (stop_reason=' + ((data && data.stop_reason) || '?') + ', blocks=' + blockTypes(data) + ', hits=' + hits.length + ')');
  }

  const harvested = hitsToListings(hits, categories);
  const byUrl = new Map();
  for (const l of [...parsed, ...harvested]) {
    const key = (l.url || l.title || '').toLowerCase().replace(/\/$/, '');
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, l);
    else {
      const ex = byUrl.get(key);
      if (!ex.image && l.image) ex.image = l.image;
      if (!ex.price && l.price) ex.price = l.price;
      if (!ex.description && l.description) ex.description = l.description;
    }
  }
  const merged = Array.from(byUrl.values());
  console.log('Claude parsed:', parsed.length, 'harvested:', harvested.length, 'merged:', merged.length);
  if (merged.length) return merged;

  if (!text) {
    throw new Error('Search returned no text and no search hits (stop_reason=' + ((data && data.stop_reason) || '?') + ', blocks=' + blockTypes(data) + ')');
  }
  return [];
}
