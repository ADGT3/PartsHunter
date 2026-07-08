/* Claude API helpers - updated with deep search prompt */
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
  description: 'Fetch the readable text of a web page so you can read what is actually on it. ...',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full URL to fetch' } },
    required: ['url']
  }
};

// ... (keep all the helper functions: rawCall, textOf, call, fetchPageText, agentLoop, extractJson, expandGoal) exactly as they are

export async function runSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  const system = [
    'You are a thorough research agent that finds items currently for sale on the web.',
    'Deep search: Identify OEM part numbers from the goal, find compatible models, expand queries with part numbers and interchange.',
    'You have two tools: web_search and fetch_page. Use them aggressively to open listing pages.',
    'Follow the RULES exactly. Never fabricate.',
    'Output ONLY a JSON array of listings.'
  ].join(' ');

  const parts = [];
  parts.push('PROJECT GOAL: ' + project.goal);
  parts.push('CATEGORIES: ' + (cfg.categories || []).join(' | '));
  parts.push('SEARCH QUERIES (expand further with part numbers and compatible models):\n- ' + (cfg.queries || []).join('\n- '));
  parts.push('RULES (authoritative):\n- ' + (cfg.rules || []).join('\n- '));
  if (good.length) parts.push('GOOD LISTINGS: ' + good.map((f) => f.listing_url).join(', '));
  if (bad.length) parts.push('AVOID: ' + bad.map((f) => f.listing_url).join(', '));
  parts.push('Do deep research now and return ONLY the JSON array.');

  const data = await agentLoop({
    model: SEARCH_MODEL,
    max_tokens: 12000,
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    tools: [WEB_SEARCH_TOOL, FETCH_TOOL]
  });

  const text = textOf(data);
  if (!text) throw new Error('Search returned no text');
  const arr = extractJson(text);
  if (!Array.isArray(arr)) throw new Error('Search did not return a JSON array.');
  return arr;
}
