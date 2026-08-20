import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFilename, groupLocal, sortGroups, getLocalEpisodeList, addLocalEntries } from '../local-library';
import { movieFileInfo, isGenericMovieName, refreshTmdbEntry, invalidateTmdbIdMatchCache } from '../scan';
import { parseNfo } from '../sidecars';
import type { LocalEntry } from '../types';

describe('Local Library - Filename Parser', () => {
  it('parses movie filenames with year and resolution', () => {
    const res = parseFilename('Inception.2010.1080p.BluRay.x264.mkv');
    expect(res.title).toBe('Inception');
    expect(res.year).toBe(2010);
    expect(res.type).toBe('movie');
    expect(res.resolution).toBe('1080p');
    expect(res.season).toBeNull();
    expect(res.episode).toBeNull();
  });

  it('parses TV show filenames with S01E02 format', () => {
    const res = parseFilename('Breaking.Bad.S01E05.Gray.Matter.720p.HDTV.mkv');
    expect(res.title).toBe('Breaking Bad');
    expect(res.type).toBe('show');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(5);
    expect(res.resolution).toBe('720p');
  });

  it('parses TV show filenames with 1x02 format', () => {
    const res = parseFilename('The.Office.US.2x04.The.Fire.1080p.WEB-DL.mp4');
    expect(res.title).toBe('The Office US');
    expect(res.type).toBe('show');
    expect(res.season).toBe(2);
    expect(res.episode).toBe(4);
  });

  it('parses TV show filenames with Season 1 Episode 2 format', () => {
    const res = parseFilename('Neon Harbor Season 1 Episode 3 2160p UHD.mkv');
    expect(res.title).toBe('Neon Harbor');
    expect(res.type).toBe('show');
    expect(res.season).toBe(1);
    expect(res.episode).toBe(3);
    expect(res.resolution).toBe('2160p');
  });

  it('cleans brackets and release tags', () => {
    const res = parseFilename('[YTS.MX] Interstellar (2014) [1080p] [WEBRip] [5.1] [YIFY].mp4');
    expect(res.title).toBe('Interstellar');
    expect(res.year).toBe(2014);
    expect(res.type).toBe('movie');
    expect(res.resolution).toBe('1080p');
  });

  it('trims movie titles exactly like Jellyfin (CleanDateTime + CleanStrings)', () => {
    const cases: [string, string, number | null][] = [
      // Standard release naming: year cut removes the whole release tail.
      ['The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv', 'The.Matrix', 1999],
      ['Avatar.2009.EXTENDED.1080p.BluRay.x264.mkv', 'Avatar', 2009],
      ['Dune.Part.Two.2024.2160p.HDR10.HEVC.DV.mkv', 'Dune.Part.Two', 2024],
      ['Star.Wars.Episode.IV.A.New.Hope.1977.720p.mkv', 'Star.Wars.Episode.IV.A.New.Hope', 1977],
      // Jellyfin cuts at the first noise token even without a year.
      ['Movie.WEB-DL.APEX.mkv', 'Movie', null],
      ['Movie.Trailer.mkv', 'Movie', null],
      ['Movie.Sample.mkv', 'Movie', null],
      ['Movie - 123.mkv', 'Movie', null],
      // Dots are kept, exactly like Jellyfin (TMDB replaces the title on match).
      ['Casino.Royale.2006.720p.BluRay.DTS.x264-EVO.mkv', 'Casino.Royale', 2006],
      ['The.Godfather.1972.1080p.BluRay.Remux.mkv', 'The.Godfather', 1972],
      // Over-trimming is faithful to Jellyfin ("limited" is a noise token).
      ['The.Limited.Series.2018.1080p.mkv', 'The', 2018],
      ['Toy.Story.3D.2010.1080p.mkv', 'Toy.Story', 2010],
      // Tokens at position 0 cannot trigger Jellyfin's cut, so real titles survive.
      ['xXx.2002.1080p.mkv', 'xXx', 2002],
      ['Cam.2018.1080p.mkv', 'Cam', 2018],
      ['Dual.2022.1080p.mkv', 'Dual', 2022],
    ];
    for (const [input, title, year] of cases) {
      const res = parseFilename(input);
      expect(res.title).toBe(title);
      expect(res.year).toBe(year);
      expect(res.type).toBe('movie');
    }
  });
});

describe('Local Library - Movie folder fallback', () => {
  it('falls back to the parent folder for generic filenames', () => {
    const res = movieFileInfo('/m/Movies/Pulp Fiction/disc1.mkv', 'disc1.mkv', '/m/Movies');
    expect(res.title).toBe('Pulp Fiction');
    expect(res.year).toBeNull();
    expect(res.type).toBe('movie');
  });

  it('uses the scan root when it is a per-movie folder (with year)', () => {
    const res = movieFileInfo('/m/Movies/The Matrix (1999)/movie.mkv', 'movie.mkv', '/m/Movies/The Matrix (1999)');
    expect(res.title).toBe('The Matrix');
    expect(res.year).toBe(1999);
  });

  it('handles Windows paths', () => {
    const res = movieFileInfo('C:\\Movies\\Pulp Fiction\\untitled.mkv', 'untitled.mkv', 'C:\\Movies');
    expect(res.title).toBe('Pulp Fiction');
  });

  it('keeps well-named files untouched', () => {
    const res = movieFileInfo('/m/Movies/Inception/Inception.2010.1080p.mkv', 'Inception.2010.1080p.mkv', '/m/Movies');
    expect(res.title).toBe('Inception');
    expect(res.year).toBe(2010);
  });

  it('does not fall back to a generic parent folder', () => {
    const res = movieFileInfo('/m/Movies/disc1.mkv', 'disc1.mkv', '/m/Movies');
    expect(res.title).toBe('disc1');
  });

  it('isGenericMovieName recognizes file/folder labels', () => {
    expect(isGenericMovieName('disc1')).toBe(true);
    expect(isGenericMovieName('movie')).toBe(true);
    expect(isGenericMovieName('Movies')).toBe(true);
    expect(isGenericMovieName('123')).toBe(true);
    expect(isGenericMovieName('Pulp Fiction')).toBe(false);
    expect(isGenericMovieName('The Matrix')).toBe(false);
  });
});

