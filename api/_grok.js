/* Grok (xAI) - Strict real listings only */
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const MODEL = process.env.GROK_MODEL || 'grok-4.3';

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

  const prompt = `You are Parts Sniper. Your job is to find REAL current listings for sale.

CRITICAL RULES:
- NEVER invent or fabricate listings.
- ONLY return listings with real, working URLs that currently exist.
- If you cannot find real salvage/auction listings, return fewer results or none.
- Prefer real Copart, IAAI, eBay, Parts4USA, etc. links that you actually know exist.
- Do not create fake "IAAI equivalent" or made-up pages.

PROJECT GOAL: ${project.goal}

CATEGORIES: ${(cfg.categories || []).join(', ')}

QUERIES: ${(cfg.queries || []).join('\n')}

RULES: ${(cfg.rules || []).join('\n')}

${good.length ? 'GOOD EXAMPLES (find similar real listings): ' + good.map(f => f.listing_url).join(', ') : ''}
${bad.length ? 'AVOID: ' + bad.map(f => f.listing_url).join(', ') : ''}

Return ONLY a valid JSON array of real current listings. Each item must have a real working "url". If you have no real results for a section, omit it.`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
      temperature: 0.3,   // lower temperature to reduce invention
    });

    const content = completion.choices[0].message.content;
    const arr = extractJson(content);

    // Extra safety: filter out obviously fake URLs
    return (arr || []).filter(l => {
      if (!l.url || typeof l.url !== 'string') return false;
      if (l.url.includes('example.com') || l.url.includes('fake') || l.url.includes('placeholder')) return false;
      if (!l.url.startsWith('http')) return false;
      return true;
    });
  } catch (error) {
    console.error('Grok error:', error.message);
    return [];
  }
}
