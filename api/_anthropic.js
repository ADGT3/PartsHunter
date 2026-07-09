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
  description: 'Fast normal fetch. Use this first.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

const FETCH_BROWSER_TOOL = {
  name: 'fetch_page_browser',
  description: 'Use for JavaScript-heavy sites or when normal fetch returns poor results.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

async function fetchPageText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'FETCH ERROR: invalid url';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return 'FETCH ERROR ' + r.status + ' for ' + url;

    const html = await r.text();

    let image = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

    if (!image) {
      const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLdMatch) {
        try {
          const json = JSON.parse(jsonLdMatch[1]);
          if (json.image) image = Array.isArray(json.image) ? json.image[0] : json.image;
        } catch (e) {}
      }
    }

    if (!image) {
      const imgMatches = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi) || [];
      for (const img of imgMatches) {
        const src = img.match(/src=["']([^"']+)["']/)?.[1];
        if (src && !src.includes('logo') && !src.includes('icon') && src.length > 30) {
          image = src;
          break;
        }
      }
    }

    const ogLine = image ? '\nOG_IMAGE: ' + image.replace(/&amp;/g, '&') : '';
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
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
        waitFor: 1500
      })
    });

    if (!response.ok) return 'BROWSER FETCH ERROR: ' + response.status;

    const html = await response.text();

    let image = html.match(/<meta[^>]+property=["']og:image[^"']*["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

    if (!image) {
      const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLdMatch) {
        try {
          const json = JSON.parse(jsonLdMatch[1]);
          if (json.image) image = Array.isArray(json.image) ? json.image[0] : json.image;
        } catch (e) {}
      }
    }

    if (!image) {
      const imgMatches = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi) || [];
      for (const img of imgMatches) {
        const src = img.match(/src=["']([^"']+)["']/)?.[1];
        if (src && !src.includes('logo') && !src.includes('icon') && src.length > 30) {
          image = src;
          break;
        }
      }
    }

    const ogLine = image ? '\nOG_IMAGE: ' + image.replace(/&amp;/g, '&') : '';
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                     .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();

    return text.slice(0, PAGE_CHARS) + ogLine;
  } catch (e) {
    return 'BROWSER FETCH ERROR: ' + e.message;
  }
}

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
    if (e && e.name === 'AbortError') throw new Error('Search timed out.');
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
          if (b.name === 'fetch_page') {
            out = await fetchPageText(b.input.url);
          } else if (b.name === 'fetch_page_browser') {
            out = await fetchPageWithBrowser(b.input.url);
          } else {
            out = 'Unsupported tool';
          }
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
    content: 'Stop researching now. Output ONLY the final JSON array of listings.'
  }]);
  return await rawCall({ ...body, messages: finalMessages, tool_choice: { type: 'none' } });
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = (fence ? fence[1] : text);
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('Model did not return JSON');
  s = s.slice(start).replace(/[\x00-\x1F]+/g, ' ').trim();
  try { return JSON.parse(s); } catch (e) {}
  throw new Error('Could not parse JSON');
}

export async function expandGoal(goal) {
  const system = 'You configure a search. Given a plain-language goal, output a JSON object with exactly these keys: "categories", "queries", and "rules". Respond with ONLY the JSON object.';
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

  const system = `You are Parts Sniper — expert at finding real parts to repair damaged cars.

Tool Usage:
- Prefer normal "fetch_page" first.
- Only use "fetch_page_browser" for JavaScript-heavy sites or when normal fetch returns very little content.

Output ONLY a JSON array of listings.`;

  const parts = [
    'PROJECT GOAL: ' + project.goal,
    'CATEGORIES: ' + (cfg.categories || []).join(' | '),
    'SEARCH QUERIES:\n- ' + (cfg.queries || []).join('\n- '),
    'RULES:\n- ' + (cfg.rules || []).join('\n- '),
    good.length ? 'GOOD EXAMPLES: ' + good.map(f => f.listing_url).join(', ') : '',
    bad.length ? 'AVOID: ' + bad.map(f => f.listing_url).join(', ') : '',
    'Do deep research. Prefer normal fetch_page. Use browser only when necessary.'
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