describe('Local Library - Grouping & Sorting', () => {
  const mockEntries: LocalEntry[] = [
    {
      id: '1',
      path: '/movies/Avatar.2009.mkv',
      filename: 'Avatar.2009.mkv',
      title: 'Avatar',
      year: 2009,
      type: 'movie',
      rating: 7.9,
      addedAt: 1000,
    },
    {
      id: '2',
      path: '/tv/Loki.S01E01.mkv',
      filename: 'Loki.S01E01.mkv',
      title: 'Loki',
      year: 2021,
      type: 'show',
      season: 1,
      episode: 1,
      rating: 8.2,
      addedAt: 2000,
    },
    {
      id: '3',
      path: '/tv/Loki.S01E02.mkv',
      filename: 'Loki.S01E02.mkv',
      title: 'Loki',
      year: 2021,
      type: 'show',
      season: 1,
      episode: 2,
      rating: 8.2,
      addedAt: 3000,
    },
  ];

  it('groups movies individually and series by title/id', () => {
    const groups = groupLocal(mockEntries);
    expect(groups).toHaveLength(2);

    const movieGroup = groups.find((g) => g.kind === 'movie');
    expect(movieGroup).toBeDefined();
    if (movieGroup?.kind === 'movie') {
      expect(movieGroup.entry.title).toBe('Avatar');
    }

    const showGroup = groups.find((g) => g.kind === 'show');
    expect(showGroup).toBeDefined();
    if (showGroup?.kind === 'show') {
      expect(showGroup.head.title).toBe('Loki');
      expect(showGroup.episodes).toHaveLength(2);
      expect(showGroup.episodes[0].episode).toBe(1);
      expect(showGroup.episodes[1].episode).toBe(2);
    }
  });

  it('sorts groups by rating descending and ascending', () => {
    const groups = groupLocal(mockEntries);
    const sortedDesc = sortGroups(groups, 'rating', 'desc');
    expect(sortedDesc[0].kind === 'show' ? sortedDesc[0].head.title : sortedDesc[0].entry.title).toBe('Loki');

    const sortedAsc = sortGroups(groups, 'rating', 'asc');
    expect(sortedAsc[0].kind === 'movie' ? sortedAsc[0].entry.title : sortedAsc[0].head.title).toBe('Avatar');
  });

  it('collapses all unmatched episodes of a series folder into ONE review group', () => {
    // A failed series-folder scan marks every episode needsReview with the
    // same folder-derived title — so 500 episodes of one show must count as a
    // single review unit, not 500 files.
    const entries: LocalEntry[] = [];
    for (let i = 1; i <= 500; i++) {
      entries.push({
        id: `a-${i}`,
        path: `T:/Series/Night.Shift/Night.Shift.S01E${String(i).padStart(2, '0')}.mkv`,
        filename: `Night.Shift.S01E${String(i).padStart(2, '0')}.mkv`,
        title: 'Night Shift',
        year: null,
        type: 'show',
        season: 1,
        episode: i,
        addedAt: i,
        needsReview: true,
      });
    }
    for (let i = 1; i <= 16; i++) {
      entries.push({
        id: `q-${i}`,
        path: `T:/Series/Starlit Cove/Starlit.Cove.S01E${String(i).padStart(2, '0')}.mkv`,
        filename: `Starlit.Cove.S01E${String(i).padStart(2, '0')}.mkv`,
        title: 'Starlit Cove',
        year: null,
        type: 'show',
        season: 1,
        episode: i,
        addedAt: 1000 + i,
        needsReview: true,
      });
    }

    const groups = groupLocal(entries);
    // Two series folders -> exactly two review units, regardless of 516 files.
    expect(groups).toHaveLength(2);
    const showGroups = groups.filter((g) => g.kind === 'show');
    expect(showGroups).toHaveLength(2);
    if (showGroups[0].kind === 'show' && showGroups[1].kind === 'show') {
      const titles = [showGroups[0].head.title, showGroups[1].head.title].sort();
      expect(titles).toEqual(['Night Shift', 'Starlit Cove']);
      expect(showGroups[0].episodes.length + showGroups[1].episodes.length).toBe(516);
      // Every episode in each group is a review item.
      expect(showGroups.every((g) => g.episodes.every((e) => e.needsReview))).toBe(true);
    }
  });

  it('merges episodes from two separate folders of the same show into one series, in the right seasons', () => {
    // Folder A holds Season 1, Folder B holds Season 2 — both matched to the
    // same TMDB series (same tmdbId), with season/episode from the filenames.
    const entries: LocalEntry[] = [
      {
        id: 'A/S01E01.mkv',
        path: 'T:/Shows/Neon Harbor/Season 1/Neon.Harbor.S01E01.mkv',
        filename: 'Neon.Harbor.S01E01.mkv',
        title: 'Neon Harbor',
        year: 2016,
        type: 'show',
        season: 1,
        episode: 1,
        tmdbId: 66732,
        addedAt: 1000,
      },
      {
        id: 'A/S01E02.mkv',
        path: 'T:/Shows/Neon Harbor/Season 1/Neon.Harbor.S01E02.mkv',
        filename: 'Neon.Harbor.S01E02.mkv',
        title: 'Neon Harbor',
        year: 2016,
        type: 'show',
        season: 1,
        episode: 2,
        tmdbId: 66732,
        addedAt: 2000,
      },
      {
        id: 'B/S02E01.mkv',
        path: 'U:/More Shows/Neon Harbor/Season 2/Neon.Harbor.S02E01.mkv',
        filename: 'Neon.Harbor.S02E01.mkv',
        title: 'Neon Harbor',
        year: 2016,
        type: 'show',
        season: 2,
        episode: 1,
        tmdbId: 66732,
        addedAt: 3000,
      },
    ];

    const groups = groupLocal(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('show');
    if (groups[0].kind === 'show') {
      expect(groups[0].episodes).toHaveLength(3);
      // Sorted by season then episode regardless of add order / folder.
      expect(groups[0].episodes.map((e) => `${e.season}:${e.episode}`)).toEqual([
        '1:1',
        '1:2',
        '2:1',
      ]);
    }
  });
});

describe('Local Library - NFO Parser', () => {
  it('parses movie XML NFO correctly', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Fight Club</title>
  <year>1999</year>
  <plot>An insomniac office worker and a devil-may-care soap maker form an underground fight club.</plot>
  <rating>8.8</rating>
  <runtime>139</runtime>
  <uniqueid type="tmdb" default="true">550</uniqueid>
  <uniqueid type="imdb">tt0137523</uniqueid>
</movie>`;

    const parsed = parseNfo(xml);
    expect(parsed.title).toBe('Fight Club');
    expect(parsed.year).toBe(1999);
    expect(parsed.rating).toBe(8.8);
    expect(parsed.runtime).toBe(139);
    expect(parsed.tmdbId).toBe(550);
    expect(parsed.imdbId).toBe('tt0137523');
    expect(parsed.plot).toContain('underground fight club');
  });

  it('parses tvshow XML NFO correctly', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>Severance</title>
  <premiered>2022-02-18</premiered>
  <plot>Mark leads a team of office workers whose memories have been surgically divided.</plot>
  <tmdbid>95396</tmdbid>
  <imdbid>tt11280740</imdbid>
</tvshow>`;

    const parsed = parseNfo(xml);
    expect(parsed.title).toBe('Severance');
    expect(parsed.year).toBe(2022);
    expect(parsed.tmdbId).toBe(95396);
    expect(parsed.imdbId).toBe('tt11280740');
  });
});

