/* Claude API helpers - Automatic browser fallback + improved image extraction */
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
  description: 'Fast normal fetch. Use this first for most sites.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

const FETCH_BROWSER_TOOL = {
  name: 'fetch_page_browser',
  description: 'Use only when normal fetch returns very little content or for known JS-heavy sites.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

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
        waitFor: 2000
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

// Automatic fallback: normal first, then browser if poor
async function smartFetch(url) {
  const normal = await fetchPageText(url);
  if (isPoorContent(normal)) {
    console.log('Poor content from normal fetch, trying browser for:', url);
    return await fetchPageWithBrowser(url);
  }
  return normal;
}

const MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES || 5);

async function rawCall(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(API, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': VERSION
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('Search timed out.');
        throw e;
      }
      if (r.ok) return await r.json();

      const errText = await r.text();
      // 429 = rate limited, 529 = overloaded, 5xx = transient server errors — back off and retry.
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

async function call(body) {
  return textOf(await rawCall(body));
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
          let out;
          if (b.name === 'fetch_page' || b.name === 'fetch_page_browser') {
            // Use smartFetch which does automatic fallback
            out = await smartFetch(b.input?.url || '');
          } else {
            out = 'Unsupported tool: ' + b.name;
          }
          results.push({ type: 'tool_result', tool_use_id: b.id, content: out });
        }
      }

      messages = messages.concat([{
        role: 'user',
        content: results.length ? results : 'Now output the final JSON array of listings.'
      }]);
      continue;
    }

    if (textOf(data)) return data;
    messages = messages.concat([{ role: 'user', content: 'Output ONLY the JSON array of results now.' }]);
  }

  const finalMessages = messages.concat([{
    role: 'user',
    content: 'Stop researching now. Output ONLY the final JSON array of listings. No prose.'
  }]);
  return await rawCall({ ...body, messages: finalMessages, tool_choice: { type: 'none' } });
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = (fence ? fence[1] : text);
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('Model did not return JSON. Start: ' + text.slice(0, 200));
  s = s.slice(start).replace(/[\x00-\x1F]+/g, ' ').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (end > 0) {
      try { return JSON.parse(s.slice(0, end + 1)); } catch {}
    }
    throw new Error('Could not parse model JSON');
  }
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
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  // If config is empty, expand on the fly
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
- Prefer normal fetch_page first.
- The system will automatically upgrade to browser when the page is JavaScript-heavy.
- Focus hard on salvage/auction sources (Copart, IAAI, etc.) when relevant to the goal.
- Extract accurate price, condition, seller, and image for every listing.
- Every listing's "section" MUST be EXACTLY one of the CATEGORIES provided below (copy the category text verbatim). Do not invent new section names; if a listing does not neatly fit, choose the closest category.
- Output ONLY a JSON array of listings. Never fabricate.`;

  const parts = [
    'PROJECT GOAL: ' + project.goal,
    'CATEGORIES: ' + categories.join(' | '),
    'SEARCH QUERIES:\n- ' + queries.join('\n- '),
    'RULES:\n- ' + rules.join('\n- '),
    good.length ? 'GOOD EXAMPLES (find similar):\n- ' + good.map(f => f.listing_url).join('\n- ') : '',
    bad.length ? 'AVOID similar to:\n- ' + bad.map(f => f.listing_url).join('\n- ') : '',
    'Do deep research now. Prioritise real current listings and salvage vehicles when relevant. Return ONLY the JSON array.'
  ].filter(Boolean).join('\n\n');

  const data = await agentLoop({
    model: SEARCH_MODEL,
    max_tokens: 12000,
    system,
    messages: [{ role: 'user', content: parts }],
    tools: [WEB_SEARCH_TOOL, FETCH_TOOL, FETCH_BROWSER_TOOL]
  });

  const text = textOf(data);
  if (!text) throw new Error('Search returned no text');
  const arr = extractJson(text);
  if (!Array.isArray(arr)) throw new Error('Search did not return a JSON array.');
  return arr;
}
