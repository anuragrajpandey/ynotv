/**
 * Low-priority poster preloading for the Local grid.
 *
 * When a folder scan finishes, the freshly-populated grid mounts its first
 * rows all at once and their lazy <img>s fire a burst of requests at the TMDB
 * image CDN. This module instead warms the browser HTTP cache for the first
 * few rows *during idle time*: a small batch of images per
 * requestIdleCallback slice, at low fetch priority. When the grid actually
 * renders, the posters are already cached (or well on their way), so the CDN
 * sees a gentle trickle rather than a spike.
 *
 * Only remote http(s) URLs are preloaded — local art is served by the app's
 * own asset protocol and loads instantly, so touching it buys nothing. URLs
 * are deduped for the lifetime of the session so a re-scan or filter change
 * never re-fetches what's already been warmed.
 */

const BATCH_SIZE = 3; // images per idle slice
const MAX_PRELOAD = 40; // ~4 rows x ~10 columns: viewport + overscan
const IDLE_TIMEOUT_MS = 1500; // rIC deadline so the trickle survives busy periods
const FALLBACK_DELAY_MS = 250; // no rIC (unlikely in WebView2): paced setTimeout

const preloadedThisSession = new Set<string>();
let activeRun = 0;

/** Cancel any in-flight preload (unmount, or before a new scan kicks off). */
export function cancelPosterPreload(): void {
  activeRun += 1;
}

/**
 * Warm the browser cache for the given poster URLs, spread over idle time.
 * `limit` caps how many images get preloaded (defaults to the first few rows).
 */
export function preloadPosters(urls: string[], limit = MAX_PRELOAD): void {
  const run = ++activeRun;

  // Remote CDN posters only; dedupe within this run and across the session.
  const seen = new Set<string>();
  const targets = urls
    .filter((u) => /^https?:\/\//i.test(u))
    .filter((u) => !preloadedThisSession.has(u) && !seen.has(u))
    .map((u) => {
      seen.add(u);
      return u;
    })
    .slice(0, limit);
  if (targets.length === 0) return;

  const idleCallback = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  }).requestIdleCallback;

  let next = 0;
  const schedule = (delay?: number) => {
    if (run !== activeRun) return;
    if (typeof idleCallback === 'function') {
      idleCallback(() => step(), { timeout: IDLE_TIMEOUT_MS });
    } else {
      window.setTimeout(step, delay ?? FALLBACK_DELAY_MS);
    }
  };
  const step = () => {
    if (run !== activeRun) return;
    const batch = targets.slice(next, next + BATCH_SIZE);
    next += batch.length;
    for (const url of batch) {
      preloadedThisSession.add(url);
      const img = new Image();
      img.decoding = 'async';
      try {
        // Keeps these out of the way of the images the user is actually
        // looking at. Chromium (WebView2) honors fetchPriority.
        (img as unknown as { fetchPriority: string }).fetchPriority = 'low';
      } catch {
        /* older webview: the attribute is simply ignored */
      }
      img.src = url;
    }
    if (next < targets.length) schedule();
  };

  schedule(100);
}