describe('Local Library - Folder Management', () => {
  it('adds typed folders and removes them properly', async () => {
    const { addScannedFolder, readScannedFolders, removeScannedFolder, addLocalEntries, readLocalLibrary } = await import('../local-library');

    addScannedFolder('T:/Media/Movies', 'movie');
    addScannedFolder('T:/Media/TV', 'show');
    expect(readScannedFolders().some((f) => f.path === 'T:/Media/Movies' && f.type === 'movie')).toBe(true);
    expect(readScannedFolders().some((f) => f.path === 'T:/Media/TV' && f.type === 'show')).toBe(true);

    addLocalEntries([
      {
        id: 'T:/Media/Movies/Alien.1979.mkv',
        path: 'T:/Media/Movies/Alien.1979.mkv',
        filename: 'Alien.1979.mkv',
        title: 'Alien',
        year: 1979,
        type: 'movie',
        addedAt: Date.now(),
      },
    ]);
    expect(readLocalLibrary().some((e) => e.title === 'Alien')).toBe(true);

    removeScannedFolder('T:/Media/Movies');
    expect(readScannedFolders().some((f) => f.path === 'T:/Media/Movies')).toBe(false);
    expect(readLocalLibrary().some((e) => e.title === 'Alien')).toBe(false);
  });

  it('defaults legacy folders to mixed type', async () => {
    const { addScannedFolder, readScannedFolders } = await import('../local-library');
    addScannedFolder('T:/Legacy');
    const folder = readScannedFolders().find((f) => f.path === 'T:/Legacy');
    expect(folder?.type).toBe('mixed');
  });
});

