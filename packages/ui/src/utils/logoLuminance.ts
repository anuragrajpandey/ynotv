import { LRUCache } from './lru-cache';

/**
 * Logo luminance classification.
 *
 * Most channel logos are transparent PNGs designed to sit on white or light
 * backgrounds, which makes them hard to see on a dark UI. We sample each logo's
 * average luminance once (downscaled to a 16x16 canvas) and classify it as
 * 'dark' (needs a light tile background) or 'light' (fine as-is). Results are
 * cached in memory (LRU) and persisted to localStorage; verdicts expire after
 * a TTL so a one-time misclassification can't stick forever, and can be cleared
 * manually via resetLogoVerdictCache().
 */

export type LogoVerdict = 'light' | 'dark';

const STORAGE_KEY = 'ynotv.logo-luminance.v1';
const MAX_PERSISTED = 10000;
const MAX_CONCURRENT_FETCHES = 8;
/**
 * Re-sample a logo this often. Verdicts are cached indefinitely today, so a
 * single misclassification (e.g. a burst that exceeded the fetch concurrency
 * limit) would otherwise be frozen in localStorage forever. With a TTL, the
 * next render of the logo re-classifies it.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Persisted entry: the verdict plus when it was classified, so stale verdicts can be re-sampled. */
interface PersistedVerdict {
  v: LogoVerdict;
  t: number;
}

// Memory tier uses the LRU's built-in maxAge so expired entries are dropped on read.
const memoryCache = new LRUCache<string, LogoVerdict>({ maxSize: 5000, maxAge: TTL_MS });
const inFlight = new Map<string, Promise<LogoVerdict>>();
let pendingFetches = 0;

let persisted: Record<string, PersistedVerdict> = {};
let persistedLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadPersisted(): Record<string, PersistedVerdict> {
  if (persistedLoaded) return persisted;
  persistedLoaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const migrated: Record<string, PersistedVerdict> = {};
      for (const [url, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && (value === 'light' || value === 'dark')) {
          // v1 format was bare verdict strings; treat as just-written so they
          // expire on the normal TTL schedule.
          migrated[url] = { v: value, t: Date.now() };
        } else if (
          value &&
          typeof value === 'object' &&
          typeof (value as any).v === 'string' &&
          typeof (value as any).t === 'number'
        ) {
          migrated[url] = value as PersistedVerdict;
        }
      }
      persisted = migrated;
    }
  } catch {
    persisted = {};
  }
  return persisted;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage full or unavailable — keep in-memory only
    }
  }, 2000);
}

/** Fresh verdict only — used by classifyLogo so stale entries trigger a re-sample. */
function getCached(url: string): LogoVerdict | undefined {
  const mem = memoryCache.get(url);
  if (mem) return mem;
  const entry = loadPersisted()[url];
  if (entry && Date.now() - entry.t < TTL_MS) return entry.v;
  return undefined;
}

/**
 * Synchronously read the cached luminance verdict for a URL (memory +
 * persisted localStorage). Unlike classifyLogo's freshness check, this
 * returns stale verdicts too so tiles seed with the known-good background
 * while a re-sample runs in the background — no flash-to-empty when a
 * verdict expires.
 */
export function getCachedLogoVerdict(url?: string | null): LogoVerdict | undefined {
  if (!url) return undefined;
  const mem = memoryCache.get(url);
  if (mem) return mem;
  return loadPersisted()[url]?.v;
}

function setCached(url: string, verdict: LogoVerdict) {
  memoryCache.set(url, verdict);
  const map = loadPersisted();
  const prev = map[url];
  if (!prev || prev.v !== verdict || Date.now() - prev.t > TTL_MS) {
    if (Object.keys(map).length >= MAX_PERSISTED) {
      // Evict ~25% of oldest keys to bound storage growth
      const keys = Object.keys(map);
      for (let i = 0; i < Math.floor(keys.length * 0.25); i++) {
        delete map[keys[i]];
      }
    }
    map[url] = { v: verdict, t: Date.now() };
    schedulePersist();
  }
}

