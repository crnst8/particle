// The three names a narration goes by. They are kept apart on purpose: what the
// article says, how it is cut into passages, and how those passages sound are
// three different things that change for different reasons, and a cached mp3
// is only reusable when all three are the same. Nothing here reads a clock or a
// credential, so the same inputs always produce the same names.
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');

/* What the narration is made from: the stored body (manual include/exclude
   marks live inside it as attributes) and the fields the classifier compares
   blocks against to spot a repeated title or byline. */
export function contentRevision(article) {
  return `c${sha(JSON.stringify([
    1,
    article?.title || '',
    article?.byline || '',
    article?.site_name || '',
    article?.published_at || '',
    article?.content_html || '',
  ])).slice(0, 31)}`;
}

/* How that content is cut into passages: the classifier's rules (its version)
   and the segment size policy. Speech normalisation is part of the script
   builder, so a change to it is a SCRIPT_VERSION bump and moves this too. */
export function scriptId(contentRev, scriptVersion, policy) {
  return `s${sha(JSON.stringify([contentRev, scriptVersion, policy || {}])).slice(0, 31)}`;
}

/* How the passages sound: the voice and every input the provider receives.
   Browser playback rate is deliberately not here — changing speed in the
   player must never synthesise anything. */
export function narrationRev({ script_id, voice_id, config }) {
  return `r${sha(JSON.stringify([script_id || '', voice_id || '', stable(config || {})])).slice(0, 31)}`;
}

/** A provider endpoint's identity without anything in it that should stay private. */
export function endpointIdentity(url) {
  try {
    const parsed = new URL(url);
    return sha(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).slice(0, 16);
  } catch {
    return sha(String(url || '')).slice(0, 16);
  }
}

/* Key order must not change a hash. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export const hashText = text => sha(String(text)).slice(0, 12);
