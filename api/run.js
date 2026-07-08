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
  u = u.split('?')[0];           // remove query string (this catches the ?variant= case)
  u = u.replace(/\/$/, '');      // remove trailing slash
  u = u.replace(/en-au\//, '');  // remove language prefix
  return u;
}

function mergeAndDeduplicate(claude = [], grok = []) {
  const map = new Map();

  // Claude first (priority)
  claude.forEach(l => {
    const key = normalizeUrl(l.url);
    if (key) map.set(key, { ...l, source: 'claude' });
  });

  // Grok only if new or adds value
  grok.forEach(l => {
    const key = normalizeUrl(l.url);
    if (!key) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...l, source: 'grok' });
    } else if (!existing.image && l.image) {
      map.set(key, { ...existing, image: l.image, source: 'hybrid' });
    }
  });

  return Array.from(map.values());
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

    const claudePromise = runSearch(project, fb).catch(e => {
      console.error('Claude failed:', e.message);
      return [];
    });

    const grokPromise = runGrokSearch(project, fb).catch(e => {
      console.error('Grok failed:', e.message);
      return [];
    });

    [claudeListings, grokListings] = await Promise.all([claudePromise, grokPromise]);

    const listings = mergeAndDeduplicate(claudeListings, grokListings);

    console.log(`=== RUN STATS === Claude: ${claudeListings.length} | Grok: ${grokListings.length} | Final: ${listings.length}`);

    if (listings.length === 0) {
      return res.status(502).json({ error: 'No results from either provider.' });
    }

    await Promise.allSettled(
      listings.slice(0, 30).map(async (l) => {
        if (!l.image && l.url) l.image = await ogImage(l.url);
      })
    );

    const runId = uid();
    await sql`INSERT INTO runs (id, project_id, status, listing_count, notes) VALUES (${runId}, ${projectId}, 'complete', ${listings.length}, 'Hybrid run')`;

    for (const l of listings) {
      const badges = Array.isArray(l.badges) ? l.badges : [];
      await sql`INSERT INTO listings (id, project_id, run_id, section, title, description, price, price_num, currency, condition, seller, url, image, badges, source)
        VALUES (${uid()}, ${projectId}, ${runId}, ${l.section || 'Results'}, ${l.title || ''}, ${l.description || ''}, ${l.price || ''}, ${parsePriceNum(l.price)}, ${l.currency || 'USD'}, ${l.condition || ''}, ${l.seller || 'Other'}, ${l.url || ''}, ${l.image || ''}, ${JSON.stringify(badges)}::jsonb, ${l.source || 'unknown'})`;
    }

    await sql`UPDATE projects SET run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    const r = await sql`SELECT * FROM listings WHERE run_id = ${runId} ORDER BY section, created_at`;
    return res.status(200).json({ runId, count: listings.length, listings: r.rows });

  } catch (e) {
    console.error('Run handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
