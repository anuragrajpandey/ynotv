import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Bounded auto-retry for poster <img> loads. Poster images are fetched by the
 * webview straight from the TMDB image CDN (NOT through the API rate limiter),
 * and when a big grid first fills, the browser's per-host connection queue can
 * cause transient failures. This hook retries with exponential backoff so a
 * poster self-heals instead of staying blank; after MAX_ATTEMPTS the failure
 * is reported via onFailed so the "No Metadata" filter can surface the title.
 */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 800;

export function usePosterRetry(
  onFailed?: () => void,
  onLoaded?: () => void,
  resetOn?: unknown,
) {
  const [retryKey, setRetryKey] = useState(0);
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // A new src (e.g. after Refresh Metadata) starts the attempt counter over.
  useEffect(() => {
    attemptsRef.current = 0;
  }, [resetOn]);

  const handleError = useCallback(() => {
    if (attemptsRef.current >= MAX_ATTEMPTS - 1) {
      onFailed?.();
      return;
    }
    attemptsRef.current += 1;
    const delay = BASE_DELAY_MS * 2 ** attemptsRef.current;
    timerRef.current = window.setTimeout(() => setRetryKey((k) => k + 1), delay);
  }, [onFailed]);

  const handleLoad = useCallback(() => {
    attemptsRef.current = 0;
    onLoaded?.();
  }, [onLoaded]);

  return { retryKey, handleError, handleLoad };
}
