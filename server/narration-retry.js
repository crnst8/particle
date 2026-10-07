// How a provider call is retried, and what its failures are called.
//
// One attempt is the whole exchange — request, status, and reading the body to
// the end — because a body that dies halfway is as much a failure as a 503 and
// deserves the same treatment. Attempts share one deadline; the caller's own
// AbortSignal ends everything at once and is never retried.
//
// A retry after a request was sent can be billed twice by the provider: the
// first request may have been processed even though its answer never arrived.
// That is why attempts are few, bounded by one deadline, and only made for
// failures that are plausibly transient.

export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isRetryableStatus = status => status === 408 || status === 429 || status >= 500;

/** Retry-After as milliseconds from now: delta-seconds or an HTTP date. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return null;
}

/**
 * The error a status code stands for. `hint` is a short, lower-cased excerpt
 * of the provider's body used only to tell "no such voice" from other refusals;
 * it is never put in the message, which reaches the browser and the log.
 */
export function errorForStatus(status, { voiceId = null, hint = '', retryAfter = null, nowMs = Date.now() } = {}) {
  const retryAfterMs = parseRetryAfter(retryAfter, nowMs);
  if (status === 401 || status === 403) {
    return new ProviderError('provider_auth', 'the narration provider refused the key', { status });
  }
  if (status === 402) {
    return new ProviderError('provider_auth', 'the narration provider account cannot pay for this', { status });
  }
  if (voiceId && (status === 404 || ((status === 400 || status === 422) && /voice|reference|model|not\s*found/.test(hint)))) {
    return new ProviderError('voice_unavailable', 'that voice is not available from the provider', { status });
  }
  if (status === 429) {
    return new ProviderError('rate_limited', 'the narration provider asked us to slow down', { status, retryable: true, retryAfterMs });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('provider_timeout', 'the narration provider timed out', { status, retryable: true, retryAfterMs });
  }
  if (status >= 500) {
    return new ProviderError('provider_unavailable', 'the narration provider is having trouble', { status, retryable: true, retryAfterMs });
  }
  return new ProviderError('provider_rejected', `the narration provider refused the request (HTTP ${status})`, { status });
}

/** Anything thrown during an attempt, as a ProviderError. */
export function normaliseError(error, { timedOut = false } = {}) {
  if (error instanceof ProviderError) return error;
  if (timedOut || error?.name === 'TimeoutError') {
    return new ProviderError('provider_timeout', 'the narration provider took too long', { retryable: true });
  }
  return new ProviderError('network', 'the narration provider could not be reached', { retryable: true });
}

export function backoffMs(attempt, random = Math.random) {
  return Math.round(700 * 2 ** attempt * (0.5 + random()));
}

/**
 * Run `attempt(signal, n)` until it succeeds, a failure is permanent, attempts
 * run out, or the deadline passes. The signal handed to each attempt fires on
 * the caller's cancellation, the per-attempt timeout, or the overall deadline.
 */
export async function withProviderRetry(attempt, {
  signal,
  attempts = 3,
  requestTimeoutMs = 45_000,
  totalTimeoutMs = 90_000,
  now = () => Date.now(),
  sleep = defaultSleep,
  random = Math.random,
  timer = defaultTimer,
} = {}) {
  const deadline = now() + totalTimeoutMs;
  let last = null;
  for (let n = 0; n < attempts; n++) {
    if (signal?.aborted) throw cancelled(signal);
    const remaining = deadline - now();
    if (remaining <= 0) throw last || new ProviderError('provider_timeout', 'the narration provider took too long', { retryable: true });

    const controller = new AbortController();
    let timedOut = false;
    const stopTimer = timer(Math.min(requestTimeoutMs, remaining), () => { timedOut = true; controller.abort(); });
    const onCancel = () => controller.abort();
    signal?.addEventListener('abort', onCancel, { once: true });
    try {
      return await attempt(controller.signal, n);
    } catch (error) {
      if (signal?.aborted) throw cancelled(signal);
      last = normaliseError(error, { timedOut });
      if (!last.retryable || n === attempts - 1) throw last;
      const delay = last.retryAfterMs ?? backoffMs(n, random);
      if (now() + delay >= deadline) {
        // waiting would overrun the deadline: hand back the failure, and how long to wait
        last.retryAfterMs = delay;
        throw last;
      }
      await sleep(delay, signal);
      if (signal?.aborted) throw cancelled(signal);
    } finally {
      stopTimer();
      signal?.removeEventListener('abort', onCancel);
    }
  }
  throw last;
}

function cancelled(signal) {
  const reason = signal?.reason;
  if (reason && typeof reason === 'object' && reason.code === 'cancelled') return reason;
  return Object.assign(new Error('cancelled'), { name: 'CancelledError', code: 'cancelled', retryable: true });
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

function defaultTimer(ms, fire) {
  const id = setTimeout(fire, ms);
  return () => clearTimeout(id);
}
