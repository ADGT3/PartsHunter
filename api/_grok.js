/* Grok (xAI) — Reliable version */
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
      try { return JSON.parse(s.slice(0, end + 1) + (s[0] === '[' ? ']' : '}')); } catch {}
    }
    throw new Error('JSON parse failed');
  }
}

export async function runGrokSearch(project, feedback) {
  const cfg = project.config || {};
  const good = (feedback || []).filter(f => f.vote > 0).slice(0, 20);
  const bad = (feedback || []).filter(f => f.vote < 0).slice(0, 20);

  const prompt = `You are Parts Sniper. Find real parts currently for sale that match this goal.

PROJECT GOAL: ${project.goal}

CATEGORIES: ${(cfg.categories || []).join(', ')}

QUERIES: ${(cfg.queries || []).join('\n')}

RULES: ${(cfg.rules || []).join('\n')}

${good.length ? 'Prefer listings similar to these: ' + good.map(f => f.listing_url).join(', ') : ''}
${bad.length ? 'Avoid listings similar to these: ' + bad.map(f => f.listing_url).join(', ') : ''}

Search the web, browse pages, and return ONLY a JSON array of real current listings.
Each item must have: section, title, description, price, currency, condition, seller, url, image`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 16000,
      temperature: 0.5,
    });

    const content = completion.choices[0].message.content;
    return extractJson(content);
  } catch (error) {
    console.error('Grok error:', error.message);
    return []; // Return empty instead of crashing
  }
}
