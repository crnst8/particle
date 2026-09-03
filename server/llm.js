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

/**
 * Direct the narration of one article: which catalogue voice reads it, how fast,
 * how expressively, what the spoken opening line is, and how to say the handful
 * of names and terms a text-to-speech model would otherwise mangle.
 * Returns null-ish fields freely; the caller validates and falls back.
 */
export async function directNarration({ article, language, profile, minutes, candidates }) {
  const text = article.text_content || '';
  const opening = text.slice(0, 1100);
  const middle = text.length > 3000 ? text.slice(Math.floor(text.length / 2), Math.floor(text.length / 2) + 500) : '';
  const roster = candidates.map(v => `- ${v.id} | ${v.title} | ${v.tags}${v.description ? ` | ${v.description}` : ''}`).join('\n');

  const reply = await chat([
    {
      role: 'system',
      content: 'You cast and direct audiobook narrators. You are given one article and a roster of real voices. '
        + 'Pick the voice a thoughtful audio editor would choose for this specific piece, and direct its delivery. '
        + 'Respond with strict JSON, nothing else.',
    },
    {
      role: 'user',
      content: `Article to narrate:
Title: ${article.title}
Byline: ${article.byline || 'unknown'}
Site: ${article.site_name || 'unknown'}
Topic tags: ${(article.tags || []).join(', ') || 'none'}
Language: ${language}
Length: ${article.word_count} words, about ${minutes} minutes read
Heuristic tone guess: ${profile}

Opening:
${opening}
${middle ? `\nFrom the middle:\n${middle}` : ''}

Voice roster (id | name | tags | description):
${roster || '(none available — leave voice_id null)'}

Decide:
1. voice_id: the id of the best voice on that roster for this piece, verbatim. Match register to content: reportage wants clarity and authority, personal essays want warmth, technical pieces want an even, unhurried teacher. Never pick a character or performance voice for serious writing.
2. tone: two or three lowercase words describing the delivery you want (e.g. "calm, measured").
3. speed: 0.85-1.15. Dense or technical prose reads slower; brisk news reads slightly faster.
4. temperature: 0.4-0.9. Lower is steadier and more neutral, higher is more expressive.
5. intro: one short spoken line to open the audio, in ${language}. Name the publication, the title and the author naturally, as a radio host would, and say roughly how long it runs. No markup, no quotation marks around the title, under 200 characters.
6. pronunciations: up to 8 replacements for words this article uses that a text-to-speech model would say wrongly — acronyms that must be spelled out, foreign or unusual proper nouns, product names, units. Each is {"find": "<exact text as written>", "say": "<phonetic respelling in plain letters>"}. Only include genuinely risky ones; an empty list is a fine answer.
7. reason: one short sentence on why this casting suits the article.

Reply with JSON only:
{"voice_id":"...","tone":"...","speed":1.0,"temperature":0.7,"intro":"...","pronunciations":[{"find":"...","say":"..."}],"reason":"..."}`,
    },
    // A reasoning model spends most of its budget before the first character of
    // JSON appears. Under-budget it and every casting silently falls back to the
    // heuristic, which is what made one voice read the whole library.
  ], { maxTokens: 2500 });

  const parsed = parseJsonLoose(reply);
  return {
    voice_id: typeof parsed.voice_id === 'string' ? parsed.voice_id.trim() : null,
    tone: parsed.tone,
    speed: Number(parsed.speed),
    temperature: Number(parsed.temperature),
    intro: parsed.intro,
    pronunciations: parsed.pronunciations,
    reason: parsed.reason,
  };
}
