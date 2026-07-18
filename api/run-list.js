import { sql, ensureSchema, readBody } from './_db.js';
import { requireAuth } from './_auth.js';

/* Parts-list hunt engine.
 * POST { projectId } -> for every line in the project's partsList, use Claude web_search
 * to find real online sources + prices, convert each to AUD via live FX, pick the cheapest,
 * compute per-line savings + totals, and store back into the project's config.
 *
 * "No batches" = one request. Internally the lines are processed in parallel chunks with a
 * hard time budget so ~89 lines fit inside the serverless limit. */

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const VER = '2023-06-01';
const MODEL = process.env.LIST_MODEL || process.env.SEARCH_MODEL || 'claude-sonnet-5';
const CHUNK = Number(process.env.LIST_CHUNK || 5);
const CONCURRENCY = Number(process.env.LIST_CONCURRENCY || 4);
const BUDGET_MS = Number(process.env.LIST_BUDGET_MS || 250000);
const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: Number(process.env.LIST_SEARCH_USES || 4) };

// Live FX -> returns fn(price, currency) -> AUD (or null if unknown).
async function fxToAud() {
  let rates = { AUD: 1, USD: 0.66, EUR: 0.61, GBP: 0.52, ZAR: 12, NZD: 1.09, JPY: 100, CAD: 0.9, AED: 2.4 };
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch('https://open.er-api.com/v6/latest/AUD', { signal: c.signal });
    clearTimeout(t);
    if (r.ok) { const d = await r.json(); if (d && d.rates && d.rates.USD) rates = d.rates; }
  } catch (e) { /* keep fallback */ }
  const alias = { R: 'ZAR', 'R$': 'BRL', '£': 'GBP', '€': 'EUR', $: 'USD', 'US$': 'USD', 'A$': 'AUD', 'AU$': 'AUD', '¥': 'JPY' };
  // rates[C] = units of C per 1 AUD; audPrice = priceC / rates[C]
  return function (price, cur) {
    if (price == null || isNaN(price)) return null;
    let c = String(cur || 'AUD').trim().toUpperCase();
    c = alias[c] || c;
    if (c === 'AUD') return price;
    const rate = rates[c];
    return rate ? price / rate : null;
  };
}

async function findChunk(parts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};
  const system = [
    'You find CURRENT online prices for specific car parts by part number.',
    'For each part you are given, use web_search to find real online sellers that list it for sale and read the price.',
    'Return ONLY a JSON object mapping the exact part number to an array of sources.',
    'Each source: {"label": seller name, "location": country or region or "", "price": number, "currency": ISO code e.g. "USD"}.',
    'Include ONLY real sellers you actually found with a listed price. Never invent sellers or prices. Price must be numeric (no symbols/commas). If nothing is found for a part, use an empty array.'
  ].join(' ');
  const user = 'PARTS:\n' + parts.map((p) => '- ' + p.pn + '  (' + p.desc + ')').join('\n') + '\n\nReturn the JSON object now.';
  let messages = [{ role: 'user', content: user }];
  let data = null;
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
      if (data.stop_reason === 'pause_turn') { messages = messages.concat([{ role: 'assistant', content: data.content }]); continue; }
      break;
    }
  } catch (e) { return {}; }
  const text = (data && data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  try {
    const s = text.slice(text.search(/[{]/)).replace(/[\x00-\x1F]+/g, ' ');
    const e = s.lastIndexOf('}');
    const obj = JSON.parse(s.slice(0, e + 1));
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
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

    const toAud = await fxToAud();
    const started = Date.now();
    const chunks = [];
    for (let i = 0; i < parts.length; i += CHUNK) chunks.push(parts.slice(i, i + CHUNK));

    const found = {};
    let idx = 0;
    async function worker() {
      while (idx < chunks.length && (Date.now() - started) < BUDGET_MS) {
        const c = chunks[idx++];
        const r = await findChunk(c);
        Object.assign(found, r);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()));

    const results = parts.map((p) => {
      const raw = (found[p.pn] || [])
        .map((s) => ({ label: s && s.label || '', location: s && s.location || '', priceAud: toAud(Number(s && s.price), s && s.currency) }))
        .filter((s) => s.priceAud != null && s.priceAud > 0);
      raw.sort((a, b) => a.priceAud - b.priceAud);

      const est = (p.est == null || isNaN(Number(p.est))) ? null : Number(p.est);
      let status = 'notfound', foundP = null, source = null, location = null, saving = 0;
      if (raw.length) {
        foundP = Math.round(raw[0].priceAud); source = raw[0].label; location = raw[0].location;
        if (est != null && foundP < est) { status = 'saving'; saving = Math.round(est - foundP); }
        else status = 'nocheaper';
      }
      const alts = raw.slice(0, 6).map((s, i) => ({ label: s.label + (s.location ? ' · ' + s.location : ''), price: Math.round(s.priceAud), best: i === 0 }));
      return { id: p.id, desc: p.desc, pn: p.pn, qty: p.qty, est, found: foundP, source, location, matches: raw.length, status, saving, alts };
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
