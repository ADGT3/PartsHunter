import { sql, ensureSchema, readBody, uid } from './_db.js';
import { requireAuth } from './_auth.js';

/* Create a "parts-list" project from an uploaded/parsed estimate.
 * POST { name, currency, sources:{oem_new,oem_used,aftermarket,salvage}, lines:[{desc,pn,qty,est}] }
 * Stores everything in the project's config jsonb (kind: 'list'). */

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (!requireAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const body = await readBody(req);
    const name = (body.name || 'Parts list').toString().slice(0, 200);
    const currency = (body.currency || 'AUD').toString().toUpperCase().slice(0, 6);
    const s = body.sources || body.filters || {};
    const filters = { oem_new: !!(s.oem_new || s.oem), oem_used: !!(s.oem_used || s.oem), aftermarket: !!s.aftermarket, salvage: !!s.salvage };
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length) return res.status(400).json({ error: 'No parts lines provided.' });

    const partsList = lines.slice(0, 500).map((l, i) => ({
      id: 'L' + (i + 1),
      desc: (l.desc || '').toString().slice(0, 300),
      pn: (l.pn || '').toString().slice(0, 80),
      cat: (l.cat || '').toString().slice(0, 40) || null,
      qty: (l.qty == null || l.qty === '' || isNaN(Number(l.qty))) ? null : Number(l.qty),
      est: (l.est == null || l.est === '' || isNaN(Number(l.est))) ? null : Number(l.est)
    })).filter((l) => l.desc || l.pn);

    const id = uid();
    const goal = 'Parts-list hunt — ' + partsList.length + ' lines';
    const config = { kind: 'list', currency, filters, partsList, results: null, totals: null };

    await sql`INSERT INTO projects (id, name, goal, config) VALUES (${id}, ${name}, ${goal}, ${JSON.stringify(config)}::jsonb)`;
    return res.status(200).json({ project: { id, name, goal, config } });
  } catch (e) {
    console.error('list-create error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
