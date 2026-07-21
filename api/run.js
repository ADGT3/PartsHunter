import { sql, ensureSchema, readBody, uid, parsePriceNum } from './_db.js';
import { requireAuth } from './_auth.js';
import { runSearch } from './_anthropic.js';
import { runGrokSearch } from './_grok.js';
import { runSalvageSearch } from './_salvage.js';
import { normCountries, countryConstraint } from './_geo.js';

const CAP = Number(process.env.RUN_CAP_PER_DAY || 20);

// Force image URLs to https so they aren't blocked as mixed content on the https site.
function httpsImg(u){ if(!u) return ''; u=String(u).trim(); if(u.startsWith('//')) return 'https:'+u; return u.replace(/^http:\/\//i,'https://'); }

async function ogImage(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return '';
    const html = (await r.text()).slice(0, 500000);
    const m = html.match(/<meta[^>]+property=["']og:image[^"']*["'][^>]*content=["']([^"']+)["']/i) ||
              html.match(/<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
    let u = m ? m[1] : '';
    if (u && u.startsWith('//')) u = 'https:' + u;
    return u ? u.replace(/&amp;/g, '&') : '';
  } catch (e) {
    return '';
  }
}

function normalizeUrl(url) {
  if (!url) return '';
  let u = url.toLowerCase().trim();
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  u = u.split('#')[0].split('?')[0];
  u = u.replace(/\/$/, '');
  u = u.replace(/\/en-au\//, '/').replace(/\/en\//, '/');
  return u;
}

function normTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mergeAndDeduplicate(existing = [], claude = [], grok = []) {
  const byUrl = new Map();
  const byTitle = new Map();

  const add = (l, source) => {
    const urlKey = normalizeUrl(l.url);
    if (!urlKey) return;
    const titleKey = normTitle(l.title);

    if (byUrl.has(urlKey)) {
      const ex = byUrl.get(urlKey);
      if (!ex.image && l.image) { ex.image = l.image; if (ex.source !== source) ex.source = 'hybrid'; }
      return;
    }
    if (titleKey && byTitle.has(titleKey)) {
      const ex = byTitle.get(titleKey);
      if (!ex.image && l.image) ex.image = l.image;
      return;
    }
    const item = { ...l, source };
    byUrl.set(urlKey, item);
    if (titleKey) byTitle.set(titleKey, item);
  };

  existing.forEach(l => add(l, l.source || 'unknown'));
  claude.forEach(l => add(l, 'claude'));
  grok.forEach(l => add(l, 'grok'));
  return Array.from(byUrl.values());
}

const SOLD_RE = /\b(sold|ended|no longer available|withdrawn|expired|unavailable|out of stock)\b/i;
function dropSold(listings) {
  return listings.filter(l => !SOLD_RE.test((l.title || '') + ' | ' + (l.condition || '')));
}

const JUNK_URL_RE = /(reddit\.com|youtube\.com|youtu\.be|wikipedia\.org|facebook\.com|twitter\.com|x\.com|instagram\.com|911uk\.com|\/threads?\/|showthread|viewtopic|\/wiki\/)/i;
// Generic search / category / listing-index pages masquerading as a single listing.
// (Specific lot/product pages are kept: /lot/123, /VehicleDetail/123, /auction/lots/123, /used/details/..., /products/...)
const SEARCH_URL_RE = /(\/vehiclelisting\/|lotsearchresults|vehicle-search-model|\/damaged-vehicles\/search|\/used\/search\/|carfast\.express\/auction\/(brand|body_type|vehicle_type|fuel|retail_price|generation)-|\/collections\/|[?&](q|query|keyword|search|free)=|\/search(?:\/|\?|$))/i;
function dropJunk(listings) {
  return listings.filter(l => {
    if (JUNK_URL_RE.test(l.url || '')) return false;
    if (SEARCH_URL_RE.test(l.url || '')) return false;
    if (/reported|at time of|forum/i.test(l.price || '')) return false;
    return true;
  });
}

// Force every listing's section to be one of the project's config categories.
const SECTION_STOP = new Set(['and', 'the', 'for', 'with', 'parts', 'part', 'vehicle', 'vehicles', 'system', 'oem']);
function words(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(w => w.length > 2 && !SECTION_STOP.has(w));
}
function snapSections(listings, categories) {
  const cats = (categories || []).filter(Boolean);
  if (!cats.length) return listings;
  const catWords = cats.map(c => ({ name: c, words: words(c) }));
  const normOf = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  return listings.map(l => {
    const sec = l.section || '';
    const exact = cats.find(c => normOf(c) === normOf(sec));
    if (exact) return { ...l, section: exact };
    const hay = words(sec + ' ' + (l.title || ''));
    let best = cats[0], bestScore = -1;
    for (const c of catWords) {
      let score = 0;
      for (const cw of c.words) {
        if (hay.some(hw => hw === cw || (cw.length > 3 && (hw.includes(cw) || cw.includes(hw))))) score++;
      }
      if (score > bestScore) { bestScore = score; best = c.name; }
    }
    return { ...l, section: best };
  });
}

// Translate the user's filter checkboxes / countries into search constraints.
// Country geography (source-domain) constraint is shared with the parts-list engine via _geo.js.
function filtersToRules(filters) {
  if (!filters) return [];
  const out = [];
  const kinds = [];
  if (filters.oem_new || filters.oem) kinds.push('new genuine OEM parts');
  if (filters.oem_used || filters.oem) kinds.push('used / second-hand genuine OEM parts (used-parts dealers, breakers)');
  if (filters.aftermarket) kinds.push('aftermarket parts');
  if (filters.salvage) kinds.push('salvage / donor vehicles');
  if (kinds.length) {
    out.push('CONSTRAINT (result type): ONLY include ' + kinds.join(', ') + '. Exclude anything that is none of these.');
  }
  const geo = countryConstraint(normCountries(filters));
  if (geo) out.push(geo);
  return out;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const body = await readBody(req);
    const projectId = body.projectId;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const { rows: pr } = await sql`SELECT * FROM projects WHERE id = ${projectId}`;
    if (!pr.length) return res.status(404).json({ error: 'project not found' });
    const project = pr[0];

    const { rows: cnt } = await sql`SELECT COUNT(*)::int AS n FROM runs WHERE project_id = ${projectId} AND created_at > now() - interval '24 hours'`;
    if (cnt[0].n >= CAP) {
      return res.status(429).json({ error: `Daily run cap (${CAP}) reached.` });
    }

    const { rows: fb } = await sql`SELECT listing_url as listing_url, listing_title, seller, vote, reason FROM feedback WHERE project_id = ${projectId}`;

    let claudeListings = [];
    let grokListings = [];
    let salvageListings = [];
    let claudeErr = null;
    let grokErr = null;
    let salvageErr = null;

    // Apply the project's filter checkboxes/country as extra search constraints.
    const filterRules = filtersToRules(project.config && project.config.filters);
    const searchProject = filterRules.length
      ? { ...project, config: { ...(project.config || {}), rules: [ ...((project.config && project.config.rules) || []), ...filterRules ] } }
      : project;

    const claudePromise = runSearch(searchProject, fb).catch(e => {
      claudeErr = (e && e.message) ? e.message : String(e);
      console.error('Claude failed:', claudeErr);
      return [];
    });

    const grokPromise = runGrokSearch(searchProject, fb).catch(e => {
      grokErr = (e && e.message) ? e.message : String(e);
      console.error('Grok failed:', grokErr);
      return [];
    });

    const salvagePromise = runSalvageSearch(searchProject).catch(e => {
      salvageErr = (e && e.message) ? e.message : String(e);
      console.error('Salvage failed:', salvageErr);
      return [];
    });

    [claudeListings, grokListings, salvageListings] = await Promise.all([claudePromise, grokPromise, salvagePromise]);

    const { rows: existingRows } = await sql`SELECT section, title, description, price, currency, condition, seller, url, image, badges, source FROM listings WHERE project_id = ${projectId}`;
    const existing = existingRows.map(r => ({ ...r, badges: Array.isArray(r.badges) ? r.badges : [] }));
    const downvoted = new Set((fb || []).filter(f => f.vote < 0).map(f => normalizeUrl(f.listing_url)));

    let listings = dropJunk(dropSold(mergeAndDeduplicate([...salvageListings, ...existing], claudeListings, grokListings)))
      .filter(l => !downvoted.has(normalizeUrl(l.url)));

    listings = snapSections(listings, (project.config && project.config.categories) || []);

    console.log(`=== RUN STATS === Claude: ${claudeListings.length} | Grok: ${grokListings.length} | Salvage: ${salvageListings.length} | Final: ${listings.length}`);

    if (listings.length === 0) {
      const detail = 'Claude: ' + (claudeErr ? ('ERROR — ' + claudeErr) : (claudeListings.length + ' returned')) +
                     ' | Grok: ' + (grokErr ? ('ERROR — ' + grokErr) : (grokListings.length + ' returned')) +
                     ' | Salvage: ' + (salvageErr ? ('ERROR — ' + salvageErr) : (salvageListings.length + ' returned'));
      return res.status(502).json({ error: 'No results. ' + detail });
    }

    await Promise.allSettled(
      listings.slice(0, 40).map(async (l) => {
        if (!l.image && l.url) {
          l.image = await ogImage(l.url);
        }
      })
    );

    const runId = uid();
    await sql`INSERT INTO runs (id, project_id, status, listing_count, notes) VALUES (${runId}, ${projectId}, 'complete', ${listings.length}, 'Hybrid Claude + Grok')`;

    await sql`DELETE FROM listings WHERE project_id = ${projectId}`;

    for (const l of listings) {
      const badges = Array.isArray(l.badges) ? l.badges : [];
      await sql`INSERT INTO listings (id, project_id, run_id, section, title, description, price, price_num, currency, condition, seller, url, image, badges, source)
        VALUES (
          ${uid()},
          ${projectId},
          ${runId},
          ${l.section || 'Results'},
          ${l.title || ''},
          ${l.description || ''},
          ${l.price || ''},
          ${parsePriceNum(l.price)},
          ${l.currency || 'USD'},
          ${l.condition || ''},
          ${l.seller || 'Other'},
          ${l.url || ''},
          ${httpsImg(l.image)},
          ${JSON.stringify(badges)}::jsonb,
          ${l.source || 'unknown'}
        )`;
    }

    await sql`UPDATE projects SET run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    const responseListings = listings.map(l => ({
      ...l,
      id: uid(),
      project_id: projectId,
      run_id: runId
    }));

    console.log(`Returning ${responseListings.length} listings to client`);

    return res.status(200).json({
      runId,
      count: listings.length,
      listings: responseListings
    });

  } catch (e) {
    console.error('Run handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
