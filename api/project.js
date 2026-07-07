import { sql, ensureSchema, readBody } from './_db.js';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;

    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    if (req.method === 'GET') {
      const { rows: pr } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      if (!pr.length) return res.status(404).json({ error: 'not found' });
      const project = pr[0];
      const { rows: lastRun } = await sql`SELECT id, created_at FROM runs WHERE project_id = ${id} ORDER BY created_at DESC LIMIT 1`;
      let listings = [];
      if (lastRun.length) {
        const r = await sql`SELECT * FROM listings WHERE run_id = ${lastRun[0].id} ORDER BY section, created_at`;
        listings = r.rows;
      }
      const { rows: fb } = await sql`SELECT listing_url, vote FROM feedback WHERE project_id = ${id}`;
      const { rows: runs } = await sql`SELECT id, created_at, listing_count FROM runs WHERE project_id = ${id} ORDER BY created_at DESC LIMIT 20`;
      return res.status(200).json({
        project,
        lastRunAt: lastRun[0]?.created_at || null,
        listings,
        feedback: fb,
        runs
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const fields = [];
      if (body.name != null) { await sql`UPDATE projects SET name = ${String(body.name)} WHERE id = ${id}`; fields.push('name'); }
      if (body.goal != null) { await sql`UPDATE projects SET goal = ${String(body.goal)} WHERE id = ${id}`; fields.push('goal'); }
      if (body.schedule !== undefined) { await sql`UPDATE projects SET schedule = ${body.schedule || null} WHERE id = ${id}`; fields.push('schedule'); }
      if (body.config != null) {
        const cfg = typeof body.config === 'string' ? JSON.parse(body.config) : body.config;
        await sql`UPDATE projects SET config = ${JSON.stringify(cfg)}::jsonb WHERE id = ${id}`;
        fields.push('config');
      }
      const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      return res.status(200).json({ project: rows[0], updated: fields });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM projects WHERE id = ${id}`;
      return res.status(200).json({ deleted: true });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
