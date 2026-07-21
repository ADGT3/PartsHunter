/* Shared country → domain constraint for the hunt engines (run.js + run-list.js)
 * and the frontend picker labels.
 *
 * "Source country" = where the part is SOLD FROM (the seller's own website domain),
 * NOT where it ships to. Selecting no countries means "all countries" (no constraint).
 *
 * Keep the codes here in sync with the frontend picker in /public/assets/app.js. */

export const COUNTRIES = [
  { code: 'gb', label: 'United Kingdom', name: 'the United Kingdom', tlds: ['.co.uk', '.uk'] },
  { code: 'ie', label: 'Ireland', name: 'Ireland', tlds: ['.ie'] },
  { code: 'in', label: 'India', name: 'India', tlds: ['.in'] },
  { code: 'jp', label: 'Japan', name: 'Japan', tlds: ['.jp', '.co.jp'] },
  { code: 'my', label: 'Malaysia', name: 'Malaysia', tlds: ['.com.my', '.my'] },
  { code: 'sg', label: 'Singapore', name: 'Singapore', tlds: ['.com.sg', '.sg'] },
  { code: 'au', label: 'Australia', name: 'Australia', tlds: ['.com.au', '.au'] },
  { code: 'nz', label: 'New Zealand', name: 'New Zealand', tlds: ['.co.nz', '.nz'] }
];

const BY_CODE = {};
for (const c of COUNTRIES) BY_CODE[c.code] = c;

// Location-text aliases so an unpriced source (URL-less) can still be matched
// against its reported "location" string when a country filter is active.
const ALIASES = {
  gb: ['united kingdom', 'uk', 'u.k', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  ie: ['ireland', 'eire', 'republic of ireland'],
  in: ['india'],
  jp: ['japan', 'nippon'],
  my: ['malaysia'],
  sg: ['singapore'],
  au: ['australia', 'aus'],
  nz: ['new zealand', 'nz', 'aotearoa']
};

/* Normalize the filters into a clean array of valid country codes.
 * Reads filters.countries (array, new shape) and falls back to the legacy
 * single filters.country string. Returns [] for "all countries" (no constraint). */
export function normCountries(filters) {
  if (!filters) return [];
  let raw = (filters.countries != null) ? filters.countries : filters.country;
  if (typeof raw === 'string') raw = [raw];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let v of raw) {
    v = String(v == null ? '' : v).toLowerCase().trim();
    if (!v || v === 'all') continue;
    if (BY_CODE[v] && out.indexOf(v) === -1) out.push(v);
  }
  return out;
}

// Flatten a set of country codes to their unique ccTLD suffixes.
export function tldsFor(codes) {
  const out = [];
  for (const code of codes || []) {
    const c = BY_CODE[code];
    if (!c) continue;
    for (const t of c.tlds) if (out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

// Does a URL's host sit on one of the selected countries' domains?
// No codes selected => no constraint => true.
export function hostInCountries(url, codes) {
  if (!codes || !codes.length) return true;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (e) { return false; }
  if (!host) return false;
  return tldsFor(codes).some((t) => host.endsWith(t));
}

// Fallback for URL-less sources: match a free-text location against the
// selected countries' names/aliases. No codes selected => true.
export function locationInCountries(loc, codes) {
  if (!codes || !codes.length) return true;
  const s = String(loc == null ? '' : loc).toLowerCase();
  if (!s) return false;
  return codes.some((code) => {
    const c = BY_CODE[code];
    if (!c) return false;
    if (s.indexOf(c.label.toLowerCase()) !== -1) return true;
    return (ALIASES[code] || []).some((a) => s.indexOf(a) !== -1);
  });
}

// Build the geography constraint sentence for the AI hunt prompt.
// Empty when no countries are selected.
export function countryConstraint(codes) {
  if (!codes || !codes.length) return '';
  const parts = codes.map((code) => {
    const c = BY_CODE[code];
    return c.name + ' (' + c.tlds.join(' / ') + ')';
  });
  const tlds = tldsFor(codes);
  return 'CONSTRAINT (source country): ONLY use sellers whose own website is on these country domains: ' +
    parts.join('; ') + '. Prefer site: queries scoped to those domains (' + tlds.join(', ') + '). ' +
    'This is about where the part is SOLD FROM (the seller\'s domain), not where it ships to. ' +
    'Ignore any seller on a different country\'s domain (e.g. .com, .de, .co.za) even if it stocks the part.';
}
