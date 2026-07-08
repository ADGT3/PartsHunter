export async function runSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter((f) => f.vote > 0).slice(0, 25);
  const bad = (feedback || []).filter((f) => f.vote < 0).slice(0, 25);

  const system = `You are Parts Sniper — expert at finding real parts to repair damaged cars.

Deep Research Strategy:
1. From the goal, identify likely OEM part numbers.
2. Find compatible models that share those parts.
3. Expand queries with part numbers + model interchange.
4. Use web_search + fetch_page aggressively to open and read actual listing pages.
5. Follow the RULES exactly. Never fabricate listings.

Output ONLY a JSON array of current real listings.`;

  const parts = [];
  parts.push('PROJECT GOAL: ' + project.goal);
  parts.push('CATEGORIES: ' + (cfg.categories || []).join(' | '));
  parts.push('SEARCH QUERIES (expand with part numbers & compatible models):\n- ' + (cfg.queries || []).join('\n- '));
  parts.push('RULES (authoritative — follow exactly):\n- ' + (cfg.rules || []).join('\n- '));
  if (good.length) parts.push('GOOD LISTINGS (re-include similar):\n- ' + good.map((f) => f.listing_url).join('\n- '));
  if (bad.length) parts.push('AVOID similar to:\n- ' + bad.map((f) => f.listing_url).join('\n- '));
  parts.push('Do deep research now and return ONLY the JSON array of current listings.');

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
