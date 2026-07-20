import { sql, ensureSchema, readBody } from './_db.js';
import { requireAuth } from './_auth.js';
import { deriveListing, sellerFromUrl } from './_derive.js';

/* Parts-list hunt engine. Source kinds: oem_new | oem_used | aftermarket | salvage.
 *   oem_new  = brand-new genuine OEM part
 *   oem_used = genuine used/second-hand part sold as a part (used-parts dealers, eBay listings, breakers)
 *   aftermarket = non-genuine / replica / pattern part
 *   salvage  = the part is on a whole salvage/wrecked vehicle for sale (Copart, IAAI, Manheim, Pickles)
 * Hunted sources tagged provider:'claude'; user manual sources (provider:'user') merged back in.
 * Price recovery: parts LOCATED (URL) but not PRICED get their page fetched via deriveListing(). */

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const VER = '2023-06-01';
const MODEL = process.env.LIST_MODEL || process.env.SEARCH_MODEL || 'claude-sonnet-5';
const CHUNK = Number(process.env.LIST_CHUNK || 3);
const CONCURRENCY = Number(process.env.LIST_CONCURRENCY || 6);
const BUDGET_MS = Number(process.env.LIST_BUDGET_MS || 260000);
const PRICE_FETCHES = Number(process.env.LIST_PRICE_FETCHES || 8);
const RECOVER_HEADROOM_MS = 30000;
const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: Number(process.env.LIST_SEARCH_USES || 6) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* Normalise a source's kind to one of the four buckets. */
function normKind(k) {
  const s = String(k || '').toLowerCase();
  if (/copart|iaai|manheim|pickles|salvage|wreck|whole[\s_-]?(car|vehicle)|donor vehicle/.test(s)) return 'salvage';
  if (/oem[\s_-]?used|used[\s_-]?oem|second[- ]?hand|pre-?owned|breaker|dismantl|\bused\b|pull/.test(s)) return 'oem_used';
  if (/after|repro|replica|copy|non-?genuine|pattern/.test(s)) return 'aftermarket';
  return 'oem_new';
}

const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function hostToken(u) { try { return alnum(new URL(u).hostname.replace(/^www\./, '')); } catch (e) { return ''; } }
function matchUrl(label, urls) {
  const sk = alnum(String(label || '').split(/[·|\-–—]|\s{2,}| /)[0]);
  if (sk.length < 3) return null;
  const cand = urls.filter((u) => { const h = hostToken(u); return h && (h.includes(sk) || sk.includes(h)); });
  cand.sort((a, b) => {
    const pa = /\/\d{4,}\/?$/.test(a.split('?')[0]) ? 1 : 0;
    const pb = /\/\d{4,}\/?$/.test(b.split('?')[0]) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return b.length - a.length;
  });
  return cand[0] || null;
}

