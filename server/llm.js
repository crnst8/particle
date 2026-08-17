// Optional OpenAI-compatible helper. It reads excerpts from the article and
// returns metadata only (quality verdict + tags); article text is never rewritten.
const API = process.env.LLM_API_URL || process.env.OPENCODE_API || 'https://opencode.ai/zen/go/v1/chat/completions';
const KEY = process.env.LLM_API_KEY || process.env.OPENCODE_KEY || '';
const MODEL = process.env.LLM_MODEL || process.env.OPENCODE_MODEL || 'deepseek-v4-flash';

export const isLlmConfigured = Boolean(KEY);

async function chat(messages, { maxTokens = 300 } = {}) {
  if (!KEY) throw new Error('LLM_API_KEY not set');
  const res = await fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(45000),
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseJsonLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in LLM reply');
  return JSON.parse(m[0]);
}

/**
 * Ask the LLM whether the extraction looks like the complete article and for 1-3
 * topic tags. Returns { quality: 'full'|'partial'|'stub', note, tags: [] }.
 */
export async function assessArticle({ title, byline, site_name, word_count, text_content }) {
  const head = text_content.slice(0, 2500);
  const tail = text_content.length > 5000 ? text_content.slice(-1500) : '';
  // generous cap: reasoning models spend tokens thinking before the JSON appears
  const reply = await chat([
    {
      role: 'system',
      content: 'You review web article extractions for a read-later app. Judge only completeness and topic. Respond with strict JSON, nothing else.',
    },
    {
      role: 'user',
      content: `Article extraction to review:
Title: ${title}
Byline: ${byline || 'unknown'}
Site: ${site_name || 'unknown'}
Word count: ${word_count}

Beginning of text:
${head}
${tail ? `\nEnd of text:\n${tail}` : ''}

Questions:
1. quality: "full" if this reads as a complete article; "partial" if it appears truncated or cut off mid-flow (e.g. ends abruptly, paywall interruption); "stub" if it is mostly a teaser, paywall notice, cookie/consent text, or navigation junk.
2. note: one short sentence explaining the verdict (empty string if full).
3. tags: 1 to 3 lowercase topic tags for organizing a personal reading library (e.g. "film", "politics", "ai"). Prefer single words.

Reply with JSON only: {"quality": "...", "note": "...", "tags": ["..."]}`,
    },
  ], { maxTokens: 2000 });
  const parsed = parseJsonLoose(reply);
  const quality = ['full', 'partial', 'stub'].includes(parsed.quality) ? parsed.quality : 'full';
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.slice(0, 3).map(t => String(t).toLowerCase().trim()).filter(Boolean)
    : [];
  return { quality, note: String(parsed.note || ''), tags };
}
