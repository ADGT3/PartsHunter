import { sql } from '@vercel/postgres';

export { sql };

export const uid = () => (globalThis.crypto?.randomUUID?.() || ('id' + Date.now() + Math.random().toString(16).slice(2)));

export function parsePriceNum(str) {
  if (str == null) return null;
  const m = String(str).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

export async function readBody(req) {
  if (req.body != null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    return req.body;
  }
  return await new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

let inited = false;
export async function ensureSchema() {
  if (inited) return;
  await sql`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    schedule TEXT,
    run_count INT NOT NULL DEFAULT 0,
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'complete',
    listing_count INT NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    section TEXT, title TEXT, description TEXT,
    price TEXT, price_num NUMERIC, currency TEXT,
    condition TEXT, seller TEXT, url TEXT, image TEXT,
    badges JSONB DEFAULT '[]'::jsonb,
    source TEXT DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    listing_url TEXT NOT NULL,
    listing_title TEXT, seller TEXT,
    vote INT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, listing_url)
  )`;
  inited = true;
  await seedIfEmpty();
}

async function seedIfEmpty() {
  const { rows } = await sql`SELECT COUNT(*)::int AS n FROM projects`;
  if (rows[0].n > 0) return;

  // ... your existing seed code (keep it as is)
}
