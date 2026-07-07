/* Claude API helpers: expand a project goal into a search config, and run a
 * web-search-backed search. The Anthropic key lives ONLY in server env.
 *
 * IMPORTANT: this module contains NO domain rules (no OEM/aftermarket/salvage
 * opinions). All search behaviour comes from the project's own goal, categories,
 * queries, rules, and the user's feedback. The system prompt below is purely
 * mechanical (how to search thoroughly and what output shape to return). */

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 280000);
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: Number(process.env.SEARCH_MAX_USES || 8)
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

async function call(body) {
  return textOf(await rawCall(body));
}

// Agentic call that drives the web_search tool loop and handles `pause_turn`
// continuations (the API pauses long-running search turns and must be resumed).
async function callWithSearch(body) {
  let messages = body.messages.slice();
  let data;
  for (let i = 0; i < 8; i++) {
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
  try {
    return JSON.parse(s);
  } catch (e) {
    const cleaned = s.replace(/[\x00-\x1F]+/g, ' ');
    return JSON.parse(cleaned);
  }
}

export async function expandGoal(goal) {
  const system = 'You configure a search. Given a plain-language goal, output a JSON object with exactly these keys: "categories" (array of 2-5 short section names to group results), "queries" (array of 6-10 web-search query strings using varied phrasing that would find matches for this goal), and "rules" (array of short guardrail strings capturing the constraints implied by the goal — only what the goal actually implies, do not invent unrelated constraints). Respond with ONLY the JSON object, no prose.';
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

  // Purely mechanical instructions. No domain opinions — the project's own
  // GOAL / CATEGORIES / QUERIES / RULES (below) are the single source of truth.
  const system = [
    'You are a thorough research assistant that finds items currently for sale on the web and returns them as structured data.',
    'The user provides a GOAL, CATEGORIES, SEARCH QUERIES, and RULES. The RULES are authoritative: follow them exactly. Do NOT add, assume, or impose any preferences of your own beyond what the goal and rules state.',
    'Work hard to satisfy the goal: run the given queries, generate and run additional searches as leads emerge, and open/read the actual listing pages when it helps you judge relevance, availability, or details. Prefer verifying on the page over guessing from a snippet. Return every genuinely-matching result you find; do not artificially limit the number.',
    'Never fabricate listings, prices, or images. Set "section" to one of the project categories. For "image", use the listing page og:image if present, otherwise an empty string.',
    'Output MUST be ONLY a JSON array (start with "[", end with "]"), no prose, no markdown fences, and no raw line breaks inside string values. Each element: {"section","title","description","price","currency","condition","seller","url","image","badges"} where "badges" is an array of short tags.'
  ].join(' ');

  const parts = [];
  parts.push('PROJECT GOAL: ' + project.goal);
  parts.push('CATEGORIES: ' + (cfg.categories || []).join(' | '));
  parts.push('SEARCH QUERIES (starting points — also search further as needed):\n- ' + (cfg.queries || []).join('\n- '));
  parts.push('RULES (authoritative — follow exactly, add nothing of your own):\n- ' + (cfg.rules || []).join('\n- '));
  if (good.length) parts.push('USER MARKED GOOD — re-include these exact listings if still available, and prioritise similar matches:\n- ' + good.map((f) => (f.listing_title || '(listing)') + ' — ' + (f.seller || '') + ' — ' + f.listing_url).join('\n- '));
  if (bad.length) parts.push('USER MARKED POOR — avoid these and anything similar:\n- ' + bad.map((f) => f.listing_title + ' — ' + f.seller + (f.reason ? ' (' + f.reason + ')' : '')).join('\n- '));
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
