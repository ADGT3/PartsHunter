import { sql, ensureSchema, readBody, uid, parsePriceNum } from './_db.js';
import { requireAuth } from './_auth.js';
import { runSearch } from './_anthropic.js';
import { runGrokSearch } from './_grok.js';

const CAP = Number(process.env.RUN_CAP_PER_DAY || 20);

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

// Dedupe by URL AND by title (catches the same item listed on multiple sites).
// Claude is added first so it keeps priority; Grok only fills gaps.
function mergeAndDeduplicate(claude = [], grok = []) {
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

  claude.forEach(l => add(l, 'claude'));
  grok.forEach(l => add(l, 'grok'));
  return Array.from(byUrl.values());
}

// Drop listings that are clearly no longer available.
const SOLD_RE = /\b(sold|ended|no longer available|withdrawn|expired|unavailable|out of stock)\b/i;
function dropSold(listings) {
  return listings.filter(l => !SOLD_RE.test((l.title || '') + ' | ' + (l.condition || '')));
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
    let claudeErr = null;
    let grokErr = null;

    const claudePromise = runSearch(project, fb).catch(e => {
      claudeErr = (e && e.message) ? e.message : String(e);
      console.error('Claude failed:', claudeErr);
      return [];
    });

    const grokPromise = runGrokSearch(project, fb).catch(e => {
      grokErr = (e && e.message) ? e.message : String(e);
      console.error('Grok failed:', grokErr);
      return [];
    });

    [claudeListings, grokListings] = await Promise.all([claudePromise, grokPromise]);

    let listings = dropSold(mergeAndDeduplicate(claudeListings, grokListings));

    console.log(`=== RUN STATS === Claude: ${claudeListings.length} | Grok: ${grokListings.length} | Final: ${listings.length}`);

    if (listings.length === 0) {
      const detail = 'Claude: ' + (claudeErr ? ('ERROR — ' + claudeErr) : (claudeListings.length + ' returned')) +
                     ' | Grok: ' + (grokErr ? ('ERROR — ' + grokErr) : (grokListings.length + ' returned'));
      return res.status(502).json({ error: 'No results. ' + detail });
    }

    // Enrich images (first 40)
    await Promise.allSettled(
      listings.slice(0, 40).map(async (l) => {
        if (!l.image && l.url) {
          l.image = await ogImage(l.url);
        }
      })
    );

    const runId = uid();
    await sql`INSERT INTO runs (id, project_id, status, listing_count, notes) VALUES (${runId}, ${projectId}, 'complete', ${listings.length}, 'Hybrid Claude + Grok')`;

    // Insert all listings
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
          ${l.image || ''},
          ${JSON.stringify(badges)}::jsonb,
          ${l.source || 'unknown'}
        )`;
    }

    await sql`UPDATE projects SET run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    // IMPORTANT: Return the in-memory listings so the UI always has them
    // (avoids any SELECT timing / visibility issues)
    const responseListings = listings.map(l => ({
      ...l,
      id: uid(), // temporary client-side id
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
