import { sql, ensureSchema, readBody, uid, parsePriceNum } from './_db.js';
import { requireAuth } from './_auth.js';
import { runSearch, normalizeListing } from './_anthropic.js';
import { runGrokSearch, grokEnabled } from './_grok.js';
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
    l = normalizeListing(l) || l;
    const urlKey = normalizeUrl(l.url);
    const titleKey = normTitle(l.title);
    if (!urlKey && !titleKey) return;

    if (urlKey && byUrl.has(urlKey)) {
      const ex = byUrl.get(urlKey);
      if (!ex.image && l.image) { ex.image = l.image; if (ex.source !== source) ex.source = 'hybrid'; }
      return;
    }
    if (titleKey && byTitle.has(titleKey)) {
      const ex = byTitle.get(titleKey);
      if (!ex.image && l.image) ex.image = l.image;
      if (!ex.url && l.url) ex.url = l.url;
      return;
    }
    const item = { ...l, source };
    if (urlKey) byUrl.set(urlKey, item);
    else byUrl.set('t:' + titleKey, item);
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

const MARKET_HOST_RE = /(ebay\.|copart\.|iaai\.|pickles\.|manheim\.|carfast\.|amazon\.|fbcdn\.|facebook\.com\/marketplace|parts4usa|pelicanparts|fcpeuro|ecstuning|design911|eurospares|oemparts|autohausaz|suncoast|rockauto|lkq|car-part\.com|partsouq|amayama|toyotaparts|porsche\.|tetreault|breakers)/i;

function isProductLike(url) {
  const u = (url || '').toLowerCase();
  return /\/lot\/\d+|\/used\/details\/|\/itm\/|\/p\/\d|\/product[s]?\//.test(u) || MARKET_HOST_RE.test(u);
}