function buildManualAlts(list, toAud) {
  return (list || []).map((m) => {
    const aud = toAud(parseAmount(m.price), m.currency);
    return { label: (m.label || '') + (m.location ? ' · ' + m.location : ''), price: aud == null ? null : Math.round(aud), url: m.url || null, kind: normKind(m.kind), provider: 'user', manual: true, id: m.id, image: m.image || null };
  });
}
function mergePart(p, extra) {
  const hunted = (p.alts || []).filter((a) => a.provider !== 'user').map((a) => Object.assign({}, a, { best: false, provider: a.provider || 'claude' }));
  const combined = hunted.concat(extra);
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

async function findChunk(parts, wants) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return {};
  const constraint = wants.length
    ? 'ONLY include sources of these kinds: ' + wants.join(', ') + '. Ignore any other kind.'
    : 'Include all four kinds where available.';
  const system = [
    'You find CURRENT online prices for specific car parts by part number.',
    'For EACH part number given, run a web_search for that exact part number and read the EXACT displayed price. List AS MANY distinct sellers as your results show that stock it — aim for 2 to 4 sources per part so the buyer can compare and find the cheapest. Do NOT stop after the first seller.',
    'Return ONLY a JSON object mapping the exact part number to an array of sources (one entry per distinct seller).',
    'Each source: {"label": seller, "location": country or "", "price": number, "currency": ISO code, "url": product page URL if you have it (the deep link to that exact part, not a category/search page; otherwise omit it), "kind": "oem_new"|"oem_used"|"aftermarket"|"salvage"}.',
    'KIND definitions: "oem_new" = brand-new genuine OEM part; "oem_used" = a genuine USED / second-hand part sold as a part (used-parts dealers, eBay part listings, breakers / dismantlers); "aftermarket" = non-genuine / replica / pattern part; "salvage" = the part is on a WHOLE salvage/wrecked vehicle for sale (Copart, IAAI, Manheim, Pickles) that carries this exact part — the same part often fits several vehicles, so a matching donor vehicle counts.',
    'PRICE RULES: give the exact price shown as a plain number using a dot for the decimal and NO thousands separators. Beware European formatting — "3.568,70 €" means 3568.70 EUR. Set "currency" to the currency actually shown; do not convert.',
    'If you find a seller that clearly stocks the part but you CANNOT read a price (price behind vehicle selection, "POA", login, etc.), STILL include it with its product "url" and omit "price" — do not discard it.',
    constraint,
    'Include EVERY distinct real seller you find. Check SEVERAL catalogues — e.g. teile.com, eurospares, design911, oempartsonline, pelican parts, ecs tuning, fcp euro, suncoast, autohaus, eBay, plus used-parts breakers and salvage auctions. If nothing is found for a part, use an empty array for that part number.'
  ].join(' ');
  const user = 'PARTS:\n' + parts.map((p) => '- ' + p.pn + '  (' + p.desc + ')').join('\n') + '\n\nReturn the JSON object now.';
  let messages = [{ role: 'user', content: user }];
  let data = null, retries = 0;
  const searchUrls = [];
  const collect = (content) => {
    for (const b of content || []) {
      if (b && b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const rslt of b.content) if (rslt && rslt.type === 'web_search_result' && typeof rslt.url === 'string') searchUrls.push(rslt.url);
      }
    }
  };
  try {
    for (let i = 0; i < 10; i++) {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 90000);
      let r;
      try {
        r = await fetch(ANTHROPIC, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VER },
          body: JSON.stringify({ model: MODEL, max_tokens: 4500, system, messages, tools: [SEARCH_TOOL] }),
          signal: c.signal
        });
      } finally { clearTimeout(t); }
      if (!r.ok) {
        if ((r.status === 429 || r.status === 529 || r.status >= 500) && retries < 3) { retries++; await sleep(2000 * retries); continue; }
        return {};
      }
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

    const estCur = cfg.currency || 'AUD';
    const f = cfg.filters || {};
    const wants = [];
    if (f.oem_new || f.oem) wants.push('oem_new');
    if (f.oem_used || f.oem) wants.push('oem_used');
    if (f.aftermarket) wants.push('aftermarket');
    if (f.salvage) wants.push('salvage');
    const manualAll = (cfg.manualSources && typeof cfg.manualSources === 'object') ? cfg.manualSources : {};

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

    const recoverQueue = [];
    const results = parts.map((p) => {
      const srcs = found[p.pn] || [];
      let raw = []; const unpriced = [];
      for (const s of srcs) {
        const url = (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) ? s.url : null;
        const kind = normKind(s && s.kind);
        const priceAud = toAud(parseAmount(s && s.price), s && s.currency);
        if (priceAud != null && priceAud > 0) raw.push({ label: (s && s.label) || '', location: (s && s.location) || '', url, kind, priceAud });
        else if (url) unpriced.push({ label: (s && s.label) || sellerFromUrl(url), url, kind, currency: s && s.currency });
      }
      if (wants.length) raw = raw.filter((s) => wants.includes(s.kind));

      const seen = {}; const deduped = [];
      for (const s of raw) {
        const k = hostToken(s.url) || alnum(s.label);
        if (!k) { deduped.push(s); continue; }
        if (seen[k] == null) { seen[k] = deduped.length; deduped.push(s); }
        else if (s.priceAud < deduped[seen[k]].priceAud) deduped[seen[k]] = s;
      }
      raw = deduped.sort((a, b) => a.priceAud - b.priceAud);

      const rawEst = parseAmount(p.est);
      const estA = rawEst == null ? null : (toAud(rawEst, estCur) != null ? toAud(rawEst, estCur) : rawEst);
      const est = estA == null ? null : Math.round(estA);

      let status = 'notfound', foundP = null, source = null, location = null, bestUrl = null, kind = null, saving = 0;
      if (raw.length) {
        foundP = Math.round(raw[0].priceAud); source = raw[0].label; location = raw[0].location; bestUrl = raw[0].url; kind = raw[0].kind;
        if (est != null && foundP < est) { status = 'saving'; saving = Math.round(est - foundP); }
        else status = 'nocheaper';
      }
      const alts = raw.slice(0, 8).map((s, i) => ({ label: s.label + (s.location ? ' · ' + s.location : ''), price: Math.round(s.priceAud), best: i === 0, url: s.url, kind: s.kind, provider: 'claude' }));
      const part = { id: p.id, desc: p.desc, pn: p.pn, qty: p.qty, est, found: foundP, source, location, url: bestUrl, kind, matches: raw.length, status, saving, alts };
      if (part.matches === 0 && unpriced.length) recoverQueue.push({ p: part, cands: unpriced.slice(0, 2) });
      return part;
    });

    // Price recovery: fetch a located-but-unpriced product page to read the price (best-effort, capped).
    let fetches = 0;
    for (const item of recoverQueue) {
      if (fetches >= PRICE_FETCHES || (Date.now() - started) >= (BUDGET_MS - RECOVER_HEADROOM_MS)) break;
      for (const cand of item.cands) {
        if (fetches >= PRICE_FETCHES || (Date.now() - started) >= (BUDGET_MS - RECOVER_HEADROOM_MS)) break;
        if (wants.length && !wants.includes(cand.kind)) continue;
        let d = null; try { d = await deriveListing(cand.url, { heavy: false }); } catch (e) { d = null; }
        fetches++;
        const pa = d ? toAud(parseAmount(d.price), d.currency || cand.currency) : null;
        if (pa != null && pa > 0) {
          mergePart(item.p, [{ label: cand.label || sellerFromUrl(cand.url), price: Math.round(pa), url: cand.url, kind: cand.kind, provider: 'claude', best: false, image: (d && d.image) || null }]);
          break;
        }
      }
    }

    // Fold in any user-added manual sources so they survive the re-hunt.
    for (const p of results) {
      const manual = buildManualAlts(manualAll[p.id], toAud);
      if (manual.length) mergePart(p, manual);
    }

    const estTotal = Math.round(results.reduce((n, r) => n + (r.est || 0), 0));
    const foundTotal = Math.round(results.reduce((n, r) => n + (r.found != null ? r.found : (r.est || 0)), 0));
    const saveTotal = Math.round(results.reduce((n, r) => n + (r.saving || 0), 0));
    const totals = { estTotal, foundTotal, saveTotal, currency: 'AUD' };

    const newCfg = Object.assign({}, cfg, { results, totals });
    await sql`UPDATE projects SET config = ${JSON.stringify(newCfg)}::jsonb, run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    return res.status(200).json({ results, totals });
  } catch (e) {
    console.error('run-list error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
