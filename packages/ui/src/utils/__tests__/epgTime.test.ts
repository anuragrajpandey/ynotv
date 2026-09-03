import { describe, it, expect } from 'vitest';
import { pickCurrentProgram, epgTimeMs, EPG_WINDOW_BACK_MS, EPG_WINDOW_FWD_MS } from '../epgTime';
import type { StoredProgram } from '../../db';

function prog(partial: Partial<StoredProgram> & { id: string; title: string; start: string; end: string }): StoredProgram {
  return { stream_id: 'ch1', description: '', ...partial } as unknown as StoredProgram;
}

describe('pickCurrentProgram', () => {
  // Real time: 2026-08-19 13:40 UTC (15:40 local in a +02:00 zone). XMLTV feeds
  // often ship wall-clock times with an explicit offset, which the Rust parser
  // stores verbatim as e.g. "2026-08-19T15:00:00+02:00". The old SQL lookup
  // compared these strings lexicographically against `new Date().toISOString()`
  // ("...Z"), which wrongly excluded the current program (its "15:00:00+02:00"
  // string sorts after "13:40:00.000Z") and wrongly kept the expired one (its
  // "14:00:00+02:00" string also sorts after), so the channel-info overlay
  // showed the previous program.
  it('picks the actual current program even with offset-formatted timestamps', () => {
    const now = Date.parse('2026-08-19T13:40:00.000Z');
    const prev = prog({
      id: 'p1',
      title: 'Previous program',
      start: '2026-08-19T13:00:00+02:00', // = 11:00 UTC, ended at 12:00 UTC
      end: '2026-08-19T14:00:00+02:00',
    });
    const cur = prog({
      id: 'p2',
      title: 'Current program',
      start: '2026-08-19T15:00:00+02:00', // = 13:00 UTC, airing now
      end: '2026-08-19T16:00:00+02:00',
    });

    // Document the old SQL failure mode: the expired program passed `end > now`
    // and the current one failed `start <= now` under lexicographic comparison.
    expect('2026-08-19T14:00:00+02:00' > '2026-08-19T13:40:00.000Z').toBe(true);
    expect('2026-08-19T15:00:00+02:00' <= '2026-08-19T13:40:00.000Z').toBe(false);

    expect(pickCurrentProgram([prev, cur], now)?.title).toBe('Current program');
  });

  it('picks correctly for plain UTC "Z" timestamps', () => {
    const now = Date.parse('2026-08-19T13:40:00.000Z');
    const rows = [
      prog({ id: 'a', title: 'Old', start: '2026-08-19T12:00:00Z', end: '2026-08-19T13:00:00Z' }),
      prog({ id: 'b', title: 'Now', start: '2026-08-19T13:00:00Z', end: '2026-08-19T14:00:00Z' }),
      prog({ id: 'c', title: 'Next', start: '2026-08-19T14:00:00Z', end: '2026-08-19T15:00:00Z' }),
    ];
    expect(pickCurrentProgram(rows, now)?.title).toBe('Now');
  });

  it('prefers the latest start when programs overlap', () => {
    const now = Date.parse('2026-08-19T13:40:00.000Z');
    const rows = [
      prog({ id: 'a', title: 'Earlier start', start: '2026-08-19T13:00:00Z', end: '2026-08-19T14:30:00Z' }),
      prog({ id: 'b', title: 'Later start', start: '2026-08-19T13:30:00Z', end: '2026-08-19T14:00:00Z' }),
    ];
    expect(pickCurrentProgram(rows, now)?.title).toBe('Later start');
  });

  it('returns null when nothing is airing and ignores malformed timestamps', () => {
    const now = Date.parse('2026-08-19T13:40:00.000Z');
    const rows = [
      prog({ id: 'a', title: 'Broken', start: 'not-a-date', end: 'also-not-a-date' }),
      prog({ id: 'b', title: 'Ended', start: '2026-08-19T12:00:00Z', end: '2026-08-19T13:00:00Z' }),
    ];
    expect(pickCurrentProgram(rows, now)).toBeNull();
  });
});

describe('epgTimeMs', () => {
  it('parses Date, offset ISO strings, and Z strings; rejects null/invalid', () => {
    const offset = epgTimeMs('2026-08-19T15:00:00+02:00');
    expect(offset).toBe(Date.parse('2026-08-19T13:00:00.000Z'));
    expect(epgTimeMs('2026-08-19T13:00:00Z')).toBe(Date.parse('2026-08-19T13:00:00.000Z'));
    expect(epgTimeMs(new Date('2026-08-19T13:00:00.000Z'))).toBe(Date.parse('2026-08-19T13:00:00.000Z'));
    expect(Number.isNaN(epgTimeMs(null))).toBe(true);
    expect(Number.isNaN(epgTimeMs('garbage'))).toBe(true);
  });
});

describe('EPG window constants', () => {
  it('backward window exceeds the largest timezone offset so the airing program is always fetched', () => {
    expect(EPG_WINDOW_BACK_MS).toBeGreaterThan(14 * 60 * 60 * 1000);
  });
  it('forward window is generous enough for next-program lookups', () => {
    expect(EPG_WINDOW_FWD_MS).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});
