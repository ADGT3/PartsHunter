/* Shared listing derivation from a product URL.
 * Used by list-source.js (manual "User" add) and run-list.js (price recovery for parts the
 * web search located but couldn't price). deriveListing(url) -> { title, price, currency, image }.
 * Fetch escalation: Shopify /products/<handle>.json -> direct fetch -> (heavy) Browserless
 * /unblock residential -> Browserless /content. Pass { heavy:false } to skip the slow /unblock
 * steps (used in the bulk hunt to stay within the time budget). */

export function sellerFromUrl(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function pick(re, html) { const m = html.match(re); return m ? String(m[1]).trim() : null; }
function decode(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim(); }

/* Shopify fast-path: authoritative decimal price + currency + images from the store's own JSON. */
async function deriveShopify(url) {
  let u; try { u = new URL(url); } catch (e) { return null; }
  const m = u.pathname.match(/\/products\/([^\/?#]+)/);
  if (!m) return null;
  const jsonUrl = u.origin + '/products/' + m[1].replace(/\.json$/i, '') + '.json';
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(jsonUrl, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    const p = d && d.product; if (!p || !Array.isArray(p.variants) || !p.variants.length) return null;
    const v = p.variants.find((x) => x && x.price != null && x.price !== '') || p.variants[0];
    if (!v || v.price == null || v.price === '') return null;
    const image = (p.image && p.image.src) || (Array.isArray(p.images) && p.images[0] && p.images[0].src) || null;
    return { title: p.title || null, price: v.price, currency: v.price_currency || null, image };
  } catch (e) { return null; }
}

async function getHtml(url, heavy) {
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

  // 2. (heavy only) /unblock with residential proxy — bypasses bot detection / most anti-bot walls.
  if (heavy) {
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
    let h = await unblock(true); if (h) return h;
    h = await unblock(false); if (h) return h;
  }

  // 3. Plain /content (headless render) — reads prices that only appear after JS runs.
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), heavy ? 25000 : 16000);
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
  // The loose JSON "price" match REQUIRES a decimal so it can't grab a cents/pence integer.
  if (price == null) price = pick(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i, html) || pick(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i, html) || pick(/["']price["']\s*:\s*["']?([0-9]{1,7}[.,][0-9]{2})\b/i, html);
  if (!currency) currency = pick(/property=["']product:price:currency["'][^>]*content=["']([^"']+)["']/i, html) || pick(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i, html) || pick(/["']priceCurrency["']\s*:\s*["']([A-Z]{3})["']/i, html);
  if (!title) title = pick(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i, html) || pick(/<title[^>]*>([^<]+)<\/title>/i, html);
  if (!image) image = pick(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i, html);
  return { title: decode(title), price: price, currency: currency, image: image };
}

/* Classify into: oem_new (new genuine) | oem_used (genuine used/second-hand part) |
 * aftermarket (non-genuine/replica) | salvage (part off a whole wrecked/donor vehicle). */
export function guessKind(title, url) {
  const hay = ((title || '') + ' ' + (url || '')).toLowerCase();
  if (/copart|iaai|manheim|pickles|salvage|wreck|whole (car|vehicle)|donor vehicle/.test(hay)) return 'salvage';
  if (/second[- ]?hand|pre-?owned|breaker|dismantl|\bused\b|used-?part|salvage part/.test(hay)) return 'oem_used';
  if (/aftermarket|replica|repro|non-?genuine|pattern/.test(hay)) return 'aftermarket';
  return 'oem_new';
}

export async function deriveListing(url, opts) {
  const heavy = !(opts && opts.heavy === false); // default: full escalation (manual adds)
  const shop = await deriveShopify(url);
  if (shop && shop.price != null) return shop;
  const html = await getHtml(url, heavy);
  if (html) { try { return extract(html); } catch (e) { /* fall through */ } }
  return { title: null, price: null, currency: null, image: null };
}
