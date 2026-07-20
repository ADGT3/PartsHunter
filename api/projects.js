import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';
import { expandGoal } from './_anthropic.js';

export default async function handler(req, res) {
  console.log('=== /api/projects called === Method:', req.method);

  try {
    await ensureSchema();
    console.log('Schema ensured OK');

    if (!requireAuth(req, res)) {
      console.log('Auth failed');
      return;
    }

    if (req.method === 'GET') {
      const { rows } = await sql`SELECT * FROM projects ORDER BY created_at DESC`;
      console.log('GET projects success, count:', rows.length);
      return res.status(200).json({ projects: rows });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      console.log('POST body:', body);
      const { name, goal, filters } = body;
      if (!name || !goal) return res.status(400).json({ error: 'name and goal required' });

      let config = { categories: [], queries: [], rules: [] };
      try {
        config = await expandGoal(goal);
        console.log('Config expanded OK');
      } catch (e) {
        console.error('Config expansion failed (using empty):', e.message);
      }

      config.filters = filters || { oem_new: false, oem_used: false, aftermarket: false, salvage: false, country: 'all' };

      const projectId = uid();
      await sql`INSERT INTO projects (id, name, goal, config) VALUES (${projectId}, ${name}, ${goal}, ${JSON.stringify(config)}::jsonb)`;

      const { rows } = await sql`SELECT * FROM projects WHERE id = ${projectId}`;
      console.log('Project created OK');
      return res.status(201).json({ project: rows[0] });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('=== /api/projects ERROR ===', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
