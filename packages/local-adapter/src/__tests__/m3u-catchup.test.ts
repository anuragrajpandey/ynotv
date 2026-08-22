import { describe, it, expect } from 'vitest';
import { parseM3U } from '../m3u-parser';
import { buildM3uCatchupUrl } from '../m3u-catchup';

describe('M3U Catchup', () => {
  it('should parse catchup, catchup-days, and catchup-source from EXTINF', () => {
    const m3uContent = `#EXTM3U
#EXTINF:-1 group-title="Tokyo | SG 01" tvg-id="gd05" tvg-logo="https://example.com/icon.png" catchup="default" catchup-days="6" catchup-source="https://akariko-bck1.sankuria.sbs/stream/jp/fuji_tv/replay.m3u8?start={utc}",Fuji TV
https://akariko-bck1.sankuria.sbs/stream/jp/fuji_tv/stream-output.m3u8?mode=hls
`;

    const result = parseM3U(m3uContent, 'source_1');
    expect(result.channels.length).toBe(1);
    const channel = result.channels[0];

    expect(channel.name).toBe('Fuji TV');
    expect(channel.tv_archive).toBe(1);
    expect(channel.catchup_type).toBe('default');
    expect(channel.catchup_days).toBe(6);
    expect(channel.catchup_source).toBe('https://akariko-bck1.sankuria.sbs/stream/jp/fuji_tv/replay.m3u8?start={utc}');
  });

  it('should resolve catchup-source template with {utc} placeholder', () => {
    const startTimeMs = 1750000000000; // 1750000000 seconds
    const url = buildM3uCatchupUrl({
      catchupSource: 'https://akariko-bck1.sankuria.sbs/stream/jp/fuji_tv/replay.m3u8?start={utc}',
      catchupType: 'default',
      directUrl: 'https://akariko-bck1.sankuria.sbs/stream/jp/fuji_tv/stream-output.m3u8?mode=hls',
      startTimeMs,
      durationMinutes: 60,
    });

    expect(url).toBe('https://akariko-bck1.sankuria.sbs/stream/jp/fuji_tv/replay.m3u8?start=1750000000');
  });

  it('should resolve ${start} placeholder as Unix epoch seconds', () => {
    const startTimeMs = 1750000000000; // 2025-06-15T12:06:40.000Z
    const url = buildM3uCatchupUrl({
      catchupSource: 'https://example.com/replay.m3u8&start=${start}',
      catchupType: 'default',
      directUrl: 'https://example.com/live.m3u8?token=abc',
      startTimeMs,
      durationMinutes: 60,
    });

    expect(url).toBe('https://example.com/replay.m3u8&start=1750000000');
  });

  it('should resolve catchup-source template with date specifiers ({Y}, {m}, {d}, {H}, {M}, {S})', () => {
    // 2026-07-26T12:30:00.000Z
    const startTimeMs = Date.UTC(2026, 6, 26, 12, 30, 0);
    const url = buildM3uCatchupUrl({
      catchupSource: 'http://server.com/replay?start={Y}-{m}-{d}T{H}:{M}:{S}&duration={duration}&channel={catchup-id}',
      catchupType: 'default',
      directUrl: 'http://server.com/live.m3u8',
      startTimeMs,
      durationMinutes: 30,
      epgChannelId: 'fuji_tv',
    });

    expect(url).toBe('http://server.com/replay?start=2026-07-26T12:30:00&duration=1800&channel=fuji_tv');
  });

  it('should fall back correctly for catchup="append"', () => {
    const startTimeMs = 1750000000000;
    const url = buildM3uCatchupUrl({
      catchupType: 'append',
      directUrl: 'http://server.com/live.m3u8',
      startTimeMs,
      durationMinutes: 60,
    });

    expect(url).toContain('http://server.com/live.m3u8?utc=1750000000&lutc=');
  });

  it('should inherit global #EXTM3U catchup settings when channel EXTINF omits them', () => {
    const m3uContent = `#EXTM3U catchup="default" catchup-days="7" catchup-source="https://server.com/replay.m3u8?ch={catchup-id}&start=\${start}"
#EXTINF:-1 tvg-id="ch1",Channel One
https://server.com/stream1.m3u8
#EXTINF:-1 tvg-id="ch2" catchup="shift" catchup-days="3",Channel Two
https://server.com/stream2.m3u8
`;

    const result = parseM3U(m3uContent, 'source_test');
    expect(result.channels.length).toBe(2);

    // Channel 1 inherits header defaults
    expect(result.channels[0].name).toBe('Channel One');
    expect(result.channels[0].tv_archive).toBe(1);
    expect(result.channels[0].catchup_type).toBe('default');
    expect(result.channels[0].catchup_days).toBe(7);
    expect(result.channels[0].catchup_source).toBe('https://server.com/replay.m3u8?ch={catchup-id}&start=${start}');

    // Channel 2 overrides catchup_type and catchup_days but inherits catchup_source
    expect(result.channels[1].name).toBe('Channel Two');
    expect(result.channels[1].tv_archive).toBe(1);
    expect(result.channels[1].catchup_type).toBe('shift');
    expect(result.channels[1].catchup_days).toBe(3);
    expect(result.channels[1].catchup_source).toBe('https://server.com/replay.m3u8?ch={catchup-id}&start=${start}');
  });

  it('should parse single-quoted and unquoted catchup attributes', () => {
    const m3uContent = `#EXTM3U
#EXTINF:-1 tvg-id='ch1' catchup='default' catchup-days=5 catchup-source='https://server.com/replay.m3u8?start=\${start}',Channel Single
https://server.com/stream1.m3u8
`;

    const result = parseM3U(m3uContent, 'source_test');
    expect(result.channels.length).toBe(1);
    expect(result.channels[0].tv_archive).toBe(1);
    expect(result.channels[0].catchup_type).toBe('default');
    expect(result.channels[0].catchup_days).toBe(5);
    expect(result.channels[0].catchup_source).toBe('https://server.com/replay.m3u8?start=${start}');
  });
});
