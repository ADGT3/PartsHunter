import { sql, ensureSchema, readBody } from './_db.js';
import { requireAuth } from './_auth.js';

/* Parts-list hunt engine.
 * POST { projectId } -> for every line, use Claude web_search to find real online sources +
 * prices (with product URL + kind), respecting the project's selected Sources, convert to AUD
 * via live FX, pick the cheapest, compute savings + totals. Product URLs are captured from the
 * actual web_search results and back-filled onto each source by seller domain. */

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const VER = '2023-06-01';
const MODEL = process.env.LIST_MODEL || process.env.SEARCH_MODEL || 'claude-sonnet-5';
const CHUNK = Number(process.env.LIST_CHUNK || 5);
const CONCURRENCY = Number(process.env.LIST_CONCURRENCY || 4);
const BUDGET_MS = Number(process.env.LIST_BUDGET_MS || 250000);
const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: Number(process.env.LIST_SEARCH_USES || 4) };

async function fxToAud() {
  let rates = { AUD: 1, USD: 0.66, EUR: 0.61, GBP: 0.52, ZAR: 12, NZD: 1.09, JPY: 100, CAD: 0.9, AED: 2.4 };
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch('https://open.er-api.com/v6/latest/AUD', { signal: c.signal });
    clearTimeout(t);
    if (r.ok) { const d = await r.json(); if (d && d.rates && d.rates.USD) rates = d.rates; }
  } catch (e) { /* keep fallback */ }
  const alias = { R: 'ZAR', 'R$': 'BRL', '£': 'GBP', '€': 'EUR', $: 'USD', 'US$': 'USD', 'A$': 'AUD', 'AU$': 'AUD', '¥': 'JPY' };
  return function (price, cur) {
    if (price == null || isNaN(price)) return null;
    let c = String(cur || 'AUD').trim().toUpperCase();
    c = alias[c] || c;
    if (c === 'AUD') return price;
    const rate = rates[c];
    return rate ? price / rate : null;
  };
}

function normKind(k) {
  const s = String(k || '').toLowerCase();
  if (/salvage|donor|wreck|used|second|pull/.test(s)) return 'salvage';
  if (/after|repro|replica|copy|non-?genuine|pattern/.test(s)) return 'aftermarket';
  if (/oem|genuine|original|dealer/.test(s)) return 'oem';
  return 'oem';
}

const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function hostToken(u) { try { return alnum(new URL(u).hostname.replace(/^www\./, '')); } catch (e) { return ''; } }
// Best URL from the search results whose domain matches the seller label.
function matchUrl(label, urls) {
  const sk = alnum(String(label || '').split(/[·|\-–—]|\s{2,}| /)[0]); // "Teile.com · Germany" -> "teilecom"
  if (sk.length < 3) return null;
  const cand = urls.filter((u) => { const h = hostToken(u); return h && (h.includes(sk) || sk.includes(h)); });
  cand.sort((a, b) => b.length - a.length); // deepest path first (likely the product page)
  return cand[0] || null;
}