/**
 * Clear every cached luminance verdict (memory + localStorage) so all logos
 * are re-sampled on their next render. Use this to recover from a bad batch
 * of classifications (e.g. a burst that exceeded the fetch concurrency limit
 * and permanently mislabeled logos as 'light').
 */
export function resetLogoVerdictCache(): void {
  memoryCache.clear();
  persisted = {};
  persistedLoaded = true;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — in-memory state is already cleared
  }
}

/**
 * Compute average luminance of an image element drawn onto a 16x16 canvas.
 * Weighted by alpha so transparent pixels don't skew the average.
 */
function sampleLuminance(img: HTMLImageElement): number {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 255;
  ctx.drawImage(img, 0, 0, 16, 16);
  const { data } = ctx.getImageData(0, 0, 16, 16);

  let sum = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum * alpha;
    weight += alpha;
  }
  return weight > 0 ? sum / weight : 255;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

/**
 * Bounded semaphore around the proxy fetches. When more than
 * MAX_CONCURRENT_FETCHES logos need sampling at once (e.g. a freshly loaded
 * category), later requests wait for a free slot instead of failing instantly
 * and caching a false 'light' verdict. Waits are capped so a huge burst can't
 * stall the queue forever — anyone who times out still falls back to 'light',
 * but that failure is now bounded by the verdict TTL instead of permanent.
 */
const QUEUE_WAIT_MS = 15000;

const fetchQueue: Array<() => void> = [];

async function acquireFetchSlot(): Promise<boolean> {
  if (pendingFetches < MAX_CONCURRENT_FETCHES) {
    pendingFetches++;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const i = fetchQueue.indexOf(release);
      if (i >= 0) fetchQueue.splice(i, 1);
      resolve(false);
    }, QUEUE_WAIT_MS);
    const release = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingFetches++;
      resolve(true);
    };
    fetchQueue.push(release);
  });
}

function releaseFetchSlot(): void {
  pendingFetches--;
  const next = fetchQueue.shift();
  if (next) next();
}

/**
 * Fetch logo bytes via the Tauri fetch proxy (bypasses CORS) and sample
 * luminance from a same-origin blob URL. Falls back gracefully.
 */
async function sampleFromUrl(url: string): Promise<number | null> {
  if (typeof window === 'undefined' || !window.fetchProxy?.fetchBinary) return null;
  const acquired = await acquireFetchSlot();
  if (!acquired) return null;

  try {
    const res = await window.fetchProxy.fetchBinary(url, { timeout: 10000 });
    if (!res?.success || !res.data) return null;
    const bytes = res.data.buffer.slice(
      res.data.byteOffset,
      res.data.byteOffset + res.data.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([bytes]);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(objectUrl);
      return sampleLuminance(img);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  } finally {
    releaseFetchSlot();
  }
}

/**
 * Classify a logo URL. `loadedImg` (optional) lets us reuse the already-fetched
 * <img> element for same-origin / CORS-enabled logos; otherwise we fall back to
 * the Tauri fetch proxy. Cached results return immediately.
 */
export async function classifyLogo(url: string, loadedImg?: HTMLImageElement): Promise<LogoVerdict> {
  const cached = getCached(url);
  if (cached) return cached;

  const existing = inFlight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    let lum: number | null = null;

    if (loadedImg && loadedImg.complete && loadedImg.naturalWidth > 0) {
      try {
        lum = sampleLuminance(loadedImg);
      } catch {
        lum = null; // cross-origin tainted canvas — fall back to proxy
      }
    }

    if (lum === null) {
      lum = await sampleFromUrl(url);
    }

    // Conservative threshold: only genuinely dark logos get the light tile
    const verdict: LogoVerdict = lum === null ? 'light' : lum < 70 ? 'dark' : 'light';
    setCached(url, verdict);
    return verdict;
  })().finally(() => inFlight.delete(url));

  inFlight.set(url, promise);
  return promise;
}
