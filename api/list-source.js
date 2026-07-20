import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';
import { deriveListing, sellerFromUrl, guessKind } from './_derive.js';

/* Manual "User" sources for a parts-list project.
 * POST   { projectId, partId, url }  -> derive seller/price/currency/image/kind from the URL,
 *                                       store under config.manualSources[partId], recompute
 *                                       results + totals, return { results, totals }.
 * DELETE { projectId, partId, id }    -> remove a stored manual source, recompute, return same.
 * Manual sources persist across re-hunts (run-list.js merges them back in) and are tagged provider:'user'. */

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
      const derived = await deriveListing(url); // full escalation (incl. residential unblock)
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