describe('Local Library - Series Path Parsing', () => {
  it('parses a series folder with Season subfolders', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/TV/Breaking Bad/Season 2/Breaking.Bad.S02E03.mkv',
      'T:/TV',
    );
    expect(info).toEqual({
      title: 'Breaking Bad',
      year: null,
      season: 2,
      episode: 3,
      resolution: null,
    });
  });

  it('parses flat episodes inside a series folder', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/TV/The Office US/The.Office.US.S01E01.1080p.mkv',
      'T:/TV',
    );
    expect(info?.title).toBe('The Office US');
    expect(info?.season).toBe(1);
    expect(info?.episode).toBe(1);
    expect(info?.resolution).toBe('1080p');
  });

  it('handles a single series folder as the scan root', async () => {
    const { parseSeriesPath } = await import('../scan');
    // Root itself is a series with Season subfolders.
    const nested = parseSeriesPath(
      'T:/TV/Severance/Season 1/Severance.S01E02.mkv',
      'T:/TV/Severance',
    );
    expect(nested?.title).toBe('Severance');
    expect(nested?.season).toBe(1);
    expect(nested?.episode).toBe(2);

    // Root itself is a series with flat episodes.
    const flat = parseSeriesPath('T:/TV/Severance/Severance.S01E01.mkv', 'T:/TV/Severance');
    expect(flat?.title).toBe('Severance');
    expect(flat?.season).toBe(1);
    expect(flat?.episode).toBe(1);
  });

  it('extracts a trailing year from the series folder name', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/TV/Breaking Bad (2008)/Season 1/Breaking.Bad.S01E01.mkv',
      'T:/TV',
    );
    expect(info?.title).toBe('Breaking Bad');
    expect(info?.year).toBe(2008);
  });

  it('maps Specials subfolders to season 0', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/TV/Show/Specials/Show.S00E01.mkv',
      'T:/TV',
    );
    expect(info?.season).toBe(0);
  });

  it('strips release metadata from release-style folder names', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/Series/Night.Shift.S01.1080p.DSNP.WEB-DL.DDP5.1.H.264-APEX/Night.Shift.S01E01.mkv',
      'T:/Series',
    );
    expect(info?.title).toBe('Night Shift');
    expect(info?.season).toBe(1);
    expect(info?.episode).toBe(1);
  });

  it('extracts a mid-name year and strips codecs from release-style folders', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/Series/Ember.2026.S01.1080p.WEB-DL.AAC2.0.H.264-MrHulk/Ember.S01E01.mkv',
      'T:/Series',
    );
    expect(info?.title).toBe('Ember');
    expect(info?.year).toBe(2026);
  });

  it('strips leading bracket tags and release groups', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/Series/[SBS] The.Outsider.2012.S01.1080p.WEB-DL.H264.AAC-AppleTor/The.Outsider.S01E01.mkv',
      'T:/Series',
    );
    expect(info?.title).toBe('The Outsider');
    expect(info?.year).toBe(2012);
  });

  it('detects per-season release subfolders via Sxx in the path', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/Series/Night Owl Bar/Night.Owl.Bar.S01.1080.AMZN.WEB-DL.DDP2.0.H.264-GBK/Night.Owl.Bar.S01E01.mkv',
      'T:/Series',
    );
    expect(info?.title).toBe('Night Owl Bar');
    expect(info?.season).toBe(1);
  });

  it('keeps clean names untouched', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/Series/Starlit Cove/Season 1/Starlit.Cove.S01E01.mkv',
      'T:/Series',
    );
    expect(info?.title).toBe('Starlit Cove');
    expect(info?.season).toBe(1);
  });

  it('cuts a release-style folder name at the season marker', async () => {
    const { parseSeriesPath } = await import('../scan');
    const info = parseSeriesPath(
      'T:/Series/Silver.Harbor.2024.S01.1080p.VIKI.WEB-DL.AAC2.0.H.264-GROUP/Silver.Harbor.S01E01.mkv',
      'T:/Series',
    );
    expect(info?.title).toBe('Silver Harbor');
    expect(info?.year).toBe(2024);
    expect(info?.season).toBe(1);
    expect(info?.episode).toBe(1);
  });

  it('keeps CJK titles and strips the rest of a release folder name', async () => {
    const { parseTitleFolder } = await import('../scan');
    expect(parseTitleFolder('明月.Bright.Moon.S01.2024.2160p.IQ.WEB-DL.H265.DDP5.1-GROUP')).toEqual({
      title: '明月 Bright Moon',
      year: 2024,
    });
  });

  it('does not truncate hyphenated English titles', async () => {
    const { parseTitleFolder } = await import('../scan');
    expect(parseTitleFolder('Wild-Flower 2023')).toEqual({ title: 'Wild Flower', year: 2023 });
  });

  it('leaves a plain title folder untouched', async () => {
    const { parseTitleFolder } = await import('../scan');
    expect(parseTitleFolder('Lakeside')).toEqual({ title: 'Lakeside', year: null });
  });
});

describe('Local Library - Episode Navigation', () => {
  const ep = (id: string, season: number, episode: number): LocalEntry => ({
    id,
    path: `T:/Media/Show/S${season}E${episode}.mkv`,
    filename: `S${season}E${episode}.mkv`,
    title: 'Show',
    year: 2020,
    type: 'show',
    season,
    episode,
    addedAt: 1,
    needsReview: false,
  });

  it('orders episodes by season then episode (next season rolls to its first episode)', () => {
    // Seed out of order on purpose: S2E1, S1E2, S1E1.
    addLocalEntries([ep('s2e1', 2, 1), ep('s1e2', 1, 2), ep('s1e1', 1, 1)]);
    const list = getLocalEpisodeList('s1e2');
    expect(list?.map((e) => e.id)).toEqual(['s1e1', 's1e2', 's2e1']);

    // First episode: no previous. Last episode of S1: next is S2E1 (first of
    // the following season) via the flat ordering.
    const idx = list!.findIndex((e) => e.id === 's1e2');
    expect(idx).toBe(1);
    expect(getLocalEpisodeList('s1e1')!.length).toBe(3);
  });

  it('returns null for unknown or non-series episode ids', () => {
    expect(getLocalEpisodeList('does-not-exist')).toBeNull();
    addLocalEntries([{ ...ep('m1', 1, 1), id: 'm1', type: 'movie', season: null, episode: null }]);
    expect(getLocalEpisodeList('m1')).toBeNull();
  });
});

