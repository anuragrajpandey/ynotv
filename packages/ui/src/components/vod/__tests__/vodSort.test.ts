import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SORT_DIRECTION,
  getVodSortValue,
  sortVodItems,
  type VodSortKey,
} from '../vodSort';

interface MovieLike {
  stream_id: string;
  name: string;
  title?: string;
  year?: string | number;
  release_date?: string;
  releaseDate?: string;
  rating?: string;
  rating_5based?: number;
  added?: string | number;
  source_id?: string;
  stream_icon?: string;
  direct_url?: string;
}

function movie(overrides: { stream_id: string } & Partial<Omit<MovieLike, 'stream_id'>>): any {
  return {
    name: 'Untitled',
    title: 'Untitled',
    source_id: 'src1',
    stream_icon: '',
    direct_url: '',
    ...overrides,
  };
}

describe('getVodSortValue - year', () => {
  it('uses the year field when present', () => {
    expect(getVodSortValue(movie({ stream_id: 'a', year: '2020' }), 'movie', 'year', {})).toBe(2020);
    expect(getVodSortValue(movie({ stream_id: 'b', year: 1999 }), 'movie', 'year', {})).toBe(1999);
  });

  it('strips JSON-encoded quotes from year values written by older native syncs', () => {
    expect(getVodSortValue(movie({ stream_id: 'q', year: '"1962"' }), 'movie', 'year', {})).toBe(1962);
    expect(getVodSortValue(movie({ stream_id: 'r', year: '"2021"' }), 'movie', 'year', {})).toBe(2021);
  });

  it('falls back to release_date when year is missing', () => {
    expect(
      getVodSortValue(movie({ stream_id: 'c', release_date: '2015-06-01' }), 'movie', 'year', {})
    ).toBe(2015);
  });

  it('falls back to the camelCase releaseDate column used by series', () => {
    expect(
      getVodSortValue(movie({ stream_id: 'g', releaseDate: '2018-10-12' }), 'series', 'year', {})
    ).toBe(2018);
  });

  it('falls back to a trailing year embedded in the name', () => {
    expect(
      getVodSortValue(movie({ stream_id: 'd', name: 'Great Movie (2012)' }), 'movie', 'year', {})
    ).toBe(2012);
    expect(
      getVodSortValue(movie({ stream_id: 'e', name: 'Great Movie - 2001' }), 'movie', 'year', {})
    ).toBe(2001);
  });

  it('returns -Infinity when no year can be derived', () => {
    expect(getVodSortValue(movie({ stream_id: 'f', name: 'No Year Here' }), 'movie', 'year', {})).toBe(-Infinity);
  });
});

describe('sortVodItems - year', () => {
  const items = [
    movie({ stream_id: 'old', name: 'Old Movie', title: 'Old Movie', year: '1980' }),
    movie({ stream_id: 'new', name: 'New Movie', title: 'New Movie', year: '2021' }),
    movie({ stream_id: 'mid', name: 'Mid Movie', title: 'Mid Movie', year: '2005' }),
    movie({ stream_id: 'unknown', name: 'Unknown Movie', title: 'Unknown Movie' }),
  ];

  it('sorts newest first by default (desc)', () => {
    const sorted = sortVodItems(items, 'movie', 'year', 'desc');
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['new', 'mid', 'old', 'unknown']);
  });

  it('sorts oldest first with asc and puts unknown years at the top', () => {
    const sorted = sortVodItems(items, 'movie', 'year', 'asc');
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['unknown', 'old', 'mid', 'new']);
  });

  it('does not mutate the input array', () => {
    const input = [...items];
    sortVodItems(input, 'movie', 'year', 'desc');
    expect(input.map((m) => (m as any).stream_id)).toEqual(['old', 'new', 'mid', 'unknown']);
  });
});

describe('sortVodItems - name', () => {
  const items = [
    movie({ stream_id: 'z', name: 'Zebra', title: 'Zebra' }),
    movie({ stream_id: 'a', name: 'Apple', title: 'Apple' }),
    movie({ stream_id: 'm', name: 'Mango', title: 'Mango' }),
  ];

  it('sorts A-Z by default (asc)', () => {
    const sorted = sortVodItems(items, 'movie', 'name', 'asc');
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['a', 'm', 'z']);
  });

  it('sorts Z-A with desc', () => {
    const sorted = sortVodItems(items, 'movie', 'name', 'desc');
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['z', 'm', 'a']);
  });
});

describe('sortVodItems - rating', () => {
  const items = [
    movie({ stream_id: 'high', name: 'High', rating: '8.9' }),
    movie({ stream_id: 'low', name: 'Low', rating: '4.2' }),
    movie({ stream_id: 'none', name: 'None', rating: '' }),
    movie({ stream_id: 'five', name: 'Five', rating_5based: 4.5 }),
  ];

  it('sorts highest first by default (desc)', () => {
    const sorted = sortVodItems(items, 'movie', 'rating', 'desc');
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['high', 'five', 'low', 'none']);
  });

  it('prefers rating_5based over the string rating', () => {
    const item = movie({ stream_id: 'x', rating: '8.9', rating_5based: 3.2 });
    expect(getVodSortValue(item, 'movie', 'rating', {})).toBe(3.2);
  });
});

