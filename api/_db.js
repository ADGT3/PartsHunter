import { sql } from '@vercel/postgres';

export { sql };

/* ---------- small shared utils ---------- */
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

/* ---------- schema ---------- */
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

/* ---------- seed: migrate the 992 GT3 RS as project #1 ---------- */
async function seedIfEmpty() {
  const { rows } = await sql`SELECT COUNT(*)::int AS n FROM projects`;
  if (rows[0].n > 0) return;

  const projectId = uid();
  const config = {
    categories: ['Front End', 'Interior', 'Left-Front Suspension'],
    queries: [
      'Porsche 992 GT3 RS front bumper OEM for sale',
      'Porsche 992 GT3 RS carbon fender hood headlight OEM',
      'Porsche 992 GT3 RS carbon sports seats red stitching for sale',
      'Porsche 992 GT3 RS front control arm OEM',
      'site:parts4usa.com 992 GT3 RS',
      '992 GT3 RS OEM part front end package',
      '992 GT3 carbon bucket seats complete pair for sale'
    ],
    rules: [
      'Genuine OEM parts only (flag aftermarket clearly if that is all that exists).',
      'Seat requirement = COMPLETE seat assemblies only — exclude inserts, cushions, covers, foam, and brackets.',
      'Interior parts must flag red-stitching match.',
      'Specific product/item pages only — no generic collection/category/search pages.',
      'Skip anything sold, ended, expired, or out of stock; re-verify carry-overs each run.',
      'Drop weak or off-target results rather than padding the list.'
    ]
  };
  await sql`INSERT INTO projects (id, name, goal, config, schedule)
    VALUES (${projectId}, ${'Porsche 992 GT3 RS — Front-End Rebuild'},
            ${'Find OEM Porsche 992 GT3 RS parts for a front-end collision rebuild: full front end, airbag-affected interior with red stitching (complete carbon sports seats, not inserts), and left-front suspension.'},
            ${JSON.stringify(config)}::jsonb, ${'0 8 * * 5'})`;

  const runId = uid();
  const seed = [
    ['Front End','OEM Front Bumper Cover','Genuine 992 GT3 front bumper cover. Part No. 9GT807683A0K1.','$4,500','USD','New','Parts4USA','https://parts4usa.com/products/porsche-992-gt3-front-bumper-and-hood-oem-part','https://parts4usa.com/cdn/shop/products/porsche-992-gt3-front-bumper-and-hood-oem-part-743.jpg?v=1665831797&width=1024',['OEM','New']],
    ['Front End','Front Bumper & Hood Set','Combined OEM front bumper and hood package.','$18,999','USD','New','Parts4USA','https://parts4usa.com/products/porsche-992-gt3-front-bumper-and-hood-oem-part','https://parts4usa.com/cdn/shop/products/porsche-992-gt3-front-bumper-and-hood-oem-part-268.jpg?v=1665831801&width=1024',['OEM','New']],
    ['Front End','OEM Front-End Package (Hood + Fenders + Headlights)','Carbon hood (9GT823031), carbon fenders L+R (9GT821017J/018J), headlights L+R (9P5941059D/060D). No bumper.','$49,000','USD','New','Parts4USA','https://parts4usa.com/en-au/products/porsche-992-gt3-rs-oem-part?variant=54740786806952','https://parts4usa.com/cdn/shop/files/PorscheGT3RS01.jpg?v=1764854175&width=1024',['OEM','New']],
    ['Front End','Carbon Fenders + Front Hood','GT2RS/GT3RS carbon front fenders (L+R) and front hood, genuine OEM.','Enquire','USD','New','Parts4USA','https://parts4usa.com/products/porsche-gt2rs-gt3rs-fenders-and-front-hood-carbon-oem-part','https://parts4usa.com/cdn/shop/products/IMG_38602.jpg?v=1681806575&width=1024',['OEM','New']],
    ['Front End','OEM Headlight Assembly (992-941-681-H)','Genuine 911/992 headlamp assembly. Confirm matrix/non-matrix.','Dealer','USD','New','Porsche Chandler Parts','https://parts.porschechandler.com/oem-parts/porsche-headlamp-assembly-992941681h','https://cdn-illustrations.revolutionparts.io/strapr1/44ce1ac2b03905a1967b84d56825297c/7dccbb84e2ca24aede9ca4b6b5f42ca2.png',['OEM','New']],
    ['Front End','LED Headlamp (992-941-078-K)','Genuine LED headlight for 2020–2025 911 incl. GT3/GT3 RS (non-matrix).','Dealer','USD','New','Gaudin Porsche Parts','https://gaudinporscheparts.com/oem-parts/porsche-headlamp-assembly-992941078h','https://cdn-illustrations.revolutionparts.io/strapr1/f24740f3b35eb3ff11173a802853b212/2369d991d2d59d1848cc6288e0459364.png',['OEM','New']],
    ['Front End','992 GT3 / GT3 RS Headlights','Listed as fitting 2018–2026 992 GT3/GT3 RS. Verify OEM vs custom.','Enquire','USD','New','Legends Auto Parts','https://legendsautoparts.com/products/2018-2025-porsche-992-turbo-s-gt3-gt3rs-custom-oem-headlights','',['New','Verify OEM']],
    ['Front End','Hood Vent Top Covers','992 GT3 RS hood vent top covers (covers only).','Enquire','USD','New','Legends Auto Parts','https://legendsautoparts.com/products/porsche-992-gt3-rs-hood-vents-top-covers-only','',['New']],
    ['Interior','Complete OEM Carbon Bucket Seat (99152190001KPL)','Genuine OEM carbon fibre full bucket seat — complete seat, L+R. Same 918/LWB seat used across 991/992 GT3 RS.','$24,999','USD','Used','Parts4USA','https://parts4usa.com/products/porsche-gt3rs-991-2-carbon-fiber-seat-oem-part-99152190001kpl','https://parts4usa.com/cdn/shop/files/porsche-gt3rs-991-2-carbon-fiber-seat-oem-part-99152190001kpl-243.jpg?v=1685465894&width=1024',['OEM','Complete seat']],
    ['Interior','Carbon LW Bucket Seats — Red Stitch','OEM carbon lightweight bucket seats, black with red stitching (GT3/GT4). Forum sale — verify 992 fitment.','See listing','USD','Used','Rennlist Marketplace','https://rennlist.com/forums/market/1363938','',['OEM','Red stitch','Complete seat']],
    ['Interior','992.2 Carbon Bucket Seats','Complete carbon bucket seats for 992.2 GT3 Touring — custom finish, optional integrated side airbags & red stitching.','Enquire','USD','New','Forza (Forzaaa)','https://forzaaa.com/products/carbon-bucket-seats-for-porsche-911-992-2-gt3-touring','https://forzaaa.com/cdn/shop/files/carbon-bucket-seats-lwcb-for-porsche-911-9922-gt3-touring.jpg?v=1746598033',['Made-to-order','Red stitch opt.','Complete seat']],
    ['Left-Front Suspension','OEM Front Control Arm Shims','Genuine front control-arm/camber shims for 2021+ 992 GT3 front suspension.','See listing','USD','New','Suncoast Parts','https://www.suncoastparts.com/product/992gt3shims.html','https://www.suncoastparts.com/mm5/graphics/00000002/10/992%20gt3%20porsche%20control%20arm%20spacer%20shim%20adjustment%20camber.jpg',['OEM','New']],
    ['Left-Front Suspension','992 Front Lower Control Arms','Cup-series-derived front control arms re-engineered for 992. Aftermarket.','Enquire','USD','New','Tarett Engineering','https://tarett.com/collections/control-arms-996','https://tarett.com/cdn/shop/products/proseries_medium.jpg?v=1627249444',['Aftermarket','New']],
    ['Left-Front Suspension','RSS Tarmac Front Lower Arm Kit','RSS Tarmac-series front lower control arm kit (pair). Aftermarket.','Enquire','USD','New','Shark Werks','https://www.sharkwerks.com/c_suspension-f_gt3-rs-r','https://imagedelivery.net/oJimWy5TEkIAkWQ2oqxxOw/f95cc780-b9b1-49bc-3154-324e2e456300/w=2880,h=1585',['Aftermarket','New']]
  ];
  await sql`INSERT INTO runs (id, project_id, status, listing_count, notes) VALUES (${runId}, ${projectId}, 'complete', ${seed.length}, 'Seed migration')`;
  for (const r of seed) {
    const [section,title,description,price,currency,condition,seller,url,image,badges] = r;
    await sql`INSERT INTO listings (id, project_id, run_id, section, title, description, price, price_num, currency, condition, seller, url, image, badges)
      VALUES (${uid()}, ${projectId}, ${runId}, ${section}, ${title}, ${description}, ${price}, ${parsePriceNum(price)}, ${currency}, ${condition}, ${seller}, ${url}, ${image}, ${JSON.stringify(badges)}::jsonb)`;
  }
  await sql`UPDATE projects SET run_count = 1, last_run_at = now() WHERE id = ${projectId}`;
}