describe('Local Library - Undo & Locked Overrides', () => {
  it('undo restores removed entries', async () => {
    const { addLocalEntries, removeLocalEntries, readLocalLibrary, undoLocalChange, hasUndo } = await import('../local-library');
    addLocalEntries([{
      id: 'u1', path: 'T:/movie1.mkv', filename: 'movie1.mkv', title: 'Movie 1', year: 2020, type: 'movie', addedAt: 1,
    }]);
    expect(readLocalLibrary().some((e) => e.id === 'u1')).toBe(true);
    removeLocalEntries(['u1']);
    expect(readLocalLibrary().some((e) => e.id === 'u1')).toBe(false);
    expect(hasUndo()).toBe(true);
    expect(undoLocalChange()).toBe(true);
    expect(readLocalLibrary().some((e) => e.id === 'u1')).toBe(true);
  });

  it('undo restores edited season/episode', async () => {
    const { addLocalEntries, updateLocalEntries, readLocalLibrary, undoLocalChange, hasUndo } = await import('../local-library');
    addLocalEntries([{
      id: 'u2', path: 'T:/show.mkv', filename: 'show.mkv', title: 'Show', year: 2020, type: 'show', season: 1, episode: 1, addedAt: 1,
    }]);
    updateLocalEntries(['u2'], { season: 5, episode: 9, metadataLocked: true });
    expect(readLocalLibrary().find((e) => e.id === 'u2')?.episode).toBe(9);
    expect(undoLocalChange()).toBe(true);
    expect(hasUndo()).toBe(false);
    const restored = readLocalLibrary().find((e) => e.id === 'u2');
    expect(restored?.season).toBe(1);
    expect(restored?.episode).toBe(1);
    expect(restored?.metadataLocked).toBeUndefined();
  });

  it('locked entries keep manual season/episode/title across a re-scan (addLocalEntries merge)', async () => {
    const { addLocalEntries, readLocalLibrary, updateLocalEntries } = await import('../local-library');
    addLocalEntries([{
      id: 'l1', path: 'T:/Shows/Show/Show.S01E02.mkv', filename: 'Show.S01E02.mkv', title: 'Show', year: 2020, type: 'show', season: 1, episode: 2, tmdbId: 123, addedAt: 1,
    }]);
    // User fixes the misdetected season/episode.
    updateLocalEntries(['l1'], { season: 2, episode: 5, metadataLocked: true });

    // A re-scan rebuilds the entry from scratch with the original (wrong) parse.
    addLocalEntries([{
      id: 'l1', path: 'T:/Shows/Show/Show.S01E02.mkv', filename: 'Show.S01E02.mkv', title: 'Show', year: 2020, type: 'show', season: 1, episode: 2, tmdbId: 999, addedAt: 999,
    }]);

    const after = readLocalLibrary().find((e) => e.id === 'l1')!;
    expect(after.season).toBe(2); // user override kept
    expect(after.episode).toBe(5); // user override kept
    expect(after.tmdbId).toBe(123); // match identity kept
    expect(after.metadataLocked).toBe(true);
    expect(after.addedAt).toBe(1); // not bumped to "Recently Added"
  });

  it('unlocked entries are still overwritten by a re-scan', async () => {
    const { addLocalEntries, readLocalLibrary } = await import('../local-library');
    addLocalEntries([{
      id: 'u3', path: 'T:/Shows/Other Show/Show.S01E02.mkv', filename: 'Show.S01E02.mkv', title: 'Show', year: 2020, type: 'show', season: 1, episode: 2, tmdbId: 123, addedAt: 1,
    }]);
    addLocalEntries([{
      id: 'u3', path: 'T:/Shows/Other Show/Show.S01E02.mkv', filename: 'Show.S01E02.mkv', title: 'Show', year: 2020, type: 'show', season: 3, episode: 7, tmdbId: 999, addedAt: 999,
    }]);
    const after = readLocalLibrary().find((e) => e.id === 'u3')!;
    expect(after.season).toBe(3);
    expect(after.episode).toBe(7);
    expect(after.tmdbId).toBe(999);
    expect(after.addedAt).toBe(999);
  });

  it('skipped entries keep their parsed identity across a re-scan (no auto-match)', async () => {
    const { addLocalEntries, readLocalLibrary, updateLocalEntries } = await import('../local-library');
    addLocalEntries([{
      id: 's1', path: 'T:/Skipped Movie.mkv', filename: 'Skipped Movie.mkv', title: 'Skipped Movie', year: 2021, type: 'movie', addedAt: 1, needsReview: true,
    }]);
    // User skips matching from the review flow.
    updateLocalEntries(['s1'], { needsReview: false, reviewSkipped: true });

    // A re-scan rebuilds the entry and a TMDB lookup would have matched it.
    addLocalEntries([{
      id: 's1', path: 'T:/Skipped Movie.mkv', filename: 'Skipped Movie.mkv', title: 'Matched Title', year: 1999, type: 'movie', tmdbId: 777, imdbId: 'tt0777', poster: 'http://x/p.jpg', addedAt: 999,
    }]);

    const after = readLocalLibrary().find((e) => e.id === 's1')!;
    expect(after.reviewSkipped).toBe(true); // skip survives the re-scan
    expect(after.tmdbId).toBeUndefined(); // no metadata attached
    expect(after.title).toBe('Skipped Movie'); // parsed identity kept
    expect(after.needsReview).toBe(false); // still excluded from review
  });

  it('reviewSkipped flag round-trips through the store and undo restores it', async () => {
    const { addLocalEntries, readLocalLibrary, updateLocalEntries, undoLocalChange } = await import('../local-library');
    addLocalEntries([{
      id: 's2', path: 'T:/Skip Round Trip.mkv', filename: 'Skip Round Trip.mkv', title: 'Skip Round Trip', year: 2022, type: 'movie', addedAt: 1, needsReview: true,
    }]);
    expect(readLocalLibrary().find((e) => e.id === 's2')?.reviewSkipped).toBeUndefined();
    // Skip from the review flow.
    updateLocalEntries(['s2'], { needsReview: false, reviewSkipped: true });
    expect(readLocalLibrary().find((e) => e.id === 's2')?.reviewSkipped).toBe(true);
    expect(readLocalLibrary().find((e) => e.id === 's2')?.needsReview).toBe(false);
    // Undo restores the pre-skip state.
    expect(undoLocalChange()).toBe(true);
    const restored = readLocalLibrary().find((e) => e.id === 's2')!;
    expect(restored.reviewSkipped).toBeUndefined();
    expect(restored.needsReview).toBe(true);
  });
});

describe('Local Library - Metadata Cache', () => {
  it('reads cached cast and season episodes from storage without network', async () => {
    const { getCachedCast, getCachedSeasonEpisodes } = await import('../metadata-cache');

    localStorage.setItem('ynotv.local.cache.cast.movie_550', JSON.stringify([
      { id: 1, name: 'Brad Pitt', character: 'Tyler Durden', profilePath: null },
    ]));

    const cast = await getCachedCast(550, 'movie', null);
    expect(cast).toHaveLength(1);
    expect(cast[0].name).toBe('Brad Pitt');

    localStorage.setItem('ynotv.local.cache.season.95396_s1', JSON.stringify([
      { episode_number: 1, name: 'Good News About Hell', overview: 'Mark Scout leads...', still_path: null },
    ]));

    const episodes = await getCachedSeasonEpisodes(95396, 1, null);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].name).toBe('Good News About Hell');
  });
});

