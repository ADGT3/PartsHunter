import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';
import { expandGoal } from './_anthropic.js';

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;

    const id = req.query?.id || (await readBody(req)).id;

    if (req.method === 'GET') {
      if (!id) return res.status(400).json({ error: 'id required' });

      const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ error: 'project not found' });

      let project = rows[0];
      let config = project.config || {};

      // If config is empty, expand it automatically and save it
      if (!config.queries || config.queries.length === 0) {
        try {
          const expanded = await expandGoal(project.goal);
          config = {
            categories: expanded.categories || [],
            queries: expanded.queries || [],
            rules: expanded.rules || []
          };

          await sql`UPDATE projects SET config = ${JSON.stringify(config)}::jsonb WHERE id = ${id}`;
          project.config = config;
          console.log('Auto-expanded config for project', id);
        } catch (e) {
          console.error('Auto-expand failed:', e.message);
        }
      }

      // Also load listings + feedback
      const { rows: listings } = await sql`
        SELECT * FROM listings 
        WHERE project_id = ${id} 
        ORDER BY section, created_at DESC
      `;
      const { rows: feedback } = await sql`
        SELECT * FROM feedback WHERE project_id = ${id}
      `;

      return res.status(200).json({
        project,
        listings,
        feedback
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!id) return res.status(400).json({ error: 'id required' });

      if (body.config) {
        await sql`UPDATE projects SET config = ${JSON.stringify(body.config)}::jsonb WHERE id = ${id}`;
      }
      if (body.name) {
        await sql`UPDATE projects SET name = ${body.name} WHERE id = ${id}`;
      }
      if (body.goal) {
        await sql`UPDATE projects SET goal = ${body.goal} WHERE id = ${id}`;
      }

      const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      return res.status(200).json({ project: rows[0] });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('project handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
