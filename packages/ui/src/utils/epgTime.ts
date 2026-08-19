import type { StoredProgram } from '../db';

/**
 * Stored EPG timestamps come in mixed formats: UTC ISO strings ending in 'Z'
 * (Stalker sync, timeshifted programs) and ISO strings carrying an explicit
 * offset like "+02:00" (XMLTV feeds that ship wall-clock times, e.g.
 * "20240819150000 +0200"). Lexicographic string comparison against
 * `new Date().toISOString()` (always "...Z" with milliseconds) is therefore
 * unreliable near boundaries: an expired program can still satisfy `end > now`
 * and the real current one can fail `start <= now`. Current/next program
 * lookups fetch a generous window and pick precisely in JS instead.
 */
// Backward window must exceed the largest possible timezone offset (14h) so an
// offset-distorted SQL comparison can never exclude the program airing now.
export const EPG_WINDOW_BACK_MS = 48 * 60 * 60 * 1000;
// Forward window covers the "next" program even when there is a gap in the feed.
export const EPG_WINDOW_FWD_MS = 7 * 24 * 60 * 60 * 1000;

export function epgTimeMs(value: Date | string | number | null | undefined): number {
  if (value == null) return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

// Pick the program whose window covers `now`, preferring the latest start.
// Equivalent to `ORDER BY start DESC LIMIT 1` but with correct Date parsing.
export function pickCurrentProgram(rows: StoredProgram[], now: number): StoredProgram | null {
  let prog: StoredProgram | null = null;
  let bestStartMs = -Infinity;
  for (const row of rows) {
    const startMs = epgTimeMs(row.start);
    const endMs = epgTimeMs(row.end);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= now && endMs > now && startMs > bestStartMs) {
      prog = row;
      bestStartMs = startMs;
    }
  }
  return prog;
}