async function findChunk(parts, wants) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};
  const constraint = wants.length
    ? 'ONLY include sources of these kinds: ' + wants.join(', ') + '. Ignore any other kind.'
    : 'Include OEM/genuine, aftermarket and salvage/used sources.';
  const system = [
    'You find CURRENT online prices for specific car parts by part number.',
    'For each part you are given, use web_search to find real online sellers that list it for sale and read the price.',
    'Return ONLY a JSON object mapping the exact part number to an array of sources.',
    'Each source: {"label": seller name, "location": country or region or "", "price": number, "currency": ISO code, "url": the EXACT product/listing page URL you found (copy it verbatim from the search results — the deep link to that specific part, not a homepage or search page), "kind": "oem" | "aftermarket" | "salvage"}.',
    constraint,
    'Include ONLY real sellers you actually found with a listed price. The "url" must be the real product page URL from your search results. Price must be numeric (no symbols/commas). If nothing is found for a part, use an empty array.'
  ].join(' ');
  const user = 'PARTS:\n' + parts.map((p) => '- ' + p.pn + '  (' + p.desc + ')').join('\n') + '\n\nReturn the JSON object now.';
  let messages = [{ role: 'user', content: user }];
  let data = null;
  const searchUrls = [];
  const collect = (content) => {
    for (const b of content || []) {
      if (b && b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const rslt of b.content) if (rslt && rslt.type === 'web_search_result' && typeof rslt.url === 'string') searchUrls.push(rslt.url);
      }
    }
  };
  try {
    for (let i = 0; i < 6; i++) {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000);
      const r = await fetch(ANTHROPIC, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VER },
        body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, messages, tools: [SEARCH_TOOL] }),
        signal: c.signal
      });
      clearTimeout(t);
      if (!r.ok) return {};
      data = await r.json();
      collect(data.content);
      if (data.stop_reason === 'pause_turn') { messages = messages.concat([{ role: 'assistant', content: data.content }]); continue; }
      break;
    }
  } catch (e) { return {}; }
  const text = (data && data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let obj = {};
  try {
    const s = text.slice(text.search(/[{]/)).replace(/[\x00-\x1F]+/g, ' ');
    const e = s.lastIndexOf('}');
    const parsed = JSON.parse(s.slice(0, e + 1));
    if (parsed && typeof parsed === 'object') obj = parsed;
  } catch (e) { return {}; }
  // back-fill missing/weak URLs from the actual search results by seller domain
  for (const pn of Object.keys(obj)) {
    if (!Array.isArray(obj[pn])) continue;
    for (const src of obj[pn]) {
      const ok = src && typeof src.url === 'string' && /^https?:\/\//i.test(src.url);
      if (!ok) { const m = matchUrl(src && src.label, searchUrls); if (m) src.url = m; }
    }
  }
  return obj;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const { projectId } = await readBody(req);
    const { rows } = await sql`SELECT * FROM projects WHERE id = ${projectId}`;
    if (!rows.length) return res.status(404).json({ error: 'project not found' });
    const project = rows[0];
    const cfg = project.config || {};
    const parts = cfg.partsList || [];
    if (!parts.length) return res.status(400).json({ error: 'This project has no parts list.' });

    const f = cfg.filters || {};
    const wants = []; if (f.oem) wants.push('oem'); if (f.aftermarket) wants.push('aftermarket'); if (f.salvage) wants.push('salvage');

    const toAud = await fxToAud();
    const started = Date.now();
    const chunks = [];
    for (let i = 0; i < parts.length; i += CHUNK) chunks.push(parts.slice(i, i + CHUNK));

    const found = {};
    let idx = 0;
    async function worker() {
      while (idx < chunks.length && (Date.now() - started) < BUDGET_MS) {
        const c = chunks[idx++];
        const r = await findChunk(c, wants);
        Object.assign(found, r);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()));

    const results = parts.map((p) => {
      let raw = (found[p.pn] || [])
        .map((s) => ({ label: s && s.label || '', location: s && s.location || '', url: (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) ? s.url : null, kind: normKind(s && s.kind), priceAud: toAud(Number(s && s.price), s && s.currency) }))
        .filter((s) => s.priceAud != null && s.priceAud > 0);
      if (wants.length) raw = raw.filter((s) => wants.includes(s.kind));
      raw.sort((a, b) => a.priceAud - b.priceAud);

      const est = (p.est == null || isNaN(Number(p.est))) ? null : Number(p.est);
      let status = 'notfound', foundP = null, source = null, location = null, bestUrl = null, kind = null, saving = 0;
      if (raw.length) {
        foundP = Math.round(raw[0].priceAud); source = raw[0].label; location = raw[0].location; bestUrl = raw[0].url; kind = raw[0].kind;
        if (est != null && foundP < est) { status = 'saving'; saving = Math.round(est - foundP); }
        else status = 'nocheaper';
      }
      const alts = raw.slice(0, 6).map((s, i) => ({ label: s.label + (s.location ? ' · ' + s.location : ''), price: Math.round(s.priceAud), best: i === 0, url: s.url, kind: s.kind }));
      return { id: p.id, desc: p.desc, pn: p.pn, qty: p.qty, est, found: foundP, source, location, url: bestUrl, kind, matches: raw.length, status, saving, alts };
    });

    const estTotal = Math.round(results.reduce((n, r) => n + (r.est || 0), 0));
    const foundTotal = Math.round(results.reduce((n, r) => n + (r.found != null ? r.found : (r.est || 0)), 0));
    const saveTotal = Math.round(results.reduce((n, r) => n + (r.saving || 0), 0));
    const totals = { estTotal, foundTotal, saveTotal, currency: cfg.currency || 'AUD' };

    const newCfg = Object.assign({}, cfg, { results, totals });
    await sql`UPDATE projects SET config = ${JSON.stringify(newCfg)}::jsonb, run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    return res.status(200).json({ results, totals });
  } catch (e) {
    console.error('run-list error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
