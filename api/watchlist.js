import { sql, ensureSchema, readBody } from './_db.js';
import { requireAuth } from './_auth.js';

/* Server-side watchlist (persists across deploys & devices, unlike the old localStorage version).
 * GET    -> { items: [...] }          list saved parts, newest first
 * POST   { item, set }                set:true (default) upsert; set:false remove. Keyed by item.url.
 * DELETE { url }                      remove one. */

async function ensureWatch() {
  await sql`CREATE TABLE IF NOT EXISTS watchlist (url text PRIMARY KEY, item jsonb NOT NULL, saved_at timestamptz DEFAULT now())`;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;
    await ensureWatch();

    if (req.method === 'GET') {
      const { rows } = await sql`SELECT item FROM watchlist ORDER BY saved_at DESC`;
      return res.status(200).json({ items: rows.map((r) => r.item) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const item = body.item || {};
      const url = item.url;
      if (!url) return res.status(400).json({ error: 'item.url required' });
      if (body.set === false) {
        await sql`DELETE FROM watchlist WHERE url = ${url}`;
        return res.status(200).json({ saved: false });
      }
      await sql`INSERT INTO watchlist (url, item) VALUES (${url}, ${JSON.stringify(item)}::jsonb) ON CONFLICT (url) DO UPDATE SET item = EXCLUDED.item`;
      return res.status(200).json({ saved: true });
    }

    if (req.method === 'DELETE') {
      const body = await readBody(req);
      if (body.url) await sql`DELETE FROM watchlist WHERE url = ${body.url}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('watchlist error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
