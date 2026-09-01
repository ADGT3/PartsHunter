/* Grok (xAI) — optional second pass. Off by default to avoid extra API spend.
 * Enable with GROK_ENABLED=1. This path does NOT run web search (that would
 * duplicate Claude's billed searches). */
import OpenAI from 'openai';
import { normalizeListing } from './_anthropic.js';

const MODEL = process.env.GROK_MODEL || 'grok-4.3';

export function grokEnabled() {
  const v = String(process.env.GROK_ENABLED || '').toLowerCase();
  return v === '1' || v === 'true';
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
  if (!grokEnabled()) {
    console.log('Grok skipped (set GROK_ENABLED=1 to turn on; no web search either way)');
    return [];
  }
  if (!process.env.XAI_API_KEY) {
    console.log('Grok skipped: XAI_API_KEY not set');
    return [];
  }

  const client = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
  });

  const cfg = project.config || {};
  const good = (feedback || []).filter(f => f.vote > 0).slice(0, 20);
  const bad = (feedback || []).filter(f => f.vote < 0).slice(0, 20);

  const prompt = `You are Parts Sniper. Return REAL current listings you are confident exist.

CRITICAL RULES:
- NEVER invent URLs, prices, or lot numbers.
- ONLY return listings with real https detail-page URLs.
- If you are not sure a URL exists right now, omit it.
- Prefer fewer real rows over many guesses.

PROJECT GOAL: ${project.goal}

CATEGORIES: ${(cfg.categories || []).join(', ')}

QUERIES: ${(cfg.queries || []).join('\n')}

RULES: ${(cfg.rules || []).join('\n')}

${good.length ? 'GOOD EXAMPLES (find similar real listings): ' + good.map(f => f.listing_url).join(', ') : ''}
${bad.length ? 'AVOID: ' + bad.map(f => f.listing_url).join(', ') : ''}

Each listing must use keys: section, title, description, price, currency, condition, seller, url, image, badges.
"section" MUST be EXACTLY one of the CATEGORIES above.

Return ONLY a valid JSON array. Empty array is allowed.`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.2,
    });

    const content = completion.choices[0].message.content;
    const arr = extractJson(content);
    return (arr || []).map(normalizeListing).filter(l => {
      if (!l || !l.url) return false;
      if (l.url.includes('example.com') || l.url.includes('fake') || l.url.includes('placeholder')) return false;
      if (!l.url.startsWith('http')) return false;
      return true;
    });
  } catch (error) {
    console.error('Grok error:', error.message);
    return [];
  }
}
