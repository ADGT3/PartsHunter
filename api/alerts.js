import { sql, ensureSchema } from './_db.js';
import { requireAuth } from './_auth.js';

/* Alerts feed.
 *  GET                      -> { newMatches: [...] }  listings added recently across all hunts
 *  POST { urls: [...] }     -> { current: { url: { price, price_num, present } } }
 *                              used by the client to detect price drops / ended listings on
 *                              watchlisted parts (the watchlist itself lives in the browser). */

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } });
  });
}

const HOURS = Number(process.env.ALERTS_WINDOW_HOURS || 72);

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT l.title, l.url, l.price, l.price_num, l.seller, l.source, l.section, l.image,
               l.created_at, l.project_id, p.name AS project_name
        FROM listings l JOIN projects p ON p.id = l.project_id
        WHERE l.created_at > now() - make_interval(hours => ${HOURS})
        ORDER BY l.created_at DESC
        LIMIT 60`;
      return res.status(200).json({ newMatches: rows, windowHours: HOURS });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const urls = Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === 'string').slice(0, 200) : [];
      if (!urls.length) return res.status(200).json({ current: {} });
      const { rows } = await sql`SELECT url, price, price_num FROM listings WHERE url = ANY(${urls})`;
      const current = {};
      for (const r of rows) current[r.url] = { price: r.price, price_num: r.price_num, present: true };
      return res.status(200).json({ current });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('alerts error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
