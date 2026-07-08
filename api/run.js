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
  return url ? url.replace(/https?:\/\//i, '').replace(/^www\./i, '').split('?')[0].toLowerCase().trim() : '';
}

function mergeAndDeduplicate(claude = [], grok = []) {
  const map = new Map();
  [...claude, ...grok].forEach(l => {
    const key = normalizeUrl(l.url);
    if (!key) return;
    const current = map.get(key);
    if (!current || (!current.image && l.image) || (!current.price && l.price)) {
      map.set(key, l);
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

    // Hybrid with graceful fallback
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

    if (listings.length === 0) {
      return res.status(502).json({ error: 'Both search providers returned no results.' });
    }

    // Image enrichment
    await Promise.allSettled(listings.slice(0, 30).map(async (l) => {
      if (!l.image && l.url) l.image = await ogImage(l.url);
    }));

    const runId = uid();
    await sql`INSERT INTO runs (id, project_id, status, listing_count, notes) VALUES (${runId}, ${projectId}, 'complete', ${listings.length}, 'Hybrid Claude + Grok')`;

    for (const l of listings) {
      const badges = Array.isArray(l.badges) ? l.badges : [];
      await sql`INSERT INTO listings (id, project_id, run_id, section, title, description, price, price_num, currency, condition, seller, url, image, badges)
        VALUES (${uid()}, ${projectId}, ${runId}, ${l.section || 'Results'}, ${l.title || ''}, ${l.description || ''}, ${l.price || ''}, ${parsePriceNum(l.price)}, ${l.currency || 'USD'}, ${l.condition || ''}, ${l.seller || 'Other'}, ${l.url || ''}, ${l.image || ''}, ${JSON.stringify(badges)}::jsonb)`;
    }

    await sql`UPDATE projects SET run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    const r = await sql`SELECT * FROM listings WHERE run_id = ${runId} ORDER BY section, created_at`;
    return res.status(200).json({ runId, count: listings.length, listings: r.rows });

  } catch (e) {
    console.error('Run handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
