// Optional OpenAI-compatible helper. It reads excerpts from the article and
// returns metadata only (quality verdict + tags); article text is never rewritten.
const API = process.env.LLM_API_URL || process.env.OPENCODE_API || 'https://opencode.ai/zen/go/v1/chat/completions';
const KEY = process.env.LLM_API_KEY || process.env.OPENCODE_KEY || '';
const MODEL = process.env.LLM_MODEL || process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
/* The tagging model is text-only, so reading a picture needs a second name.
   Kept separate rather than inferred: a lineup changes under you, and a
   text-only model handed an image fails by describing nothing rather than
   by erroring. */
const VISION_MODEL = process.env.SCREENSHOT_MODEL || 'glm-5.3-flash';

export const isLlmConfigured = Boolean(KEY);

async function chat(messages, { maxTokens = 300, model = MODEL, timeout = 45000 } = {}) {
  if (!KEY) throw new Error('LLM_API_KEY not set');
  const res = await fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(timeout),
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/* Models answer with JSON the way people answer with a straight yes: mostly.
   A fence around it, a sentence in front, a thought that itself contains a
   brace, or — the one that actually bites — a reply that ran out of tokens
   halfway through the last object. Each of those is recoverable and worth
   recovering: the alternative is throwing away an answer the model did give. */
export function parseJsonLoose(text) {
  const body = String(text ?? '').replace(/```(?:json)?\s*|\s*```/gi, '').trim();
  try {
    return JSON.parse(body);
  } catch { /* it is rarely this easy */ }

  const start = body.indexOf('{');
  if (start < 0) throw new Error('no JSON in LLM reply');

  // The first balanced object from there, ignoring braces inside strings —
  // a greedy match to the last brace swallows any prose that follows it.
  const balanced = firstObject(body, start);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch { /* balanced but still malformed */ }
  }

  // Nothing balanced means the reply was cut off. Close what is open and keep
  // whatever objects did finish, rather than losing the lot to the last one.
  try {
    return JSON.parse(closeTruncated(body.slice(start)));
  } catch {
    throw new Error(`could not parse the reply as JSON (${body.length} chars)`);
  }
}

function firstObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/* Drop the half-written tail, then close every bracket still open. */
function closeTruncated(text) {
  const open = [];
  let inString = false;
  let escaped = false;
  let lastComplete = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') open.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      open.pop();
      // an element of the outer array finished cleanly here
      if (open.length === 2) lastComplete = i;
    }
  }
  const body = lastComplete >= 0 ? text.slice(0, lastComplete + 1) : text.replace(/,\s*[^,]*$/, '');
  const stillOpen = [];
  let depth = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { stillOpen.push('}'); depth += 1; }
    else if (ch === '[') { stillOpen.push(']'); depth += 1; }
    else if (ch === '}' || ch === ']') { stillOpen.pop(); depth -= 1; }
  }
  return body + stillOpen.reverse().join('');
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

/**
 * Read a screenshot for the article (or articles) it points at. The picture is
 * usually a social post — a video with a page held up behind it, or a link card
 * — so most of what is legible is the app's own furniture rather than the piece
 * the reader wanted. The model is asked to separate the two and to name what it
 * sees, not to guess a URL: guessed URLs look right and 404, and the resolvers
 * downstream find real ones from these fields.
 * Returns { candidates: [...] }; the caller validates every field.
 */
export async function readArticleReferences({ image, mime }) {
  const reply = await chat([
    {
      role: 'system',
      content: 'You read screenshots for a read-later app and report the articles they refer to. '
        + 'You transcribe what is written; you never invent a URL, a date or an author. '
        + 'Respond with strict JSON, nothing else.',
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${image}` } },
        {
          type: 'text',
          text: `This is a phone screenshot, usually of a social app (TikTok, Instagram, Reddit, X).
Somewhere in it a written article is being referred to — a page filmed behind the speaker, a
newsletter email, a link card, a PDF, or a title named in the caption.

Ignore the app's own furniture. None of this is ever part of an article:
the status bar (clock, battery, wifi), "Find related content", "Search", "SHARE",
"SUBSCRIBE", "Listen", "Repost to followers", "Add comment…", "more", "Effect · Green Screen",
"Playlist", like/comment/bookmark counts, follower counts, page indicators like "3 / 4",
the poster's handle and the date they posted, and menu or navigation words.

Report every distinct article the screenshot refers to, including ones that are only named in
the caption and not shown. For each one give what is actually legible and null for the rest:

- title: the article's headline, transcribed exactly, capitalisation and all
- subtitle: the standfirst or deck beneath it, if any
- publication: the masthead or newsletter name (e.g. "Vogue Business", "THE CULTURIST", "mindbox")
- byline: the author's name as written on the article itself, not the social poster's handle
- published: the article's own date, as an ISO date (YYYY-MM-DD) when you can read one
- url: only if a full URL is legible somewhere in the picture
- domain: only if a bare domain is legible (e.g. "conquer1.substack.com"), lowercased
- kind: "article" for journalism or a blog post, "newsletter" for Substack-shaped email or link
  cards, "paper" for an academic paper with authors and institutions, "unknown" otherwise
- excerpt: the first sentence or two of body text, if any is legible
- confidence: 0 to 1, how sure you are this is a real article reference

Also report:
- poster: the social account's display name or handle, if visible. It is often the same person
  as the byline, so it is worth having even though it is not part of the article.

Report at most 4 articles, the clearest first, and keep every field short. Do not explain
your reasoning; the JSON is the whole answer.

Reply with JSON only:
{"poster":"...","candidates":[{"title":"...","subtitle":null,"publication":"...","byline":null,"published":null,"url":null,"domain":null,"kind":"newsletter","excerpt":null,"confidence":0.9}]}`,
        },
      ],
    },
    // Vision models spend tokens on the picture before a word of JSON appears,
    // and a caption listing four articles is four objects long. Under-budget it
    // and the reply is cut off mid-object, which used to lose the whole answer.
  ], { maxTokens: 4000, model: VISION_MODEL, timeout: 90_000 });

  let parsed;
  try {
    parsed = parseJsonLoose(reply);
  } catch (error) {
    // The reply itself is the only evidence of why a read came back empty.
    error.reply = String(reply || '').slice(0, 400);
    throw error;
  }
  return {
    poster: typeof parsed.poster === 'string' ? parsed.poster : null,
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
  };
}
