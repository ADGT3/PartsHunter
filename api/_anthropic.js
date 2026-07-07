/* Claude API helpers: expand a project goal into a search config, and run a
 * web-search-backed parts search. The Anthropic key lives ONLY in server env. */

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// The search uses a fast model by default so it finishes inside the serverless
// time limit, even if ANTHROPIC_MODEL is set to a slower model (e.g. Opus).
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 280000);
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: Number(process.env.SEARCH_MAX_USES || 6)
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
    if (e && e.name === 'AbortError') {
      throw new Error('The search ran past the ' + Math.round(RUN_TIMEOUT_MS / 1000) + 's limit and was stopped. Use a faster model or lower SEARCH_MAX_USES.');
    }
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

// Simple (no tools) call — used for goal expansion.
async function call(body) {
  return textOf(await rawCall(body));
}

// Agentic call that drives the web_search tool loop and handles `pause_turn`
// continuations (the API pauses long-running search turns and must be resumed).
async function callWithSearch(body) {
  let messages = body.messages.slice();
  let data;
  for (let i = 0; i < 6; i++) {
    data = await rawCall({ ...body, messages });
    if (data.stop_reason === 'pause_turn') {
      messages = messages.concat([{ role: 'assistant', content: data.content }]);
      continue;
    }
    break;
  }
  const text = textOf(data);
  if (!text) {
    const types = ((data && data.content) || []).map((b) => b.type).join(',') || 'none';
    throw new Error('Search returned no text (stop_reason=' + ((data && data.stop_reason) || '?') + ', blocks=' + types + '). Try lowering SEARCH_MAX_USES.');
  }
  return text;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = fence ? fence[1] : text;
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('Model did not return JSON. Raw start: ' + text.slice(0, 300));
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
    'Follow the RULES strictly. Only include a listing when it is (a) a SPECIFIC product/item page — never a collection, category, or search-results page — (b) still available (skip sold/ended/out-of-stock), and (c) clearly relevant to the goal.',
    'When the goal or rules call for OEM/genuine parts, that is MANDATORY: exclude aftermarket, replica, "OE-style", tuner, body-kit, and conversion-kit products entirely — do not include them even with a warning badge. Quality over quantity: it is better to return 2-3 genuinely matching OEM listings than to pad the list with weak, off-target, or aftermarket items.',
    'If you only have a category/collection/search URL for an item, DROP that item — every listing MUST have a direct product-page URL in "url".',
    'Never fabricate listings, prices, or images. If a page exposes a product image (og:image), put it in "image"; otherwise use an empty string.',
    'Output MUST be ONLY a JSON array (start your reply with "[" and end with "]"), no prose, no markdown fences. Each element: {"section","title","description","price","currency","condition","seller","url","image","badges"} where "section" is one of the project categories and "badges" is an array of short tags (e.g. "OEM","New","Used","Aftermarket").'
  ].join(' ');

  const parts = [];
  parts.push('PROJECT GOAL: ' + project.goal);
  parts.push('CATEGORIES: ' + (cfg.categories || []).join(' | '));
  parts.push('SEARCH QUERIES (run these, varying phrasing):\n- ' + (cfg.queries || []).join('\n- '));
  parts.push('RULES:\n- ' + (cfg.rules || []).join('\n- '));
  if (good.length) parts.push('USER MARKED GOOD (prefer similar parts/sellers):\n- ' + good.map((f) => f.listing_title + ' — ' + f.seller).join('\n- '));
  if (bad.length) parts.push('USER MARKED POOR (avoid these and anything similar):\n- ' + bad.map((f) => f.listing_title + ' — ' + f.seller + (f.reason ? ' (' + f.reason + ')' : '')).join('\n- '));
  parts.push('Return ONLY the JSON array of current listings now.');

  const text = await callWithSearch({
    model: SEARCH_MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    tools: [WEB_SEARCH_TOOL]
  });
  const arr = extractJson(text);
  if (!Array.isArray(arr)) throw new Error('Search did not return a JSON array.');
  return arr;
}
