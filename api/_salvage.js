/* Salvage / auction search — verified sources (Jul 2026).
 *
 *  carfast.express : plain fetch  (server-rendered) — aggregates Copart + IAAI US
 *  Pickles (AU)    : plain fetch  (server-rendered) — RHD
 *  Manheim (AU)    : Browserless render (results load via JS) — RHD
 *  Copart          : Browserless render (results load via JS).
 *                    Domain is country-aware: AU/UK/NZ -> copart.co.uk (RHD,
 *                    additive to carfast); otherwise copart.com.
 *
 * Only PUBLIC search-results-level data (title, lot url, price/bid, damage,
 * location). No login. Each page's rendered text is handed to Claude to extract
 * the lots, so we're robust to layout changes.
 *
 * >>> Verified search-URL formats live before shipping. If a site changes its
 *     format, edit SITES below. <<<
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const MODEL = process.env.SEARCH_MODEL || 'claude-sonnet-5';
const BROWSERLESS_BASE = process.env.BROWSERLESS_BASE || 'https://chrome.browserless.io';
const RENDER_WAIT = Number(process.env.SALVAGE_BROWSER_WAIT || 8000);

const lc = (s) => (s || '').toLowerCase().trim();
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const enc = encodeURIComponent;
const RHD = ['au', 'gb', 'uk', 'nz', 'ie', 'za'];

// v = { make, model, modelSlug, query, country }
const SITES = [
  {
    name: 'Carfast', mode: 'plain',
    url: (v) => v.modelSlug
      ? `https://carfast.express/auction/brand-${slug(v.make)},model-${v.modelSlug}`
      : `https://carfast.express/auction/brand-${slug(v.make)}`
  },
  {
    name: 'Pickles', mode: 'plain',
    url: (v) => `https://www.pickles.com.au/used/search/cars/${slug(v.make)}`
  },
  {
    name: 'Manheim', mode: 'render',
    url: (v) => `https://www.manheim.com.au/damaged-vehicles/search?CategoryCode=13&CategoryCodeDescription=${enc('Cars & Light Commercial')}&ManufacturerCode=${enc(v.make.toUpperCase())}&ManufacturerCodeDescription=${enc(v.make)}&refineName=ManufacturerCode`
  },
  {
    name: 'Copart', mode: 'render',
    url: (v) => {
      const base = RHD.includes(v.country) ? 'https://www.copart.co.uk' : 'https://www.copart.com';
      return `${base}/lotSearchResults/?free=true&query=${enc(v.query)}`;
    }
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

// "Poor" = empty, or still an un-rendered JS template shell.
function isPoor(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 500) return true;
  if (/\{\{[^}]*\}\}/.test(t) && t.length < 8000) return true;
  return false;
}

async function normalFetch(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return '';
    return stripHtml(await r.text());
  } catch (e) {
    return '';
  }
}

async function renderFetch(url, retry = true) {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) return '';
  try {
    const r = await fetch(`${BROWSERLESS_BASE}/content?token=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
        waitForTimeout: RENDER_WAIT,
        bestAttempt: true
      })
    });
    // Browserless free/low plans allow 1 concurrent session -> 429. Back off once.
    if (r.status === 429 && retry) {
      await new Promise((res) => setTimeout(res, 3000));
      return renderFetch(url, false);
    }
    if (!r.ok) return '';
    return stripHtml(await r.text());
  } catch (e) {
    return '';
  }
}

// plain sites: fetch first, render only if the raw HTML was thin.
// render sites: render first (results are JS), plain as a last resort.
async function getText(site, url) {
  if (site.mode === 'plain') {
    const n = await normalFetch(url);
    if (!isPoor(n)) return n;
    return await renderFetch(url);
  }
  const b = await renderFetch(url);
  if (!isPoor(b)) return b;
  return await normalFetch(url);
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

// Identify the single vehicle the project is about.
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

// Public entry point. Returns listing objects tagged source:'salvage'.
export async function runSalvageSearch(project) {
  try {
    if (!wantsSalvage(project)) return [];
    const v = await deriveVehicle(project);
    if (!v.make) return [];
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

    // Plain (non-browser) sites can run in parallel.
    const plainSites = SITES.filter((s) => s.mode === 'plain');
    await Promise.all(plainSites.map(async (site) => {
      try { push(await extractLots(await getText(site, site.url(v)), site.name, v), site); }
      catch (e) { /* skip */ }
    }));

    // Render sites hit Browserless -> run ONE AT A TIME to avoid 429 concurrency errors.
    const renderSites = SITES.filter((s) => s.mode === 'render');
    for (const site of renderSites) {
      try { push(await extractLots(await getText(site, site.url(v)), site.name, v), site); }
      catch (e) { /* skip */ }
    }

    return out;
  } catch (e) {
    return [];
  }
}
