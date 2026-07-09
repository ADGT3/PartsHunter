/* Claude API helpers with automatic browser fallback */
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
  description: 'Fast normal fetch. Use this first for most sites. Returns readable text + og:image. Good for normal websites.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

const FETCH_BROWSER_TOOL = {
  name: 'fetch_page_browser',
  description: 'Use this ONLY for JavaScript-heavy sites (Copart, IAAI, modern dealer/auction sites) or when normal fetch_page returns very little content. Renders the page with a real browser.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url']
  }
};

// Normal fetch
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
    return text.slice(0, PAGE_CHARS) + ogLine;
  } catch (e) {
    return 'FETCH ERROR: ' + String(e.message || e);
  }
}

// Browserless fetch (headless browser)
async function fetchPageWithBrowser(url) {
  const browserlessKey = process.env.BROWSERLESS_API_KEY;
  if (!browserlessKey) return 'BROWSERLESS_API_KEY not set';

  try {
    const response = await fetch(`https://chrome.browserless.io/content?token=${browserlessKey}`, {
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
    const og = html.match(/<meta[^>]+property=["']og:image[^"']*["'][^>]*content=["']([^"']+)["']/i);
    const ogLine = og ? '\nOG_IMAGE: ' + og[1].replace(/&amp;/g, '&') : '';
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

// ... (keep rawCall, textOf, call, agentLoop, extractJson, expandGoal exactly as before)

export async function runSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  const system = `You are Parts Sniper — expert at finding real parts to repair damaged cars.

Tool Usage Rules:
- Always try normal "fetch_page" first.
- Only use "fetch_page_browser" when the site is JavaScript-heavy (Copart, IAAI, modern auction/dealer sites) or when normal fetch returns very little useful content.
- Be efficient with browser calls as they are slower and more expensive.

Follow the goal, categories, queries and rules. Output ONLY a JSON array of listings.`;

  const parts = [
    'PROJECT GOAL: ' + project.goal,
    'CATEGORIES: ' + (cfg.categories || []).join(' | '),
    'SEARCH QUERIES:\n- ' + (cfg.queries || []).join('\n- '),
    'RULES:\n- ' + (cfg.rules || []).join('\n- '),
    good.length ? 'GOOD EXAMPLES: ' + good.map(f => f.listing_url).join(', ') : '',
    bad.length ? 'AVOID: ' + bad.map(f => f.listing_url).join(', ') : '',
    'Do deep research. Prefer normal fetch_page. Use fetch_page_browser only when necessary.'
  ].filter(Boolean).join('\n\n');

  const data = await agentLoop({
    model: SEARCH_MODEL,
    max_tokens: 12000,
    system,
    messages: [{ role: 'user', content: parts }],
    tools: [WEB_SEARCH_TOOL, FETCH_TOOL, FETCH_BROWSER_TOOL]
  });

  // Handle tool results (you'll need to update the agentLoop slightly to support fetch_page_browser)
  // For now, the logic stays similar — just add handling for the new tool name.

  const text = textOf(data);
  if (!text) throw new Error('Search returned no text');
  const arr = extractJson(text);
  if (!Array.isArray(arr)) throw new Error('Search did not return a JSON array.');
  return arr;
}
