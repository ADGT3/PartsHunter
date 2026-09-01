/* Deterministic OEM-catalogue hunt. Plain HTTP only — no extra Claude/web_search. */

const PAGE_WAIT = 12000;
const MAX_PER_SITE = 12;

function enc(s) { return encodeURIComponent(s); }

function queryFrom(project) {
  const cfg = project.config || {};
  const q = (cfg.salvageQuery || project.goal || '').replace(/\s+/g, ' ').trim();
  const firstPn = (q.match(/\b\d{9,11}[A-Z]?\b/i) || [])[0];
  return { q: q.slice(0, 80), pn: firstPn || '' };
}

const CATALOGS = [
  {
    name: 'Eurospares',
    url: (v) => 'https://www.eurospares.com/search?q=' + enc(v.pn || v.q),
    keep: /eurospares\.com\/.+/i,
    drop: /\/search|\/cart|\/account|\/login/i
  },
  {
    name: 'Design911',
    url: (v) => 'https://www.design911.com/search?search=' + enc(v.pn || v.q),
    keep: /design911\.(com|co\.uk)\//i,
    drop: /\/search|\/cart|\/account|\/login|\/blog/i
  },
  {
    name: 'Pelican Parts',
    url: (v) => 'https://www.pelicanparts.com/search.htm?keyword=' + enc(v.pn || v.q),
    keep: /pelicanparts\.com\//i,
    drop: /search\.htm|\/cart|\/login|\/tech/i
  },
  {
    name: 'PartsOQ',
    url: (v) => 'https://partsouq.com/en/search/part?q=' + enc(v.pn || v.q),
    keep: /partsouq\.com\//i,
    drop: /\/search|\/login|\/cart/i
  },
  {
    name: 'FCP Euro',
    url: (v) => 'https://www.fcpeuro.com/search?q=' + enc(v.pn || v.q),
    keep: /fcpeuro\.com\/(products|oem-parts)\//i,
    drop: /\/search|\/cart|\/account/i
  }
];

function absUrl(href, base) {
  if (!href) return '';
  href = href.replace(/&amp;/g, '&').trim();
  if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return '';
  try { return new URL(href, base).href; } catch (e) { return ''; }
}

function strip(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), PAGE_WAIT);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' }
    });
    if (!r.ok) return '';
    return await r.text();
  } catch (e) {
    return '';
  } finally {
    clearTimeout(t);
  }
}

function parseProducts(html, site, pageUrl) {
  const out = [];
  const seen = new Set();
  const re = /href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = absUrl(m[1], pageUrl);
    if (!url) continue;
    if (!site.keep.test(url) || site.drop.test(url)) continue;
    const key = url.toLowerCase().split('?')[0].replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const title = strip(m[2]).slice(0, 180);
    if (title.length < 8) continue;
    out.push({
      section: 'OEM catalogues',
      title,
      description: '',
      price: '',
      currency: '',
      condition: '',
      seller: site.name,
      url,
      image: '',
      badges: ['catalog', site.name],
      source: 'catalog'
    });
    if (out.length >= MAX_PER_SITE) break;
  }
  return out;
}

export async function runCatalogSearch(project) {
  const v = queryFrom(project);
  if (!v.q || v.q.length < 4) return [];
  const rows = [];
  await Promise.all(CATALOGS.map(async (site) => {
    try {
      const page = site.url(v);
      const html = await fetchHtml(page);
      if (!html) return;
      const lots = parseProducts(html, site, page);
      console.log('Catalog', site.name, lots.length);
      rows.push(...lots);
    } catch (e) { /* skip site */ }
  }));
  return rows;
}
