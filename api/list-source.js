import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';

/* Manual "User" sources for a parts-list project.
 * POST   { projectId, partId, url }      -> fetch the URL, derive seller/price/currency/image/kind,
 *                                           store it under config.manualSources[partId], recompute
 *                                           that project's results + totals, return { results, totals }.
 * DELETE { projectId, partId, id }        -> remove a stored manual source, recompute, return same.
 * Manual sources persist across re-hunts (run-list.js merges them back in) and are tagged provider:'user'.
 * Page fetch escalates: direct -> Browserless /unblock (residential, bypasses bot detection/CAPTCHA) -> /content. */

/* ---------- shared price/fx/kind helpers (kept in sync with run-list.js) ---------- */
function parseAmount(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v == null ? '' : v).replace(/[^0-9.,]/g, '');
  if (!s) return null;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lc > -1) {
    const after = s.length - lc - 1;
    s = (after === 1 || after === 2) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (ld > -1) {
    const after = s.length - ld - 1;
    if (after === 3) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
async function fxToAud() {
  let rates = { AUD: 1, USD: 0.66, EUR: 0.61, GBP: 0.52, ZAR: 12, NZD: 1.09, JPY: 100, CAD: 0.9, AED: 2.4 };
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch('https://open.er-api.com/v6/latest/AUD', { signal: c.signal });
    clearTimeout(t);
    if (r.ok) { const d = await r.json(); if (d && d.rates && d.rates.USD) rates = d.rates; }
  } catch (e) { /* keep fallback */ }
  const alias = { R: 'ZAR', 'R$': 'BRL', '£': 'GBP', '€': 'EUR', $: 'USD', 'US$': 'USD', 'A$': 'AUD', 'AU$': 'AUD', '¥': 'JPY', EURO: 'EUR', RAND: 'ZAR' };
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
function buildManualAlts(list, toAud) {
  return (list || []).map((m) => {
    const aud = toAud(parseAmount(m.price), m.currency);
    return { label: (m.label || '') + (m.location ? ' · ' + m.location : ''), price: aud == null ? null : Math.round(aud), url: m.url || null, kind: normKind(m.kind), provider: 'user', manual: true, id: m.id, image: m.image || null };
  });
}
function mergePart(p, manual) {
  const hunted = (p.alts || []).filter((a) => a.provider !== 'user').map((a) => Object.assign({}, a, { best: false, provider: a.provider || 'claude' }));
  const combined = hunted.concat(manual);
  combined.sort((a, b) => (a.price == null ? Infinity : a.price) - (b.price == null ? Infinity : b.price));
  combined.forEach((a) => (a.best = false));
  const fp = combined.find((a) => a.price != null); if (fp) fp.best = true;
  p.alts = combined.slice(0, 12); p.matches = combined.length;
  if (fp) {
    p.found = fp.price; p.source = fp.label; p.url = fp.url; p.kind = fp.kind;
    if (p.est != null && fp.price < p.est) { p.status = 'saving'; p.saving = Math.round(p.est - fp.price); }
    else { p.status = 'nocheaper'; p.saving = 0; }
  } else { p.found = null; p.source = null; p.url = null; p.kind = null; p.status = 'notfound'; p.saving = 0; }
}
async function recomputeAll(cfg) {
  const toAud = await fxToAud();
  const results = cfg.results || [];
  const manualAll = (cfg.manualSources && typeof cfg.manualSources === 'object') ? cfg.manualSources : {};
  for (const p of results) mergePart(p, buildManualAlts(manualAll[p.id], toAud));
  const estTotal = Math.round(results.reduce((n, r) => n + (r.est || 0), 0));
  const foundTotal = Math.round(results.reduce((n, r) => n + (r.found != null ? r.found : (r.est || 0)), 0));
  const saveTotal = Math.round(results.reduce((n, r) => n + (r.saving || 0), 0));
  cfg.results = results;
  cfg.totals = { estTotal, foundTotal, saveTotal, currency: 'AUD' };
}

/* ---------- derive a listing from a product URL ---------- */
function sellerFromUrl(u) { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h; } catch (e) { return ''; } }
function pick(re, html) { const m = html.match(re); return m ? String(m[1]).trim() : null; }
function decode(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim(); }

async function getHtml(url) {
  // 1. Direct fetch — fast; works for un-protected sites.
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 9000);
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'accept-language': 'en' }, signal: c.signal });
    clearTimeout(t);
    if (r.ok) { const txt = await r.text(); if (txt && txt.length > 500) return txt; }
  } catch (e) { /* fall through */ }

  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) return null;
  const base = process.env.BROWSERLESS_BASE || 'https://production-sfo.browserless.io';

  // 2. /unblock with residential proxy — bypasses bot detection / most anti-bot walls.
  const unblock = async (residential) => {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 45000);
      const r = await fetch(base + '/unblock?token=' + key + (residential ? '&proxy=residential' : ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, content: true, cookies: false, screenshot: false, browserWSEndpoint: false, bestAttempt: true, waitForTimeout: 4000 }),
        signal: c.signal
      });
      clearTimeout(t);
      if (r.ok) { const j = await r.json(); if (j && typeof j.content === 'string' && j.content.length > 300) return j.content; }
    } catch (e) { /* try next */ }
    return null;
  };
  let html = await unblock(true);
  if (html) return html;
  html = await unblock(false); // in case the residential add-on isn't enabled
  if (html) return html;

  // 3. Plain /content — last resort.
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
    const r = await fetch(base + '/content?token=' + key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, waitForTimeout: 3500, bestAttempt: true }), signal: c.signal });
    clearTimeout(t);
    if (r.ok) { const txt = await r.text(); if (txt && txt.length > 300) return txt; }
  } catch (e) { /* give up */ }
  return null;
}
function extract(html) {
  let title = null, price = null, currency = null, image = null;
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let j; try { j = JSON.parse(b[1].trim()); } catch (e) { continue; }
    const nodes = Array.isArray(j) ? j : (j['@graph'] ? j['@graph'] : [j]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!title && node.name) title = String(node.name);
      if (!image && node.image) { const im = node.image; image = Array.isArray(im) ? im[0] : (typeof im === 'object' ? (im.url || null) : im); }
      const offers = node.offers ? (Array.isArray(node.offers) ? node.offers : [node.offers]) : [];
      for (const o of offers) {
        if (o && price == null && o.price != null) price = o.price;
        if (o && !currency && o.priceCurrency) currency = o.priceCurrency;
        if (o && o.priceSpecification) { const ps = o.priceSpecification; if (price == null && ps.price != null) price = ps.price; if (!currency && ps.priceCurrency) currency = ps.priceCurrency; }
      }
    }
  }
  if (price == null) price = pick(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i, html) || pick(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i, html) || pick(/["']price["']\s*:\s*["']?([0-9][0-9.,\s]*)/i, html);
  if (!currency) currency = pick(/property=["']product:price:currency["'][^>]*content=["']([^"']+)["']/i, html) || pick(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i, html) || pick(/["']priceCurrency["']\s*:\s*["']([A-Z]{3})["']/i, html);
  if (!title) title = pick(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i, html) || pick(/<title[^>]*>([^<]+)<\/title>/i, html);
  if (!image) image = pick(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i, html);
  return { title: decode(title), price: price, currency: currency, image: image };
}
function guessKind(title, url) {
  const hay = ((title || '') + ' ' + (url || '')).toLowerCase();
  if (/salvage|wreck|donor|pull|second-?hand|\bused\b/.test(hay)) return 'salvage';
  if (/aftermarket|replica|repro|non-?genuine|pattern/.test(hay)) return 'aftermarket';
  return 'oem';
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;
    if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'method not allowed' });

    const body = await readBody(req);
    const projectId = body.projectId, partId = body.partId;
    if (!projectId || !partId) return res.status(400).json({ error: 'projectId and partId are required' });

    const { rows } = await sql`SELECT * FROM projects WHERE id = ${projectId}`;
    if (!rows.length) return res.status(404).json({ error: 'project not found' });
    const cfg = rows[0].config || {};
    if (cfg.kind !== 'list') return res.status(400).json({ error: 'not a parts-list project' });
    if (!Array.isArray(cfg.results)) return res.status(400).json({ error: 'run the hunt before adding sources' });
    cfg.manualSources = (cfg.manualSources && typeof cfg.manualSources === 'object') ? cfg.manualSources : {};
    if (!Array.isArray(cfg.manualSources[partId])) cfg.manualSources[partId] = [];

    if (req.method === 'DELETE') {
      cfg.manualSources[partId] = cfg.manualSources[partId].filter((m) => m.id !== body.id);
    } else {
      const url = (body.url || '').toString().trim();
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Enter a full URL starting with http.' });
      const seller = sellerFromUrl(url);
      if (!seller) return res.status(400).json({ error: 'That does not look like a valid URL.' });
      let derived = { title: null, price: null, currency: null, image: null };
      const html = await getHtml(url);
      if (html) { try { derived = extract(html); } catch (e) { /* keep blanks */ } }
      const manual = {
        id: uid(),
        url,
        label: seller,
        location: '',
        price: parseAmount(derived.price),
        currency: (derived.currency || cfg.currency || 'AUD').toString().toUpperCase().slice(0, 6),
        kind: guessKind(derived.title, url),
        image: derived.image || null,
        title: derived.title || null,
        addedAt: Date.now()
      };
      cfg.manualSources[partId].push(manual);
    }

    await recomputeAll(cfg);
    await sql`UPDATE projects SET config = ${JSON.stringify(cfg)}::jsonb WHERE id = ${projectId}`;
    return res.status(200).json({ results: cfg.results, totals: cfg.totals });
  } catch (e) {
    console.error('list-source error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
