import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
      const projectId = req.query.projectId;
      if (!projectId) return res.status(400).json({ error: 'projectId required' });
      const { rows } = await sql`SELECT listing_url, listing_title, seller, vote, reason FROM feedback WHERE project_id = ${projectId}`;
      return res.status(200).json({ feedback: rows });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const { projectId, url, title, seller, vote, reason } = body;
      if (!projectId || !url || ![1, -1, 0].includes(vote)) {
        return res.status(400).json({ error: 'projectId, url, and vote (1, -1, or 0) required' });
      }
      if (vote === 0) {
        await sql`DELETE FROM feedback WHERE project_id = ${projectId} AND listing_url = ${url}`;
        return res.status(200).json({ cleared: true });
      }
      await sql`INSERT INTO feedback (id, project_id, listing_url, listing_title, seller, vote, reason)
        VALUES (${uid()}, ${projectId}, ${url}, ${title || ''}, ${seller || ''}, ${vote}, ${reason || null})
        ON CONFLICT (project_id, listing_url)
        DO UPDATE SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, listing_title = EXCLUDED.listing_title, seller = EXCLUDED.seller, created_at = now()`;
      // A thumbs-down removes the listing from the accumulated set immediately.
      if (vote === -1) {
        await sql`DELETE FROM listings WHERE project_id = ${projectId} AND url = ${url}`;
      }
      return res.status(200).json({ saved: true });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
