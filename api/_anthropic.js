/* Claude API helpers: expand a project goal into a search config, and run a
 * web-search-backed parts search. The Anthropic key lives ONLY in server env. */

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// The search uses a fast model by default so it finishes inside the serverless
// time limit, even if ANTHROPIC_MODEL is set to a slower model (e.g. Opus).
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 52000);
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: Number(process.env.SEARCH_MAX_USES || 4)
};

async function call(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
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
    if (e && e.name === 'AbortError') {
      throw new Error('The search ran past the ' + Math.round(RUN_TIMEOUT_MS / 1000) + 's limit and was stopped. Use a faster model (SEARCH_MODEL=claude-sonnet-5), lower SEARCH_MAX_USES, or use a plan with longer function timeouts.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Anthropic API ' + r.status + ': ' + t.slice(0, 600));
  }
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = fence ? fence[1] : text;
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('Model did not return JSON. Raw start: ' + text.slice(0, 200));
  s = s.slice(start);
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  s = s.slice(0, end + 1);
  return JSON.parse(s);
}

export async function expandGoal(goal) {
  const system = 'You configure a parts-hunting search. Given a plain-language goal, output a JSON object with exactly these keys: "categories" (array of 2-5 short section names to group listings), "queries" (array of 6-10 web-search query strings using varied phrasing — include part-name, seller-catalog "site:" style, and generic-title angles), and "rules" (array of short guardrail strings, e.g. genuine/OEM preference, exclude inserts/cushions when the goal is a seat, specific-product-pages-only, skip sold/ended, relevance). Respond with ONLY the JSON object, no prose.';
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

  const system = [
    'You search the web for parts currently for sale and return them as structured data.',
    'Follow the RULES strictly. Only include listings that are (a) a specific product/item page (NOT a generic collection/category/search page), (b) still available (skip sold/ended/out-of-stock), and (c) clearly relevant to the goal.',
    'Never fabricate listings, prices, or images. Include each listing\'s product image URL from the page og:image when available (clean &amp; to &).',
    'Respond with ONLY a JSON array. Each element: {"section","title","description","price","currency","condition","seller","url","image","badges"} where "section" is one of the project categories and "badges" is an array of short tags (e.g. "OEM","New","Used","Aftermarket").'
  ].join(' ');

  const parts = [];
  parts.push('PROJECT GOAL: ' + project.goal);
  parts.push('CATEGORIES: ' + (cfg.categories || []).join(' | '));
  parts.push('SEARCH QUERIES (run these, varying phrasing):\n- ' + (cfg.queries || []).join('\n- '));
  parts.push('RULES:\n- ' + (cfg.rules || []).join('\n- '));
  if (good.length) parts.push('USER MARKED GOOD (prefer similar parts/sellers):\n- ' + good.map((f) => f.listing_title + ' — ' + f.seller).join('\n- '));
  if (bad.length) parts.push('USER MARKED POOR (avoid these and anything similar):\n- ' + bad.map((f) => f.listing_title + ' — ' + f.seller + (f.reason ? ' (' + f.reason + ')' : '')).join('\n- '));
  parts.push('Return the JSON array of current listings now.');

  const text = await call({
    model: SEARCH_MODEL,
    max_tokens: 3500,
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    tools: [WEB_SEARCH_TOOL]
  });
  const arr = extractJson(text);
  if (!Array.isArray(arr)) throw new Error('Search did not return a JSON array.');
  return arr;
}