describe('Local Library - Auto Sync', () => {
  it('skips sync when no folders are configured', async () => {
    const { syncLocalFolders } = await import('../auto-sync');
    const { removeScannedFolder } = await import('../local-library');
    // The folder-management test above added a folder to the shared in-memory
    // store — clear it so this test exercises the "no folders" path.
    removeScannedFolder('T:/Media/Movies');
    const res = await syncLocalFolders(null, true);
    expect(res).toEqual({ added: 0, removed: 0 });
  });
});

describe('Local Library - VOD Stored Converters', () => {
  it('converts LocalEntry to StoredMovie correctly', async () => {
    const { localEntryToStoredMovie } = await import('../local-library');
    const movieEntry: LocalEntry = {
      id: 'T:/Movies/Gladiator.2000.mkv',
      path: 'T:/Movies/Gladiator.2000.mkv',
      filename: 'Gladiator.2000.mkv',
      title: 'Gladiator',
      year: 2000,
      type: 'movie',
      rating: 8.5,
      runtime: 155,
      poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      overview: 'A former Roman General sets out to exact vengeance.',
      addedAt: 1600000000000,
      tmdbId: 98,
      imdbId: 'tt0172495',
    };

    const stored = localEntryToStoredMovie(movieEntry);
    expect(stored.stream_id).toBe('local_T:/Movies/Gladiator.2000.mkv');
    expect(stored.source_id).toBe('local');
    expect(stored.title).toBe('Gladiator');
    expect(stored.name).toBe('Gladiator');
    expect(stored.year).toBe('2000');
    expect(stored.rating).toBe('8.5');
    expect(stored.duration).toBe(155 * 60);
    expect(stored.direct_url).toBe('T:/Movies/Gladiator.2000.mkv');
    expect(stored.tmdb_id).toBe(98);
    expect(stored.imdb_id).toBe('tt0172495');
    expect(stored.stream_icon).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
    expect(stored.plot).toBe('A former Roman General sets out to exact vengeance.');
  });

describe('Local Library - Playlist & Favorite Cleanup', () => {
  it('removes movie favorites/playlist items when the movie is removed', async () => {
    const { addLocalEntries, removeLocalEntries } = await import('../local-library');
    const { useVodFavoritesStore } = await import('../../../stores/vodFavoritesStore');
    const { useVodPlaylistStore } = await import('../../../stores/vodPlaylistStore');

    const movieId = 'T:/Cleanup/Gladiator.2000.mkv';
    addLocalEntries([{
      id: movieId, path: movieId, filename: 'Gladiator.2000.mkv', title: 'Gladiator', year: 2000, type: 'movie', addedAt: 1,
    }]);

    const fav = useVodFavoritesStore.getState();
    const pl = useVodPlaylistStore.getState();
    const playlist = pl.createPlaylist('Cleanup Test');

    fav.addFavorite({ id: `local_${movieId}`, type: 'movie', title: 'Gladiator' });
    pl.addItemToPlaylist(playlist.id, {
      itemType: 'movie',
      mediaId: `local_${movieId}`,
      title: 'Gladiator',
      directUrl: movieId,
      sourceId: 'local',
    });

    expect(useVodFavoritesStore.getState().isFavorite(`local_${movieId}`, 'movie')).toBe(true);
    expect(useVodPlaylistStore.getState().playlists[0].items).toHaveLength(1);

    removeLocalEntries([movieId]);

    expect(useVodFavoritesStore.getState().isFavorite(`local_${movieId}`, 'movie')).toBe(false);
    expect(useVodPlaylistStore.getState().playlists[0].items).toHaveLength(0);
  });

  it('keeps the series favorite when a single episode is removed, drops it with the last episode', async () => {
    const { addLocalEntries, removeLocalEntries } = await import('../local-library');
    const { useVodFavoritesStore } = await import('../../../stores/vodFavoritesStore');
    const { useVodPlaylistStore } = await import('../../../stores/vodPlaylistStore');

    const ep1 = 'T:/Cleanup/Show/S01E01.mkv';
    const ep2 = 'T:/Cleanup/Show/S01E02.mkv';
    addLocalEntries([
      { id: ep1, path: ep1, filename: 'S01E01.mkv', title: 'Cleanup Show', year: 2020, type: 'show', season: 1, episode: 1, addedAt: 1 },
      { id: ep2, path: ep2, filename: 'S01E02.mkv', title: 'Cleanup Show', year: 2020, type: 'show', season: 1, episode: 2, addedAt: 2 },
    ]);

    const seriesId = 'local_cleanup show';
    const fav = useVodFavoritesStore.getState();
    const pl = useVodPlaylistStore.getState();
    const playlist = pl.createPlaylist('Cleanup Show Playlist');

    fav.addFavorite({ id: seriesId, type: 'series', title: 'Cleanup Show' });
    pl.addItemsToPlaylist(playlist.id, [
      { itemType: 'episode', mediaId: ep1, seriesId, title: 'Cleanup Show - S01E01', directUrl: ep1, sourceId: 'local', seasonNum: 1, episodeNum: 1 },
      { itemType: 'episode', mediaId: ep2, seriesId, title: 'Cleanup Show - S01E02', directUrl: ep2, sourceId: 'local', seasonNum: 1, episodeNum: 2 },
    ]);

    // Removing one episode keeps the show favorite but drops that episode.
    removeLocalEntries([ep1]);
    expect(useVodFavoritesStore.getState().isFavorite(seriesId, 'series')).toBe(true);
    expect(useVodPlaylistStore.getState().playlists[0].items.map((i) => i.mediaId)).toEqual([ep2]);

    // Removing the last episode removes the show favorite and the last item.
    removeLocalEntries([ep2]);
    expect(useVodFavoritesStore.getState().isFavorite(seriesId, 'series')).toBe(false);
    expect(useVodPlaylistStore.getState().playlists[0].items).toHaveLength(0);
  });
});

  it('converts LocalGroup to StoredSeries correctly', async () => {
    const { localGroupToStoredSeries, localEntryToStoredEpisode } = await import('../local-library');
    const headEntry: LocalEntry = {
      id: 'T:/Shows/Dark/S01E01.mkv',
      path: 'T:/Shows/Dark/S01E01.mkv',
      filename: 'Dark.S01E01.mkv',
      title: 'Dark',
      year: 2017,
      type: 'show',
      season: 1,
      episode: 1,
      rating: 8.7,
      poster: 'https://image.tmdb.org/t/p/w500/dark.jpg',
      overview: 'A family saga with a supernatural twist.',
      addedAt: 1600000000000,
      tmdbId: 70523,
    };

    const ep2Entry: LocalEntry = {
      id: 'T:/Shows/Dark/S01E02.mkv',
      path: 'T:/Shows/Dark/S01E02.mkv',
      filename: 'Dark.S01E02.mkv',
      title: 'Lies',
      year: 2017,
      type: 'show',
      season: 1,
      episode: 2,
      addedAt: 1600000001000,
    };

    const group = {
      key: 'dark',
      head: headEntry,
      episodes: [headEntry, ep2Entry],
    };

    const storedSeries = localGroupToStoredSeries(group);
    expect(storedSeries.series_id).toBe('local_dark');
    expect(storedSeries.source_id).toBe('local');
    expect(storedSeries.title).toBe('Dark');
    expect(storedSeries.year).toBe('2017');
    expect(storedSeries.rating).toBe('8.7');
    expect(storedSeries.cover).toBe('https://image.tmdb.org/t/p/w500/dark.jpg');
    expect(storedSeries.plot).toBe('A family saga with a supernatural twist.');

    const ep1Stored = localEntryToStoredEpisode(headEntry, storedSeries.series_id, storedSeries.title);
    expect(ep1Stored.id).toBe(headEntry.id);
    expect(ep1Stored.series_id).toBe('local_dark');
    expect(ep1Stored.season_num).toBe(1);
    expect(ep1Stored.episode_num).toBe(1);
    expect(ep1Stored.title).toBe('Episode 1');
    expect(ep1Stored.direct_url).toBe('T:/Shows/Dark/S01E01.mkv');

    const ep2Stored = localEntryToStoredEpisode(ep2Entry, storedSeries.series_id, storedSeries.title);
    expect(ep2Stored.title).toBe('Lies');
    expect(ep2Stored.episode_num).toBe(2);
  });

  it('filters local movies and series by search query', async () => {
    const { matchesSearch } = await import('../../../utils/searchNormalization');
    const { groupLocal } = await import('../local-library');

    const library: LocalEntry[] = [
      {
        id: '1',
        path: 'T:/Movies/Inception.2010.mkv',
        filename: 'Inception.2010.mkv',
        title: 'Inception',
        year: 2010,
        type: 'movie',
        addedAt: 1000,
      },
      {
        id: '2',
        path: 'T:/Movies/Interstellar.2014.mkv',
        filename: 'Interstellar.2014.mkv',
        title: 'Interstellar',
        year: 2014,
        type: 'movie',
        addedAt: 2000,
      },
      {
        id: '3',
        path: 'T:/Shows/Severance/S01E01.mkv',
        filename: 'Severance.S01E01.mkv',
        title: 'Severance',
        year: 2022,
        type: 'show',
        season: 1,
        episode: 1,
        addedAt: 3000,
      },
    ];

    // Search movies for 'cept'
    const movieMatches = library.filter(
      (e) => e.type !== 'show' && (matchesSearch(e.title, 'cept') || matchesSearch(e.filename, 'cept'))
    );
    expect(movieMatches).toHaveLength(1);
    expect(movieMatches[0].title).toBe('Inception');

    // Search series for 'sever'
    const groups = groupLocal(library);
    const seriesMatches = groups.filter(
      (g) =>
        g.kind === 'show' &&
        (matchesSearch(g.head.title, 'sever') ||
          matchesSearch(g.head.filename, 'sever') ||
          g.episodes.some((ep) => matchesSearch(ep.title, 'sever') || matchesSearch(ep.filename, 'sever')))
    );
    expect(seriesMatches).toHaveLength(1);
    if (seriesMatches[0].kind === 'show') {
      expect(seriesMatches[0].head.title).toBe('Severance');
    }
  });

  it('extracts episode and season numbers from various filename conventions', async () => {
    const { extractEpisodeNumber } = await import('../local-library');

    expect(extractEpisodeNumber('S1E24 DRAMA ENG SUB.mp4')).toEqual({ season: 1, episode: 24 });
    expect(extractEpisodeNumber('Show.Name.S02E08.720p.mkv')).toEqual({ season: 2, episode: 8 });
    expect(extractEpisodeNumber('Drama_EP12_1080p.mp4')).toEqual({ season: 1, episode: 12 });
    expect(extractEpisodeNumber('Drama.Ep.05.mkv')).toEqual({ season: 1, episode: 5 });
    expect(extractEpisodeNumber('Show Name - 03 - Episode Title.mkv')).toEqual({ season: 1, episode: 3 });
  });

  it('batches multiple files into a single unified Series group', async () => {
    const { groupLocal, extractEpisodeNumber } = await import('../local-library');

    const unassignedFiles: LocalEntry[] = [
      {
        id: '1',
        path: '/dramas/S1E01 DRAMA.mp4',
        filename: 'S1E01 DRAMA.mp4',
        title: 'S1E01 DRAMA',
        year: null,
        type: 'movie',
        needsReview: true,
        addedAt: 1000,
      },
      {
        id: '2',
        path: '/dramas/S1E02 DRAMA.mp4',
        filename: 'S1E02 DRAMA.mp4',
        title: 'S1E02 DRAMA',
        year: null,
        type: 'movie',
        needsReview: true,
        addedAt: 2000,
      },
      {
        id: '3',
        path: '/dramas/S1E03 DRAMA.mp4',
        filename: 'S1E03 DRAMA.mp4',
        title: 'S1E03 DRAMA',
        year: null,
        type: 'movie',
        needsReview: true,
        addedAt: 3000,
      },
    ];

    // Simulate batch identification
    const identified = unassignedFiles.map((f) => {
      const ep = extractEpisodeNumber(f.filename);
      return {
        ...f,
        tmdbId: 99999,
        title: 'Golden Harbor',
        type: 'show' as const,
        season: ep?.season ?? 1,
        episode: ep?.episode ?? 1,
        needsReview: false,
        poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
      };
    });

    const groups = groupLocal(identified);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('show');
    if (groups[0].kind === 'show') {
      expect(groups[0].head.title).toBe('Golden Harbor');
      expect(groups[0].episodes).toHaveLength(3);
      expect(groups[0].episodes[0].episode).toBe(1);
      expect(groups[0].episodes[1].episode).toBe(2);
      expect(groups[0].episodes[2].episode).toBe(3);
    }
  });
});

