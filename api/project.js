import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';
import { expandGoal } from './_anthropic.js';

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;

    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id') || (req.query && req.query.id);

    if (req.method === 'GET') {
      if (!id) return res.status(400).json({ error: 'id required' });

      const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ error: 'project not found' });

      let project = rows[0];
      let config = project.config || {};

      if ((!config.queries || config.queries.length === 0) && project.goal && config.kind !== 'list') {
        try {
          const expanded = await expandGoal(project.goal);
          config = {
            ...config,
            categories: Array.isArray(expanded.categories) ? expanded.categories : [],
            queries: Array.isArray(expanded.queries) ? expanded.queries : [],
            rules: Array.isArray(expanded.rules) ? expanded.rules : []
          };
          await sql`UPDATE projects SET config = ${JSON.stringify(config)}::jsonb WHERE id = ${id}`;
          project.config = config;
        } catch (e) {
          console.error('Auto-expand failed (continuing):', e.message);
        }
      }

      const { rows: listings } = await sql`SELECT * FROM listings WHERE project_id = ${id} ORDER BY section, created_at DESC`;
      const { rows: feedback } = await sql`SELECT * FROM feedback WHERE project_id = ${id}`;

      return res.status(200).json({ project, listings: listings || [], feedback: feedback || [] });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!id) return res.status(400).json({ error: 'id required' });

      if (body.name) await sql`UPDATE projects SET name = ${body.name} WHERE id = ${id}`;
      if (body.goal) await sql`UPDATE projects SET goal = ${body.goal} WHERE id = ${id}`;

      // Re-draft: regenerate queries/rules/categories from the (possibly edited) goal,
      // preserving the project's filters. Used by "Edit search" (Set your target).
      let config = body.config || null;
      if (body.reexpand && body.goal) {
        try {
          const ex = await expandGoal(body.goal);
          const { rows: cur } = await sql`SELECT config FROM projects WHERE id = ${id}`;
          const prev = (cur[0] && cur[0].config) || {};
          config = {
            ...prev,
            categories: Array.isArray(ex.categories) ? ex.categories : (prev.categories || []),
            queries: Array.isArray(ex.queries) ? ex.queries : (prev.queries || []),
            rules: Array.isArray(ex.rules) ? ex.rules : (prev.rules || []),
            filters: (body.config && body.config.filters) || prev.filters || {}
          };
        } catch (e) {
          console.error('re-expand failed:', e.message);
        }
      }

      if (config) await sql`UPDATE projects SET config = ${JSON.stringify(config)}::jsonb WHERE id = ${id}`;

      const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
      return res.status(200).json({ project: rows[0] });
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('project handler error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
