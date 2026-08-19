/**
 * Global TMDB rate limiter.
 *
 * TMDB's standard API tier allows ~50 requests/second. We budget 40 req/s with
 * a small burst buffer so heavy scans (tens of thousands of lookups) and
 * on-demand detail fetches (casts, seasons) share one throttle and never trip
 * 429 rate-limit responses. 429 / 5xx responses are retried with exponential
 * backoff (honoring Retry-After when present).
 */

const MAX_RATE_PER_SEC = 40;
const BURST = 40;

let tokens = BURST;
let lastRefill = Date.now();

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Acquire one request token, blocking until the bucket refills. */
async function acquireToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * MAX_RATE_PER_SEC);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(25);
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * fetch() wrapper for TMDB calls: rate-limited + retried. Returns the final
 * Response (even a non-OK one — callers decide how to handle e.g. 404).
 */
export async function rateLimitedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
): Promise<Response> {
  const signal = init?.signal;
  for (let attempt = 0; ; attempt++) {
    await acquireToken();
    throwIfAborted(signal);

    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (e) {
      // Abort requested — never retry, surface immediately.
      if (signal?.aborted) throw e;
      // Network-level failure (offline, DNS, timeout) — retry with backoff.
      if (attempt >= retries) throw e;
      await sleep(500 * 2 ** attempt, signal);
      throwIfAborted(signal);
      continue;
    }

    if (!RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res;

    const retryAfter = Number(res.headers.get('retry-after') ?? 0);
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, signal);
    throwIfAborted(signal);
  }
}