describe('Local Library - Refresh Metadata by TMDB ID', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('fetches directly by tmdbId for existing linked entries without re-searching filename', async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);

      if (url.includes('/3/tv/1399')) {
        return {
          ok: true,
          json: async () => ({
            id: 1399,
            name: 'Game of Thrones',
            first_air_date: '2011-04-17',
            poster_path: '/u3bZgnGQ9T01sWNhyveQz0wH0Hl.jpg',
            backdrop_path: '/suopoADq0k8YZr4dQXcU6p0Yq6x.jpg',
            overview: 'Seven noble families fight for control of the mythical land of Westeros.',
            vote_average: 8.4,
            episode_run_time: [60],
            external_ids: { imdb_id: 'tt0944947' },
          }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => ({}) } as unknown as Response;
    });

    const entry: LocalEntry = {
      id: 'ep1',
      path: '/media/random_filename_unrelated.mkv',
      filename: 'random_filename_unrelated.mkv',
      title: 'Game of Thrones',
      year: 2011,
      type: 'show',
      season: 1,
      episode: 1,
      tmdbId: 1399,
      metadataLocked: true,
      addedAt: 12345,
    };

    const refreshed = await refreshTmdbEntry(entry, 'mock-token');

    // Should NOT search by query
    expect(fetchedUrls.some((u) => u.includes('/search/'))).toBe(false);
    // Should call TMDB /tv/1399
    expect(fetchedUrls.some((u) => u.includes('/3/tv/1399'))).toBe(true);

    // Verify refreshed fields
    expect(refreshed.tmdbId).toBe(1399);
    expect(refreshed.imdbId).toBe('tt0944947');
    expect(refreshed.poster).toBe('https://image.tmdb.org/t/p/w342/u3bZgnGQ9T01sWNhyveQz0wH0Hl.jpg');
    expect(refreshed.backdrop).toBe('https://image.tmdb.org/t/p/w1280/suopoADq0k8YZr4dQXcU6p0Yq6x.jpg');
    expect(refreshed.overview).toBe('Seven noble families fight for control of the mythical land of Westeros.');
    expect(refreshed.season).toBe(1);
    expect(refreshed.episode).toBe(1);
    expect(refreshed.metadataLocked).toBe(true);
  });

  it('reuses cached ID lookup for multiple episodes of the same show', async () => {
    let apiCallCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/3/tv/2000')) {
        apiCallCount++;
        return {
          ok: true,
          json: async () => ({
            id: 2000,
            name: 'Series Two',
            first_air_date: '2020-01-01',
            poster_path: '/series2.jpg',
            external_ids: { imdb_id: 'tt2000' },
          }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => ({}) } as unknown as Response;
    });

    const ep1: LocalEntry = {
      id: 'ep1',
      path: '/media/show/s01e01.mkv',
      filename: 's01e01.mkv',
      title: 'Series Two',
      year: 2020,
      type: 'show',
      season: 1,
      episode: 1,
      tmdbId: 2000,
      addedAt: 1000,
    };

    const ep2: LocalEntry = {
      id: 'ep2',
      path: '/media/show/s01e02.mkv',
      filename: 's01e02.mkv',
      title: 'Series Two',
      year: 2020,
      type: 'show',
      season: 1,
      episode: 2,
      tmdbId: 2000,
      addedAt: 1001,
    };

    invalidateTmdbIdMatchCache(2000, 'show');
    await refreshTmdbEntry(ep1, 'mock-token');
    await refreshTmdbEntry(ep2, 'mock-token');

    expect(apiCallCount).toBe(1);
  });

  it('falls back to filename search if tmdbId is missing', async () => {
    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes('/search/tv')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 5000,
                name: 'Stranger Things',
                first_air_date: '2016-07-15',
                poster_path: '/st.jpg',
              },
            ],
          }),
        } as unknown as Response;
      }
      if (url.includes('/3/tv/5000')) {
        return {
          ok: true,
          json: async () => ({
            id: 5000,
            name: 'Stranger Things',
            first_air_date: '2016-07-15',
            poster_path: '/st.jpg',
            external_ids: { imdb_id: 'tt4574334' },
          }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => ({}) } as unknown as Response;
    });

    const entry: LocalEntry = {
      id: 'unmatched1',
      path: '/media/Stranger.Things.S01E01.mkv',
      filename: 'Stranger.Things.S01E01.mkv',
      title: 'Stranger Things',
      year: null,
      type: 'show',
      addedAt: 1000,
    };

    const refreshed = await refreshTmdbEntry(entry, 'mock-token');
    expect(fetchedUrls.some((u) => u.includes('/search/tv'))).toBe(true);
    expect(refreshed.tmdbId).toBe(5000);
    expect(refreshed.title).toBe('Stranger Things');
  });
});







