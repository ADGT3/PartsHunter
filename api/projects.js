import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';
import { expandGoal } from './_anthropic.js';

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT p.*,
          (SELECT COUNT(*)::int FROM listings l
             WHERE l.project_id = p.id
               AND l.run_id = (SELECT id FROM runs r WHERE r.project_id = p.id ORDER BY created_at DESC LIMIT 1)
          ) AS listing_count
        FROM projects p ORDER BY created_at ASC`;
      return res.status(200).json({ projects: rows });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const goal = (body.goal || '').trim();
      if (!name || !goal) return res.status(400).json({ error: 'name and goal are required' });

      let config;
      try {
        config = await expandGoal(goal);
      } catch (e) {
        // Fall back to a minimal editable config if the AI expansion fails.
        config = {
          categories: ['Results'],
          queries: [goal],
          rules: ['Genuine/OEM preferred', 'Specific product pages only', 'Skip sold/ended listings', 'Drop irrelevant results']
        };
      }
      const id = uid();
      await sql`INSERT INTO projects (id, name, goal, config) VALUES (${id}, ${name}, ${goal}, ${JSON.stringify(config)}::jsonb)`;
      const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      return res.status(201).json({ project: rows[0] });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
