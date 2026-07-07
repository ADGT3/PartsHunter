import { sql, ensureSchema, readBody, uid, parsePriceNum } from './_db.js';
import { requireAuth } from './_auth.js';
import { runSearch } from './_anthropic.js';

const CAP = Number(process.env.RUN_CAP_PER_DAY || 20);

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

    // cost guard: cap runs per rolling 24h per project
    const { rows: cnt } = await sql`SELECT COUNT(*)::int AS n FROM runs WHERE project_id = ${projectId} AND created_at > now() - interval '24 hours'`;
    if (cnt[0].n >= CAP) {
      return res.status(429).json({ error: `Daily run cap (${CAP}) reached for this project. Try again later or raise RUN_CAP_PER_DAY.` });
    }

    const { rows: fb } = await sql`SELECT listing_url, listing_title, seller, vote, reason FROM feedback WHERE project_id = ${projectId}`;

    let listings;
    try {
      listings = await runSearch(project, fb);
    } catch (e) {
      return res.status(502).json({ error: 'Search failed: ' + String(e.message || e) });
    }

    const runId = uid();
    await sql`INSERT INTO runs (id, project_id, status, listing_count, notes) VALUES (${runId}, ${projectId}, 'complete', ${listings.length}, 'On-demand run')`;
    for (const l of listings) {
      const badges = Array.isArray(l.badges) ? l.badges : [];
      await sql`INSERT INTO listings (id, project_id, run_id, section, title, description, price, price_num, currency, condition, seller, url, image, badges)
        VALUES (${uid()}, ${projectId}, ${runId}, ${l.section || 'Results'}, ${l.title || ''}, ${l.description || ''}, ${l.price || ''}, ${parsePriceNum(l.price)}, ${l.currency || 'USD'}, ${l.condition || ''}, ${l.seller || 'Other'}, ${l.url || ''}, ${l.image || ''}, ${JSON.stringify(badges)}::jsonb)`;
    }
    await sql`UPDATE projects SET run_count = run_count + 1, last_run_at = now() WHERE id = ${projectId}`;

    const r = await sql`SELECT * FROM listings WHERE run_id = ${runId} ORDER BY section, created_at`;
    return res.status(200).json({ runId, count: listings.length, listings: r.rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