// Index/search pages only — lot/product detail URLs are kept even if the path
// contains "search" as a parent section.
function isIndexUrl(url) {
  const u = (url || '').toLowerCase();
  if (!u) return false;
  if (isProductLike(u)) return false;
  if (/lotsearchresults|\/vehiclelisting\/|vehicle-search-model|\/damaged-vehicles\/search/.test(u)) return true;
  if (/\/used\/search\//.test(u)) return true;
  if (/carfast\.express\/auction\/(brand|body_type|vehicle_type|fuel|retail_price|generation)-/.test(u)) return true;
  if (/\/collections\//.test(u)) return true;
  if (/\/search(?:\/|\?|$)/.test(u)) return true;
  return false;
}

function dropJunk(listings) {
  return listings.filter(l => {
    const url = l.url || '';
    if (url && JUNK_URL_RE.test(url)) return false;
    if (url && isIndexUrl(url) && l.source !== 'salvage') return false;
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
  if ((filters.oem_new || filters.oem_used || filters.oem) && !filters.aftermarket) {
    out.push('CONSTRAINT: OEM only. Exclude aftermarket, replica, reproduction, pattern, and non-genuine parts.');
  }
  const geo = countryConstraint(normCountries(filters));
  if (geo) out.push(geo);
  return out;
}

const GEN_FAMILIES = [
  ['992', '991', '997', '996', '993', '964'],
  ['982', '981', '987', '986', '718'],
  ['971', '970'],
  ['9y0', '958', '955']
];
const AFTERMARKET_RE = /\bafter[\s-]?market\b|\breplica\b|\brepro(?:duction)?\b|\bnon-?genuine\b|\bpattern part\b|\bnot oem\b|\bnot genuine\b|\bimitation\b|\blook-?alike\b|\brep\.?\s*carbon\b/i;
const OEM_RE = /\boem\b|\bgenuine\b|\boriginal equipment\b|\bporsche tequipment\b|\boe part\b/i;

function listingBlob(l) {
  return [l.title, l.description, l.url, l.seller, Array.isArray(l.badges) ? l.badges.join(' ') : ''].join(' ').toLowerCase();
}

export function projectSpec(project) {
  const cfg = project.config || {};
  const f = cfg.filters || {};
  const hay = ((project.goal || '') + ' ' + (cfg.salvageQuery || '') + ' ' + (cfg.salvageModel || '') + ' ' + ((cfg.categories || []).join(' '))).toLowerCase();
  const targetGens = [];
  const forbidGens = [];
  for (const fam of GEN_FAMILIES) {
    const present = fam.filter((g) => new RegExp('\\b' + g + '\\b', 'i').test(hay));
    if (present.length) {
      present.forEach((g) => { if (targetGens.indexOf(g) === -1) targetGens.push(g); });
      fam.forEach((g) => { if (present.indexOf(g) === -1) forbidGens.push(g); });
    }
  }
  const oemWanted = !!(f.oem_new || f.oem_used || f.oem);
  const aftermarketOk = !!f.aftermarket;
  const oemOnly = oemWanted && !aftermarketOk;
  return { targetGens, forbidGens, oemOnly, aftermarketOk };
}

function dropOffSpec(listings, spec) {
  if (!spec) return listings;
  return listings.filter((l) => {
    const hay = listingBlob(l);
    if (spec.forbidGens.length) {
      const hasTarget = spec.targetGens.some((g) => new RegExp('\\b' + g + '\\b', 'i').test(hay));
      const hasForbid = spec.forbidGens.some((g) => new RegExp('\\b' + g + '\\b', 'i').test(hay));
      // Drop 991-only (etc.) listings. Keep if they also name the target gen (shared fitment).
      if (hasForbid && !hasTarget) return false;
    }
    if (spec.oemOnly && AFTERMARKET_RE.test(hay) && !OEM_RE.test(hay)) return false;
    return true;
  });
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
    const specForPrompt = projectSpec(project);
    const filterRules = filtersToRules(project.config && project.config.filters);
    if (specForPrompt.targetGens.length) {
      filterRules.push('CONSTRAINT (fitment): target generation(s) ' + specForPrompt.targetGens.join(', ') + '. Exclude listings that only fit ' + specForPrompt.forbidGens.join(', ') + ' unless they also list a target generation.');
    }
    const searchProject = filterRules.length
      ? { ...project, config: { ...(project.config || {}), rules: [ ...((project.config && project.config.rules) || []), ...filterRules ] } }
      : project;

    const claudePromise = runSearch(searchProject, fb).catch(e => {
      claudeErr = (e && e.message) ? e.message : String(e);
      console.error('Claude failed:', claudeErr);
      return [];
    });

    const grokPromise = grokEnabled()
      ? runGrokSearch(searchProject, fb).catch(e => {
          grokErr = (e && e.message) ? e.message : String(e);
          console.error('Grok failed:', grokErr);
          return [];
        })
      : Promise.resolve([]);

    const salvagePromise = runSalvageSearch(searchProject).catch(e => {
      salvageErr = (e && e.message) ? e.message : String(e);
      console.error('Salvage failed:', salvageErr);
      return [];
    });

    [claudeListings, grokListings, salvageListings] = await Promise.all([claudePromise, grokPromise, salvagePromise]);

    const { rows: existingRows } = await sql`SELECT section, title, description, price, currency, condition, seller, url, image, badges, source FROM listings WHERE project_id = ${projectId}`;
    const existing = existingRows.map(r => ({ ...r, badges: Array.isArray(r.badges) ? r.badges : [] }));
    const downvoted = new Set((fb || []).filter(f => f.vote < 0).map(f => normalizeUrl(f.listing_url)));

    const merged = mergeAndDeduplicate([...salvageListings, ...existing], claudeListings, grokListings);
    const spec = projectSpec(project);
    const afterSold = dropSold(merged);
    const afterJunk = dropJunk(afterSold);
    const afterSpec = dropOffSpec(afterJunk, spec);
    let listings = afterSpec.filter(l => !l.url || !downvoted.has(normalizeUrl(l.url)));

    listings = snapSections(listings, (project.config && project.config.categories) || []);

    const stats = {
      claude: claudeListings.length,
      grok: grokEnabled() ? grokListings.length : 'skipped',
      salvage: salvageListings.length,
      existing: existing.length,
      afterMerge: merged.length,
      droppedSold: merged.length - afterSold.length,
      droppedJunk: afterSold.length - afterJunk.length,
      droppedOffSpec: afterJunk.length - afterSpec.length,
      droppedDownvote: afterSpec.length - listings.length,
      targetGens: spec.targetGens,
      oemOnly: spec.oemOnly,
      final: listings.length,
      claudeErr,
      grokErr,
      salvageErr
    };
    console.log('=== RUN STATS ===', JSON.stringify(stats));

    if (listings.length === 0) {
      const detail = 'Claude: ' + (claudeErr ? ('ERROR — ' + claudeErr) : (claudeListings.length + ' returned')) +
                     ' | Grok: ' + (grokEnabled() ? (grokErr ? ('ERROR — ' + grokErr) : (grokListings.length + ' returned')) : 'skipped') +
                     ' | Salvage: ' + (salvageErr ? ('ERROR — ' + salvageErr) : (salvageListings.length + ' returned')) +
                     ' | filters dropped sold=' + stats.droppedSold + ' junk=' + stats.droppedJunk + ' off-spec=' + stats.droppedOffSpec + ' down=' + stats.droppedDownvote;
      if (existing.length) {
        console.warn('Hunt empty; keeping last-good listings:', existing.length, detail);
        return res.status(200).json({
          runId: null,
          count: existing.length,
          listings: existing,
          stale: true,
          warning: 'Hunt returned no new listings. Showing last good results. ' + detail,
          stats
        });
      }
      return res.status(502).json({ error: 'No results. ' + detail, stats });
    }

    await Promise.allSettled(
      listings.slice(0, 20).map(async (l) => {
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
      listings: responseListings,
      stats
    });

  } catch (e) {
    console.error('Run handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
