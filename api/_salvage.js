/* Salvage / auction search — verified sources (Jul 2026).
 *
 * Fetch strategy per site:
 *   Pickles (AU)  mode 'plain'   — server-rendered, plain fetch. RHD.
 *   Carfast       mode 'unblock' — Cloudflare blocks datacenter IPs; needs
 *   Copart        mode 'unblock'   Browserless /unblock + residential proxy.
 *   Manheim (AU)  mode 'render'  — JS results, Browserless /content (no proxy).
 *
 * Carfast aggregates Copart + IAAI US, so IAAI-direct is NOT queried separately
 * (it was slow and redundant). Copart domain is country-aware (RHD -> .co.uk).
 *
 * The 'unblock' sites only run when BROWSERLESS_PROXY is set, so nothing bills
 * for the paid proxy until you switch it on. The whole step is bounded by
 * SALVAGE_BUDGET_MS and every fetch has a hard timeout, so salvage can never
 * push the function past Vercel's 300s limit.
 *
 *  Env:
 *   BROWSERLESS_API_KEY        (required for render/unblock)
 *   BROWSERLESS_PROXY          '' (off) | 'residential' | 'datacenter'   <-- 'residential' enables Carfast/Copart
 *   BROWSERLESS_BASE           default https://chrome.browserless.io           (/content host)
 *   BROWSERLESS_UNBLOCK_BASE   default https://production-sfo.browserless.io   (/unblock host)
 *   SALVAGE_BROWSER_WAIT       default 5000 (ms per render)
 *   SALVAGE_BUDGET_MS          default 100000 (ms — hard cap on the whole salvage step)
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const BROWSERLESS_BASE = process.env.BROWSERLESS_BASE || 'https://chrome.browserless.io';
const UNBLOCK_BASE = process.env.BROWSERLESS_UNBLOCK_BASE || 'https://production-sfo.browserless.io';
const PROXY = process.env.BROWSERLESS_PROXY || ''; // '' disables unblock sites
const RENDER_WAIT = Number(process.env.SALVAGE_BROWSER_WAIT || 5000);
const BUDGET_MS = Number(process.env.SALVAGE_BUDGET_MS || 100000);
const FETCH_TIMEOUT = 42000;

const lc = (s) => (s || '').toLowerCase().trim();
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RHD = ['au', 'gb', 'uk', 'nz', 'ie', 'za'];

// v = { make, model, modelSlug, query, country }. Browser sites run in THIS order
// within the time budget, so the most valuable source (Carfast) always goes first.
const SITES = [
  {
    name: 'Pickles', mode: 'plain',
    url: (v) => `https://www.pickles.com.au/used/search/cars/${slug(v.make)}`
  },
  {
    name: 'Carfast', mode: 'unblock', proxyCountry: 'us',
    url: (v) => v.modelSlug
      ? `https://carfast.express/auction/brand-${slug(v.make)},model-${v.modelSlug}`
      : `https://carfast.express/auction/brand-${slug(v.make)}`
  },
  {
    name: 'Copart', mode: 'unblock',
    proxyCountry: (v) => (RHD.includes(v.country) ? 'gb' : 'us'),
    url: (v) => {
      const base = RHD.includes(v.country) ? 'https://www.copart.co.uk' : 'https://www.copart.com';
      return `${base}/lotSearchResults/?free=true&query=${enc(v.query)}`;
    }
  },
  {
    name: 'Manheim', mode: 'render',
    url: (v) => `https://www.manheim.com.au/damaged-vehicles/search?CategoryCode=13&CategoryCodeDescription=${enc('Cars & Light Commercial')}&ManufacturerCode=${enc(v.make.toUpperCase())}&ManufacturerCodeDescription=${enc(v.make)}&refineName=ManufacturerCode`
  }
];

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPoor(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 500) return true;
  if (/\{\{[^}]*\}\}/.test(t) && t.length < 8000) return true;
  return false;
}

async function normalFetch(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
    if (!r.ok) return '';
    return stripHtml(await r.text());
  } catch (e) {
    return '';
  } finally {
    clearTimeout(t);
  }
}

// Browserless /content — renders JS, no proxy. For sites that don't block datacenter IPs.
async function renderFetch(url, retry = true) {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) return '';
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(`${BROWSERLESS_BASE}/content?token=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 40000 },
        waitForTimeout: RENDER_WAIT,
        bestAttempt: true
      }),
      signal: c.signal
    });
    if (r.status === 429 && retry) { await sleep(3000); return renderFetch(url, false); }
    if (!r.ok) return '';
    return stripHtml(await r.text());
  } catch (e) {
    return '';
  } finally {
    clearTimeout(t);
  }
}

// Browserless /unblock + residential proxy — bypasses Cloudflare/bot detection for
// sites that block datacenter IPs (Carfast, Copart). Costs proxy units.
async function unblockFetch(url, proxyCountry, retry = true) {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key || !PROXY) return ''; // disabled until BROWSERLESS_PROXY is set
  const params = new URLSearchParams({ token: key, proxy: PROXY });
  if (proxyCountry) params.set('proxyCountry', proxyCountry);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(`${UNBLOCK_BASE}/unblock?${params.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        content: true,
        cookies: false,
        screenshot: false,
        browserWSEndpoint: false,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 40000 },
        waitForTimeout: RENDER_WAIT,
        bestAttempt: true
      }),
      signal: c.signal
    });
    if (r.status === 429 && retry) { await sleep(3000); return unblockFetch(url, proxyCountry, false); }
    if (!r.ok) return '';
    const data = await r.json();
    return stripHtml(data && data.content ? data.content : '');
  } catch (e) {
    return '';
  } finally {
    clearTimeout(t);
  }
}

async function getText(site, v) {
  const url = site.url(v);
  if (site.mode === 'plain') {
    const n = await normalFetch(url);
    if (!isPoor(n)) return n;
    return await renderFetch(url);
  }
  if (site.mode === 'render') {
    const b = await renderFetch(url);
    if (!isPoor(b)) return b;
    return await normalFetch(url);
  }
  if (site.mode === 'unblock') {
    if (!PROXY) return ''; // needs residential proxy; skip until enabled (no cost)
    const pc = typeof site.proxyCountry === 'function' ? site.proxyCountry(v) : site.proxyCountry;
    const u = await unblockFetch(url, pc);
    return isPoor(u) ? '' : u;
  }
  return '';
}

function parseArr(t) {
  const start = t.search(/\[/);
  if (start === -1) return [];
  const s = t.slice(start).replace(/[\x00-\x1F]+/g, ' ');
  const candidates = [];
  const end = s.lastIndexOf(']');
  if (end !== -1) candidates.push(s.slice(0, end + 1));
  const lastObj = s.lastIndexOf('}');
  if (lastObj !== -1) candidates.push(s.slice(0, lastObj + 1).replace(/,\s*$/, '') + ']');
  for (const c of candidates) {
    try { const a = JSON.parse(c); if (Array.isArray(a)) return a; } catch (e) { /* next */ }
  }
  return [];
}