describe('sortVodItems - lastWatched', () => {
  const items = [
    movie({ stream_id: 'old' }),
    movie({ stream_id: 'recent' }),
    movie({ stream_id: 'never' }),
  ];
  const lastWatchedMap = new Map<string, number>([
    ['old', 1000],
    ['recent', 9000],
  ]);

  it('sorts most recently watched first and never-watched last (desc)', () => {
    const sorted = sortVodItems(items, 'movie', 'lastWatched', 'desc', { lastWatchedMap });
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['recent', 'old', 'never']);
  });

  it('sorts least recently watched first with asc', () => {
    const sorted = sortVodItems(items, 'movie', 'lastWatched', 'asc', { lastWatchedMap });
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['never', 'old', 'recent']);
  });
});

describe('sortVodItems - recently added', () => {
  const items = [
    movie({ stream_id: 'older' }),
    movie({ stream_id: 'newer' }),
  ];
  const addedAtMap = new Map<string, number>([
    ['older', 1000],
    ['newer', 9000],
  ]);

  it('sorts newest favorites first (default desc)', () => {
    const sorted = sortVodItems(items, 'movie', 'default', 'desc', { addedAtMap });
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['newer', 'older']);
  });

  it('sorts oldest favorites first with asc', () => {
    const sorted = sortVodItems(items, 'movie', 'default', 'asc', { addedAtMap });
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['older', 'newer']);
  });
});

describe('sortVodItems - source added date', () => {
  const items = [
    movie({ stream_id: 'a', added: '2020-01-01T00:00:00.000Z' }),
    movie({ stream_id: 'b', added: '2023-01-01T00:00:00.000Z' }),
    movie({ stream_id: 'c', added: undefined }),
  ];

  it('sorts newest added first by default (desc)', () => {
    const sorted = sortVodItems(items, 'movie', 'added', 'desc');
    expect(sorted.map((m) => (m as any).stream_id)).toEqual(['b', 'a', 'c']);
  });
});

describe('DEFAULT_SORT_DIRECTION', () => {
  it('defines a sensible direction for every sort key', () => {
    const keys: VodSortKey[] = ['default', 'added', 'name', 'year', 'rating', 'lastWatched'];
    for (const key of keys) {
      expect(['asc', 'desc']).toContain(DEFAULT_SORT_DIRECTION[key]);
    }
  });
});

describe('useSkipIntro - resolveIntroDbParams', () => {
  it('resolves IMDb ID and episode from local file with mediaId/seriesId pattern', async () => {
    const { resolveIntroDbParams } = await import('../../../hooks/useSkipIntro');
    const vodInfo = {
      url: 'C:\\Media\\Shows\\Example Show\\Example.Show.S01E01.1080p.mkv',
      title: 'Example Show',
      type: 'series' as const,
      source_id: 'local',
      mediaId: 'local_tt1234567_ep_local-ep1',
      seriesId: 'local_tt1234567',
      episodeId: 'local-ep1',
      seasonNum: 1,
      episodeNum: 1,
    };

    const params = await resolveIntroDbParams(vodInfo);
    expect(params.imdbId).toBe('tt1234567');
    expect(params.season).toBe(1);
    expect(params.episode).toBe(1);
  });

  it('resolves directly from vodInfo.imdbId', async () => {
    const { resolveIntroDbParams } = await import('../../../hooks/useSkipIntro');
    const vodInfo = {
      url: 'http://example.com/stream.mkv',
      title: 'Example Series',
      type: 'series' as const,
      source_id: 'vod',
      imdbId: 'tt0903747',
      seasonNum: 2,
      episodeNum: 3,
    };

    const params = await resolveIntroDbParams(vodInfo);
    expect(params.imdbId).toBe('tt0903747');
    expect(params.season).toBe(2);
    expect(params.episode).toBe(3);
  });

  it('parses season and episode from filename when seasonNum/episodeNum are missing', async () => {
    const { resolveIntroDbParams } = await import('../../../hooks/useSkipIntro');
    const vodInfo = {
      url: 'C:\\Media\\Shows\\Sample Show\\Sample.Show.S02E05.1080p.mkv',
      title: 'Sample Show',
      type: 'series' as const,
      source_id: 'local',
      mediaId: 'local_tt7654321_ep_sample123',
      seriesId: 'local_tt7654321',
    };

    const params = await resolveIntroDbParams(vodInfo);
    expect(params.imdbId).toBe('tt7654321');
    expect(params.season).toBe(2);
    expect(params.episode).toBe(5);
  });

  it('resolves from Stremio episode metadata ref', async () => {
    const { resolveIntroDbParams } = await import('../../../hooks/useSkipIntro');
    const vodInfo = {
      url: 'http://stremio/stream',
      title: 'Mock Series',
      type: 'series' as const,
      source_id: 'stremio',
    };

    const stremioRef = {
      current: {
        metaId: 'tt4574334',
        name: 'Chapter One',
        videoId: 'tt4574334:1:1',
        season: 1,
        episode: 1,
      },
    };

    const params = await resolveIntroDbParams(vodInfo, stremioRef);
    expect(params.imdbId).toBe('tt4574334');
    expect(params.season).toBe(1);
    expect(params.episode).toBe(1);
  });
});
