/* Grok (xAI) - Improved image extraction + browser support */
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const MODEL = process.env.GROK_MODEL || 'grok-4.3';

function isPoorContent(text) {
  if (!text || text.startsWith('FETCH ERROR') || text.startsWith('BROWSER')) return true;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length < 800 || /loading|please enable javascript|enable js/i.test(clean);
}

async function extractImage(html) {
  let image = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
              html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

  if (!image) {
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const json = JSON.parse(jsonLdMatch[1]);
        if (json.image) image = Array.isArray(json.image) ? json.image[0] : json.image;
      } catch (e) {}
    }
  }

  if (!image) {
    const imgMatches = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi) || [];
    for (const img of imgMatches) {
      const src = img.match(/src=["']([^"']+)["']/)?.[1];
      if (src && !/logo|icon|sprite|placeholder|avatar|spinner/i.test(src) && src.length > 40) {
        image = src;
        break;
      }
    }
  }

  return image ? image.replace(/&amp;/g, '&') : '';
}

async function fetchPageText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'FETCH ERROR: invalid url';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 13000);
    const r = await fetch(url, {
      signal: c.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PartsSniperBot/1.0)' }
    });
    clearTimeout(t);
    if (!r.ok) return 'FETCH ERROR ' + r.status + ' for ' + url;

    const html = await r.text();
    const image = await extractImage(html);
    const ogLine = image ? '\nOG_IMAGE: ' + image : '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 12000) + ogLine;
  } catch (e) {
    return 'FETCH ERROR: ' + String(e.message || e);
  }
}

async function fetchPageWithBrowser(url) {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) return 'BROWSERLESS_API_KEY not set';

  try {
    const response = await fetch(`https://chrome.browserless.io/content?token=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 },
        waitFor: 2000
      })
    });

    if (!response.ok) return 'BROWSER FETCH ERROR: ' + response.status;

    const html = await response.text();
    const image = await extractImage(html);
    const ogLine = image ? '\nOG_IMAGE: ' + image : '';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 12000) + ogLine;
  } catch (e) {
    return 'BROWSER FETCH ERROR: ' + e.message;
  }
}

async function smartFetch(url) {
  const normal = await fetchPageText(url);
  if (isPoorContent(normal)) {
    console.log('Poor content, using browser for:', url);
    return await fetchPageWithBrowser(url);
  }
  return normal;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let s = fence ? fence[1] : text;
  const start = s.search(/\[|\{/);
  if (start === -1) throw new Error('No JSON found');
  s = s.slice(start).replace(/[\x00-\x1F]+/g, ' ').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (end > 0) {
      try { return JSON.parse(s.slice(0, end + 1)); } catch {}
    }
    throw new Error('JSON parse failed');
  }
}

export async function runGrokSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter(f => f.vote > 0).slice(0, 20);
  const bad = (feedback || []).filter(f => f.vote < 0).slice(0, 20);

  // Expand on the fly if config is empty
  let queries = cfg.queries || [];
  if (queries.length === 0) {
    queries = [
      project.goal,
      'salvage ' + project.goal,
      'Copart ' + project.goal,
      'IAAI ' + project.goal
    ];
  }

  const prompt = `You are Parts Sniper — expert at finding real parts and salvage vehicles for damaged cars.

Focus on salvage / auction vehicles from Copart, IAAI and similar when relevant.
Use browser rendering for JavaScript-heavy sites.

PROJECT GOAL: ${project.goal}

CATEGORIES: ${(cfg.categories || []).join(', ')}

QUERIES: ${queries.join('\n')}

RULES: ${(cfg.rules || []).join('\n')}

${good.length ? 'GOOD EXAMPLES: ' + good.map(f => f.listing_url).join(', ') : ''}
${bad.length ? 'AVOID: ' + bad.map(f => f.listing_url).join(', ') : ''}

Search aggressively and return ONLY a valid JSON array of current listings. Each listing needs section, title, description, price, currency, condition, seller, url, image.`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
      temperature: 0.5,
    });

    return extractJson(completion.choices[0].message.content);
  } catch (error) {
    console.error('Grok error:', error.message);
    return [];
  }
}