async function anthropic(system, user, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return '';
  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  if (!r.ok) return '';
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function extractLots(text, siteName, v) {
  if (isPoor(text)) return [];
  const system = [
    'You extract vehicle lots from the rendered text of an auction / salvage search-results page.',
    'Return ONLY a JSON array, no prose, no markdown.',
    'Each element: {"section","title","description","price","currency","condition","seller","url","image","badges"}.',
    'Include ONLY vehicles actually present in the text. NEVER invent lots, prices, URLs or images.',
    'Keep ONLY lots whose make (and model, if given) match the vehicle searched; drop other makes/models.',
    'DROP any lot that is already sold / closed / ended (skip it entirely).',
    'seller = the site name given. section = "Salvage & Donor Vehicles".',
    'url = the lot\'s own detail-page URL if present (absolute http URL); if a lot has no usable URL, skip it.',
    'price = current bid / buy-now if shown, else "". condition = damage or write-off/title status if shown (e.g. "Repairable Write-Off", "Front end damage").',
    'badges = short tags such as ["Salvage","Lot 12345","Location: NSW"]. If no matching lots, return [].'
  ].join(' ');
  const user = `SITE (use as seller): ${siteName}\nVEHICLE SEARCHED: ${v.query}${v.model ? ' (model: ' + v.model + ')' : ''}\n\nRENDERED SEARCH-RESULTS TEXT:\n${text.slice(0, 30000)}`;
  try {
    return parseArr(await anthropic(system, user, 4000));
  } catch (e) {
    return [];
  }
}

function fallbackQuery(src) {
  return src
    .replace(/salvage|damaged|wreck\w*|write.?off|donor|for sale|oem|parts?|rhd|right hand drive|front.?end|rebuild/gi, ' ')
    .replace(/[|].*/, '')
    .replace(/[^a-z0-9 ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function deriveVehicle(project) {
  const cfg = project.config || {};
  const country = lc((cfg.filters && cfg.filters.country) || 'all');
  let make = cfg.salvageMake, model = cfg.salvageModel, query = cfg.salvageQuery;
  if (!(make && query)) {
    const src = (project.goal || '') + ' | categories: ' + ((cfg.categories) || []).join(', ');
    try {
      const t = await anthropic(
        'From the text, identify the single vehicle being sought for an auction search. Output ONLY compact JSON: {"make":"","model":"","query":""} — make is the brand (e.g. "Porsche"); model is the base model without trim (e.g. "911"); query is a short full search phrase including trim (e.g. "Porsche 911 GT3 RS"). No prose.',
        src, 80
      );
      const j = JSON.parse(t.slice(t.search(/[{]/), t.lastIndexOf('}') + 1));
      make = make || j.make; model = model || j.model; query = query || j.query;
    } catch (e) { /* fall through */ }
    if (!make) {
      const f = fallbackQuery(src);
      make = f.split(' ')[0] || '';
      model = model || (f.split(' ')[1] || '');
      query = query || f;
    }
  }
  if (!query) query = (make + ' ' + (model || '')).trim();
  return { make: make || '', model: model || '', modelSlug: model ? slug(model) : '', query, country };
}

function wantsSalvage(project) {
  const cfg = project.config || {};
  const f = cfg.filters || {};
  if (f.salvage) return true;
  const hay = ((project.goal || '') + ' ' + ((cfg.categories) || []).join(' ')).toLowerCase();
  return /salvage|wreck|write.?off|donor|damaged|crashed|parts? car/.test(hay);
}

export async function runSalvageSearch(project) {
  const out = [];
  const push = (lots, site) => {
    for (const l of lots) {
      out.push({
        ...l,
        section: l.section || 'Salvage & Donor Vehicles',
        seller: l.seller || site.name,
        source: 'salvage'
      });
    }
  };

  const work = (async () => {
    if (!wantsSalvage(project)) return;
    const v = await deriveVehicle(project);
    if (!v.make) return;

    // Plain (non-browser) sites in parallel.
    const plainSites = SITES.filter((s) => s.mode === 'plain');
    await Promise.all(plainSites.map(async (site) => {
      try { push(await extractLots(await getText(site, v), site.name, v), site); }
      catch (e) { /* skip */ }
    }));

    // Browserless-backed sites (unblock + render) ONE AT A TIME, most valuable first.
    const browserSites = SITES.filter((s) => s.mode !== 'plain');
    for (const site of browserSites) {
      try { push(await extractLots(await getText(site, v), site.name, v), site); }
      catch (e) { /* skip */ }
    }
  })().catch(() => {});

  // Hard wall-clock cap: return whatever we have if the budget is hit.
  let timer;
  await Promise.race([work, new Promise((res) => { timer = setTimeout(res, BUDGET_MS); })]);
  clearTimeout(timer);
  return out;
}
