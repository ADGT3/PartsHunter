import { sql, ensureSchema } from './_db.js';
import { requireAuth } from './_auth.js';

/* GET /api/list?id=... -> the parts-list project (partsList, results, totals). */

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;
    const id = (req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id required' });
    const { rows } = await sql`SELECT id, name, goal, config, run_count, last_run_at FROM projects WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'project not found' });
    const p = rows[0];
    const cfg = p.config || {};
    return res.status(200).json({
      project: { id: p.id, name: p.name, goal: p.goal, run_count: p.run_count, last_run_at: p.last_run_at },
      currency: cfg.currency || 'AUD',
      partsList: cfg.partsList || [],
      results: cfg.results || null,
      totals: cfg.totals || null
    });
  } catch (e) {
    console.error('list get error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
