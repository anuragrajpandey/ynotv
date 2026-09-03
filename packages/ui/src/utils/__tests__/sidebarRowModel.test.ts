import { describe, it, expect } from 'vitest';
import { buildSidebarRows, computeStickyOverlay, isPinnableRow, resolveOwnerDragState, ownerOfRow, type SidebarRowsInput, type SidebarRow } from '../sidebarRowModel';
import type { CategoryFolder, CustomPlaylist, PlaylistCategoryLink } from '../../db';
import type { CategoryWithCount, SourceWithCategories } from '../../hooks/useChannels';

function cat(id: string, name: string, channelCount = 0, extra: Partial<CategoryWithCount> = {}): CategoryWithCount {
  return { category_id: id, category_name: name, source_id: 'src1', channelCount, ...extra } as CategoryWithCount;
}
function group(sourceId: string, categories: CategoryWithCount[]): SourceWithCategories {
  return { sourceId, categories };
}
function link(id: number, categoryId: string, extra: Partial<PlaylistCategoryLink> = {}): PlaylistCategoryLink {
  return { id, playlist_id: 'p1', category_id: categoryId, ...extra } as PlaylistCategoryLink;
}
function pl(id: string, name: string): CustomPlaylist {
  return { playlist_id: id, name } as CustomPlaylist;
}
function folder(id: string, name: string, ownerId: string, extra: Partial<CategoryFolder> = {}): CategoryFolder {
  return { folder_id: id, name, playlist_id: ownerId, ...extra } as CategoryFolder;
}

function baseInput(over: Partial<SidebarRowsInput> = {}): SidebarRowsInput {
  return {
    groupedCategories: [],
    customPlaylists: null,
    allPlaylistCategoryLinks: null,
    allCategoryFolders: null,
    categoryNamesMap: null,
    sources: {},
    expandedSources: {},
    expandedPlaylists: {},
    expandedFolders: {},
    pinnedCategories: [],
    pinnedFolders: [],
    categorySortOrder: 'default',
    favoritesMode: 'none',
    includeAllChannelsToPlaylist: false,
    searchQuery: '',
    ...over,
  };
}

const types = (rows: SidebarRow[]) => rows.map((r) => r.type);
const keys = (rows: SidebarRow[]) => rows.map((r) => r.key);

describe('buildSidebarRows — real sources', () => {
  it('collapsed source emits only its header row', () => {
    const rows = buildSidebarRows(
      baseInput({ groupedCategories: [group('src1', [cat('c1', 'News', 5)])], expandedSources: {} })
    );
    expect(types(rows)).toEqual(['source']);
    expect(rows[0]).toMatchObject({ type: 'source', sourceId: 'src1', expanded: false, count: 5 });
  });

  it('expanded source emits header, allChannels, favorites, categories, individual in renderer order', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'News', 5), cat('c2', 'Sports', 2)])],
        expandedSources: { src1: true },
        includeAllChannelsToPlaylist: true,
        favoritesMode: 'both',
        perSourceFavoriteCounts: new Map([['src1', 7]]),
        totalPlaylistIndividualCounts: new Map([['src1', 3]]),
      })
    );
    expect(types(rows)).toEqual(['source', 'special', 'special', 'category', 'category', 'special']);
    expect(rows[0]).toMatchObject({ type: 'source', count: 10 }); // 5+2+0 links+3 indiv
    expect(rows[1]).toMatchObject({ kind: 'allChannels', count: 10 });
    expect(rows[2]).toMatchObject({ kind: 'favorites', count: 7 });
    expect(rows[3]).toMatchObject({ type: 'category', categoryId: 'c1', count: 5 });
    expect(rows[5]).toMatchObject({ kind: 'individual', count: 3 });
  });

  it('favorites row is skipped when count is 0 or mode is none', () => {
    const none = buildSidebarRows(
      baseInput({ groupedCategories: [group('src1', [cat('c1', 'News', 1)])], expandedSources: { src1: true }, favoritesMode: 'none', perSourceFavoriteCounts: new Map([['src1', 5]]) })
    );
    const perSourceZero = buildSidebarRows(
      baseInput({ groupedCategories: [group('src1', [cat('c1', 'News', 1)])], expandedSources: { src1: true }, favoritesMode: 'both', perSourceFavoriteCounts: new Map() })
    );
    expect(types(none)).toEqual(['source', 'category']);
    expect(types(perSourceZero)).toEqual(['source', 'category']);
  });

  it('search forces sources to expand even when collapsed', () => {
    const rows = buildSidebarRows(
      baseInput({ groupedCategories: [group('src1', [cat('c1', 'News', 1)])], expandedSources: {}, searchQuery: 'news' })
    );
    expect(rows[0]).toMatchObject({ type: 'source', expanded: true });
    expect(types(rows)).toEqual(['source', 'category']);
  });

  it('sorts categories alphabetically when categorySortOrder is alphabetical', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'Zeta', 1), cat('c2', 'Alpha', 2)])],
        expandedSources: { src1: true },
        categorySortOrder: 'alphabetical',
      })
    );
    const cats = rows.filter((r) => r.type === 'category');
    expect(cats.map((c) => c.key)).toEqual(['src1:c2', 'src1:c1']);
  });

  it('keeps display_order for default sort', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'Zeta', 1, { display_order: 2 }), cat('c2', 'Alpha', 2, { display_order: 1 })])],
        expandedSources: { src1: true },
        categorySortOrder: 'default',
      })
    );
    const cats = rows.filter((r) => r.type === 'category');
    expect(cats.map((c) => c.key)).toEqual(['src1:c2', 'src1:c1']);
  });
});

describe('buildSidebarRows — folders', () => {
  const folderInput = () =>
    baseInput({
      groupedCategories: [group('src1', [cat('c1', 'News', 1, { folder_id: 'f1' }), cat('c2', 'Sports', 2, { folder_id: 'f2' }), cat('c3', 'Root', 3)])],
      allCategoryFolders: [folder('f1', 'Folder One', 'src1'), folder('f2', 'Folder Two', 'src1')],
      expandedSources: { src1: true },
      expandedFolders: { f1: true, f2: true },
    });

  it('emits folder headers before their children and root categories after folders', () => {
    const rows = buildSidebarRows(folderInput());
    expect(types(rows)).toEqual(['source', 'folder', 'category', 'folder', 'category', 'category']);
    expect(rows[1]).toMatchObject({ type: 'folder', folderId: 'f1', name: 'Folder One', count: 1 });
    expect(rows[2]).toMatchObject({ type: 'category', categoryId: 'c1', folderChild: true });
    expect(rows[5]).toMatchObject({ type: 'category', categoryId: 'c3', folderChild: false });
  });

  it('collapsed folders emit only the header, not children', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'News', 1, { folder_id: 'f1' })])],
        allCategoryFolders: [folder('f1', 'Folder One', 'src1')],
        expandedSources: { src1: true },
        expandedFolders: {},
      })
    );
    expect(types(rows)).toEqual(['source', 'folder']);
    expect(rows[1]).toMatchObject({ type: 'folder', expanded: false });
  });

  it('sorts pinned folders first', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'News', 1, { folder_id: 'f1' }), cat('c2', 'Sports', 2, { folder_id: 'f2' })])],
        allCategoryFolders: [folder('f1', 'A Folder', 'src1'), folder('f2', 'B Folder', 'src1')],
        expandedSources: { src1: true },
        expandedFolders: { f1: true, f2: true },
        pinnedFolders: ['src1:f2'],
      })
    );
    const flds = rows.filter((r) => r.type === 'folder');
    expect(flds.map((f) => f.folderId)).toEqual(['f2', 'f1']);
    expect(flds[0]).toMatchObject({ pinned: true });
  });

  it('hides empty folders while searching', () => {
    // In the real app groupedCategories is pre-filtered by search, so a folder
    // with no matching categories has no entries and is dropped.
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'News', 1, { folder_id: 'f1' })])],
        allCategoryFolders: [folder('f1', 'A Folder', 'src1'), folder('f2', 'B Folder', 'src1')],
        expandedSources: { src1: true },
        expandedFolders: {},
        searchQuery: 'news',
      })
    );
    const flds = rows.filter((r) => r.type === 'folder');
    expect(flds.map((f) => f.folderId)).toEqual(['f1']);
  });
});

describe('buildSidebarRows — pinned flags', () => {
  it('marks pinned categories and folders on the right rows', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'News', 1), cat('c2', 'Sports', 2)])],
        expandedSources: { src1: true },
        pinnedCategories: ['src1:c2'],
      })
    );
    const c1 = rows.find((r) => r.type === 'category' && r.key === 'src1:c1')!;
    const c2 = rows.find((r) => r.type === 'category' && r.key === 'src1:c2')!;
    expect(c1).toMatchObject({ pinned: false });
    expect(c2).toMatchObject({ pinned: true });
  });
});

describe('buildSidebarRows — playlists', () => {
  it('emits playlist header, allChannels, sorted links, individual', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('catA', 'Alpha Channel', 4)])], // native count source for link native counts
        customPlaylists: [pl('p1', 'My Playlist')],
        allPlaylistCategoryLinks: [link(1, 'catA', { custom_name: 'B Link' }), link(2, 'catA', { custom_name: 'A Link' })],
        categoryNamesMap: new Map([['catA', 'Alpha Channel']]),
        expandedPlaylists: { p1: true },
        includeAllChannelsToPlaylist: true,
        categorySortOrder: 'alphabetical',
        flatPlaylistIndividualCounts: new Map([['p1', 9]]),
        manualCategoryChannelCounts: new Map([['p1:link:2', 3]]),
      })
    );
    // groupedCategories also emits a (collapsed) real-source header first.
    expect(types(rows)).toEqual(['source', 'playlist', 'special', 'link', 'link', 'special']);
    expect(rows[1]).toMatchObject({ type: 'playlist', count: 4 + 4 + 3 + 9 }); // l1=4, l2=4+3, indiv=9
    expect(rows[2]).toMatchObject({ kind: 'allChannels' });
    // links sorted by name (A before B)
    expect(rows[3]).toMatchObject({ type: 'link', name: 'A Link', count: 7 });
    expect(rows[4]).toMatchObject({ type: 'link', name: 'B Link', count: 4 });
    expect(rows[5]).toMatchObject({ kind: 'individual', count: 9 });
  });

  it('emits an empty hint row for playlists with no links', () => {
    const rows = buildSidebarRows(
      baseInput({
        customPlaylists: [pl('p1', 'Empty Playlist')],
        expandedPlaylists: { p1: true },
      })
    );
    expect(types(rows)).toEqual(['playlist', 'special']);
    expect(rows[1]).toMatchObject({ kind: 'empty' });
  });
});

describe('buildSidebarRows — renderer parity (golden fixtures)', () => {
  it('produces the exact row sequence the renderer shows for a rich library', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [
          group('srcA', [
            cat('c1', 'News', 10, { folder_id: 'fA1' }),
            cat('c2', 'Sports', 20, { folder_id: 'fA2' }),
            cat('c3', 'Docs', 5),
          ]),
          group('srcB', [cat('cB1', 'Films', 8)]),
        ],
        customPlaylists: [pl('p1', 'My Mix')],
        allPlaylistCategoryLinks: [
          link(1, 'c1', { playlist_id: 'srcA', custom_name: 'Movies Extra' }), // srcA custom link -> native 10 + manual 4 = 14
          link(10, 'c1', { custom_name: 'Alpha Link' }), // p1 root link -> native 10 + manual 1 = 11
          link(20, 'c1', { custom_name: 'Beta Link', folder_id: 'fp1' }), // p1 folder link -> 10
        ],
        allCategoryFolders: [
          folder('fA1', 'Folder One', 'srcA', { display_order: 1 }),
          folder('fA2', 'Folder Two', 'srcA', { display_order: 2 }),
          folder('fp1', 'Playlist Folder', 'p1', { display_order: 1 }),
        ],
        categoryNamesMap: new Map([['c1', 'News']]),
        sources: { srcA: 'Alpha TV', srcB: 'Beta TV' },
        sidebarSourcesOrder: ['srcA', 'srcB', 'playlist:p1'],
        expandedSources: { srcA: true, srcB: true },
        expandedPlaylists: { p1: true },
        expandedFolders: { fA1: true, fp1: true }, // fA2 stays collapsed
        pinnedCategories: ['srcA:c2'], // Sports pinned -> sorts first within srcA entries
        pinnedFolders: ['srcA:fA1'], // Folder One pinned -> before Folder Two
        categorySortOrder: 'alphabetical',
        favoritesMode: 'both',
        perSourceFavoriteCounts: new Map([['srcA', 3]]),
        includeAllChannelsToPlaylist: true,
        totalPlaylistIndividualCounts: new Map([['srcA', 5]]),
        flatPlaylistIndividualCounts: new Map([['p1', 2]]),
        manualCategoryChannelCounts: new Map([
          ['srcA:link:1', 4],
          ['p1:link:10', 1],
        ]),
      })
    );

    expect(keys(rows)).toEqual([
      'srcA', // header (54 = 10+20+5 cats + 14 link + 5 indiv)
      '__allsrc_srcA',
      '__favsrc_srcA',
      'srcA:fA1', // pinned folder first (count 10)
      'srcA:c1', // News
      'srcA:fA2', // collapsed folder -> header only
      'srcA:c3', // Docs (root)
      'srcA:link:1', // Movies Extra (root, 14)
      '__plindiv_srcA',
      'srcB', // header (8)
      '__allsrc_srcB',
      'srcB:cB1',
      'playlist:p1', // header (23 = 11 + 10 + 2)
      '__allsrc_pl_p1',
      'p1:fp1', // playlist folder
      'p1:link:20', // Beta Link (folder child)
      'p1:link:10', // Alpha Link (root, 11)
      '__plindiv_p1',
    ]);

    // Pin the key counts too
    const srcA = rows.find((r) => r.key === 'srcA')!;
    const linkA = rows.find((r) => r.key === 'srcA:link:1')!;
    const p1 = rows.find((r) => r.key === 'playlist:p1')!;
    // source badge counts categories + native link counts + individual (NO manual; matches renderer)
    expect(srcA).toMatchObject({ count: 50 });
    expect(linkA).toMatchObject({ type: 'link', count: 14 });
    expect(p1).toMatchObject({ count: 23 });
    // Sports is pinned; Docs/Movies Extra are not
    expect(rows.find((r) => r.key === 'srcA:c2')).toBeUndefined(); // inside collapsed fA2
    expect(rows.find((r) => r.key === 'srcA:fA1')).toMatchObject({ pinned: true });
    expect(rows.find((r) => r.key === 'srcA:c3')).toMatchObject({ pinned: false });
  });

  it('search parity: forces expansion, hides empty folders, drops unmatched sources', () => {
    const rows = buildSidebarRows(
      baseInput({
        // pre-filtered like filteredGroupedCategories: only News (srcA) matches
        groupedCategories: [group('srcA', [cat('c1', 'News', 10, { folder_id: 'fA1' })])],
        allCategoryFolders: [folder('fA1', 'Folder One', 'srcA'), folder('fA2', 'Folder Two', 'srcA')],
        expandedSources: {}, // not expanded, but search forces it
        expandedFolders: {},
        searchQuery: 'news',
        includeAllChannelsToPlaylist: true,
      })
    );
    expect(keys(rows)).toEqual(['srcA', '__allsrc_srcA', 'srcA:fA1', 'srcA:c1']);
    expect(rows[0]).toMatchObject({ type: 'source', expanded: true });
  });
});

describe('buildSidebarRows — sidebar order', () => {
  it('honors sidebarSourcesOrder, falling back to name order', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('srcA', [cat('c1', 'News', 1)]), group('srcB', [cat('c2', 'Sports', 1)])],
        sources: { srcA: 'Source A', srcB: 'Source B' },
        sidebarSourcesOrder: ['srcB', 'srcA'],
      })
    );
    expect(rows.map((r) => r.key)).toEqual(['srcB', 'srcA']);
  });

  it('produces unique keys across the whole flattened list', () => {
    const rows = buildSidebarRows(
      baseInput({
        groupedCategories: [group('src1', [cat('c1', 'News', 1, { folder_id: 'f1' }), cat('c2', 'Sports', 2)])],
        allCategoryFolders: [folder('f1', 'Folder', 'src1')],
        expandedSources: { src1: true },
        expandedFolders: { f1: true },
      })
    );
    const allKeys = keys(rows);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});

describe('buildSidebarRows — large library invariants (virtualization data source)', () => {
  // The flattened model is the input to the side-baar virtualizer, so these
  // invariants are what make virtualization safe: every row has a unique key,
  // each pinned row is represented exactly once (no double-mount in an overlay),
  // ordering matches the renderer (folders before roots per owner), and a
  // collapsed/filtered owner contributes only its header.
  const seed = () => {
    const sources: Record<string, string> = { srcA: 'Source A', srcB: 'Source B', srcC: 'Source C' };
    // srcA: expanded, with a pinned folder and a pinned root category.
    const catsA: CategoryWithCount[] = [];
    const pinnedCatId = 'a999';
    for (let i = 0; i < 1500; i++) {
      const cid = `a${i}`;
      catsA.push(
        cat(cid, `Cat A ${i}`, i % 7, {
          source_id: 'srcA',
          folder_id: i % 3 === 0 ? 'fA1' : null,
          display_order: i,
        })
      );
    }
    // Overwrite one category to be pinned.
    const a999 = catsA.find((c) => c.category_id === pinnedCatId)!;
    Object.assign(a999, { category_id: pinnedCatId, folder_id: null });
    // srcB: collapsed (only a header should appear).
    const catsB: CategoryWithCount[] = [];
    for (let i = 0; i < 1200; i++) {
      catsB.push(cat(`b${i}`, `Cat B ${i}`, 1, { source_id: 'srcB', display_order: i }));
    }
    // srcC: expanded, no folders.
    const catsC: CategoryWithCount[] = [];
    for (let i = 0; i < 800; i++) {
      catsC.push(cat(`c${i}`, `Cat C ${i}`, 2, { source_id: 'srcC', display_order: i }));
    }
    const groupedCategories = [group('srcA', catsA), group('srcB', catsB), group('srcC', catsC)];

    const playlistLinks: PlaylistCategoryLink[] = [];
    const pinnedLinkId = 50;
    for (let i = 0; i < 500; i++) {
      playlistLinks.push(
        link(i, `pc${i}`, {
          playlist_id: 'p1',
          custom_name: `Playlist Link ${i}`,
          folder_id: i % 2 === 0 ? 'pf1' : null,
          display_order: i,
        })
      );
    }
    const pfFolder: CategoryFolder = folder('pf1', 'Pinned Playlist Folder', 'p1', { display_order: 1 });
    const fA1: CategoryFolder = folder('fA1', 'Src A Folder', 'srcA', { display_order: 1 });

    const input: SidebarRowsInput = baseInput({
      groupedCategories,
      customPlaylists: [pl('p1', 'My Playlist')],
      allPlaylistCategoryLinks: playlistLinks,
      allCategoryFolders: [fA1, pfFolder],
      sources,
      expandedSources: { srcA: true, srcC: true },
      expandedPlaylists: { p1: true },
      expandedFolders: { fA1: true, pf1: true },
      pinnedCategories: [`srcA:${pinnedCatId}`, `p1:link:${pinnedLinkId}`],
      pinnedFolders: ['srcA:fA1', 'p1:pf1'],
      categorySortOrder: 'default',
      sidebarSourcesOrder: ['srcA', 'srcB', 'srcC'],
    });
    return { input, pinnedCatId, pinnedLinkId };
  };

  const input = seed();
  const rows = buildSidebarRows(input.input);

  it('every row key is unique across the whole flattened list', () => {
    const allKeys = keys(rows);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('collapsed source contributes only its header; expanded owners render their rows', () => {
    // srcB collapsed -> exactly one row, and it's a source header.
    const srcBRows = rows.filter((r) => r.type === 'source' && r.sourceId === 'srcB');
    expect(srcBRows.length).toBe(1);
    // srcA expanded -> header + 1500 category rows (+ folder header + pinned specials as applicable).
    const srcACategories = rows.filter((r) => r.type === 'category' && r.sourceId === 'srcA');
    expect(srcACategories.length).toBe(1500);
    // folders emitted for srcA
    const srcAFolders = rows.filter((r): r is Extract<SidebarRow, { type: 'folder' }> => r.type === 'folder' && r.ownerId === 'srcA');
    expect(srcAFolders.map((f) => f.folderId)).toEqual(['fA1']);
  });

  it('pinned categories/links/folders each appear exactly once', () => {
    const pinnedCatRows = rows.filter((r): r is Extract<SidebarRow, { type: 'category' }> => r.type === 'category' && r.categoryId === input.pinnedCatId);
    expect(pinnedCatRows.length).toBe(1);
    expect(pinnedCatRows[0].pinned).toBe(true);

    const pinnedLinkRows = rows.filter((r): r is Extract<SidebarRow, { type: 'link' }> => r.type === 'link' && r.linkId === input.pinnedLinkId);
    expect(pinnedLinkRows.length).toBe(1);
    expect(pinnedLinkRows[0].pinned).toBe(true);

    const pinnedFolderRows = rows.filter((r): r is Extract<SidebarRow, { type: 'folder' }> => r.type === 'folder' && r.folderId === 'fA1');
    expect(pinnedFolderRows.length).toBe(1);
    expect(pinnedFolderRows[0].pinned).toBe(true);
  });

  it('orders folders before root rows per owner, matching the renderer', () => {
    // srcA: folder child categories come before root categories.
    const srcAEntries = rows.filter((r): r is Extract<SidebarRow, { type: 'category' }> => r.type === 'category' && r.sourceId === 'srcA');
    const firstRoot = srcAEntries.findIndex((r) => !r.folderChild);
    const lastFolderChild = srcAEntries.reduce(
      (acc, r, i) => (r.folderChild ? i : acc),
      -1
    );
    if (firstRoot !== -1) expect(lastFolderChild).toBeLessThan(firstRoot);

    // playlist p1: folder-child links before root links.
    const p1Links = rows.filter((r): r is Extract<SidebarRow, { type: 'link' }> => r.type === 'link' && r.playlistId === 'p1');
    const rootIdx = p1Links.findIndex((r) => !r.folderChild);
    const lastChild = p1Links.reduce((acc, r, i) => (r.folderChild ? i : acc), -1);
    if (rootIdx !== -1) expect(lastChild).toBeLessThan(rootIdx);
  });

  it('keeps one logical row per pinned item so virtualization never double-mounts an overlay', () => {
    // No two rows may share the same key OR represent the same selectable item.
    const counts = new Map<string, number>();
    for (const r of rows) {
      const logicalId =
        r.type === 'category' ? `cat:${r.categoryId}`
        : r.type === 'link' ? `link:${r.linkId}`
        : r.type === 'folder' ? `folder:${r.folderId}`
        : null;
      if (!logicalId) continue;
      counts.set(logicalId, (counts.get(logicalId) || 0) + 1);
    }
    for (const [id, n] of counts) expect(n, `duplicate logical row ${id}`).toBe(1);
  });
});

describe('computeStickyOverlay — native-faithful header + pinned overlay', () => {
  // Fixed heights mirroring the renderer estimator: source/playlist 40, folder 34,
  // category/link 38.
  const h = (r: SidebarRow) => (r.type === 'source' || r.type === 'playlist' ? 40 : r.type === 'folder' ? 34 : 38);
  const keys = (rows: ReturnType<typeof computeStickyOverlay>) => rows.map((s) => s.row.key);
  const tops = (rows: ReturnType<typeof computeStickyOverlay>) => rows.map((s) => s.top);

  // Single-section flat list: header(40) + pinned folder(34) + unpinned(38) + pinned cat(38).
  // offsets: source 0-40, folder 40-74, c1 74-112, c2 112-150. Section ends at 150.
  const rows: SidebarRow[] = [
    { type: 'source', key: 's1', sourceId: 's1', name: 'S', count: 0, expanded: true },
    { type: 'folder', key: 's1:f1', ownerId: 's1', folderId: 'f1', name: 'F', count: 0, expanded: true, pinned: true },
    { type: 'category', key: 's1:c1', sourceId: 's1', categoryId: 'c1', name: 'U', count: 0, pinned: false, folderChild: false, folderId: null },
    { type: 'category', key: 's1:c2', sourceId: 's1', categoryId: 'c2', name: 'P', count: 0, pinned: true, folderChild: false, folderId: null },
  ] as SidebarRow[];

  it('mounts nothing at the top of the list', () => {
    expect(computeStickyOverlay(rows, h, 0)).toEqual([]);
  });

  it('sticks the active source header at top 0 when expanded', () => {
    const at20 = computeStickyOverlay(rows, h, 20);
    expect(keys(at20)[0]).toBe('s1');
    expect(tops(at20)[0]).toBe(0);
  });

  it('does not stick collapsed source headers (they scroll in normal flow)', () => {
    const collapsed: SidebarRow[] = [
      { type: 'source', key: 's1', sourceId: 's1', name: 'S1', count: 0, expanded: false },
      { type: 'source', key: 's2', sourceId: 's2', name: 'S2', count: 0, expanded: false },
    ] as SidebarRow[];
    expect(computeStickyOverlay(collapsed, h, 10)).toEqual([]);
    expect(computeStickyOverlay(collapsed, h, 50)).toEqual([]);
  });

  it('sticks pinned rows at native timing, and smoothly pushes pinned items and header as the section ends', () => {
    // header(40) + pinned p1(38) + unpinned u(38) + pinned p2(38). p1: 40-78, u: 78-116, p2: 116-154. Section ends at 154.
    const twoPins: SidebarRow[] = [
      { type: 'source', key: 's1', sourceId: 's1', name: 'S', count: 0, expanded: true } as SidebarRow,
      { type: 'category', key: 's1:p1', sourceId: 's1', categoryId: 'p1', name: 'P1', count: 0, pinned: true, folderChild: false, folderId: null } as SidebarRow,
      { type: 'category', key: 's1:u', sourceId: 's1', categoryId: 'u', name: 'U', count: 0, pinned: false, folderChild: false, folderId: null } as SidebarRow,
      { type: 'category', key: 's1:p2', sourceId: 's1', categoryId: 'p2', name: 'P2', count: 0, pinned: true, folderChild: false, folderId: null } as SidebarRow,
    ];
    // Early: p1 is glued below the header immediately (top 40 reached its slot 40).
    expect(keys(computeStickyOverlay(twoPins, h, 1))).toEqual(['s1', 's1:p1']);
    expect(tops(computeStickyOverlay(twoPins, h, 1))).toEqual([0, 40]);
    // p2 (top 116) reaches its slot (78) once 116 <= scrollTop + 78 → scrollTop >= 38.
    const at38 = computeStickyOverlay(twoPins, h, 38);
    expect(keys(at38)).toEqual(['s1', 's1:p1', 's1:p2']);
    expect(tops(at38)).toEqual([0, 40, 78]);

    // As section ends: header stays at top 0 until remaining < 40; pinned items slide up under it.
    // At scrollTop 100: section remaining is 154 - 100 = 54px.
    // Header (slot 0, h 40) is at min(0, 54 - 40) = 0.
    // p1 (slot 40, h 38) is at min(40, 54 - 38) = 16.
    // p2 (slot 78, h 38) is at min(78, 54 - 38) = 16.
    const at100 = computeStickyOverlay(twoPins, h, 100);
    expect(keys(at100)).toEqual(['s1', 's1:p1', 's1:p2']);
    expect(tops(at100)).toEqual([0, 16, 16]);

    // Near end: at scrollTop 130: section remaining is 154 - 130 = 24px.
    // Header is at min(0, 24 - 40) = -16 (visible 24px, touching next section at 154-130 = 24px!).
    // p1 & p2 are at min(..., 24 - 38) = -14 (tucked under header).
    const at130 = computeStickyOverlay(twoPins, h, 130);
    expect(keys(at130)).toEqual(['s1', 's1:p1', 's1:p2']);
    expect(tops(at130)).toEqual([-16, -14, -14]);
  });

  it('never sticks unpinned rows', () => {
    const stuck = computeStickyOverlay(rows, h, 50);
    expect(stuck.some((s) => s.row.type === 'category' && s.row.categoryId === 'c1')).toBe(false);
  });

  it('boundary fixture: smooth push-up without black gaps, and handles collapsed next sources', () => {
    const multi: SidebarRow[] = [
      ...rows, // s1 section (expanded) 0-150: header(40), pinned folder f1(34), unpinned c1(38), pinned c2(38)
      { type: 'source', key: 's2', sourceId: 's2', name: 'T', count: 0, expanded: false } as SidebarRow, // 150-190 (collapsed!)
      { type: 'source', key: 's3', sourceId: 's3', name: 'U', count: 0, expanded: true } as SidebarRow, // 190-268
      { type: 'category', key: 's3:c4', sourceId: 's3', categoryId: 'c4', name: 'P2', count: 0, pinned: true, folderChild: false, folderId: null } as SidebarRow, // 230-268
    ];
    // Mid-s1: at scrollTop 100: s1 remaining is 150 - 100 = 50px.
    // header at min(0, 50 - 40) = 0.
    // f1 at min(40, 50 - 34) = 16.
    // c2 at min(74, 50 - 38) = 12.
    const at100 = computeStickyOverlay(multi, h, 100);
    expect(keys(at100)).toEqual(['s1', 's1:f1', 's1:c2']);
    expect(tops(at100)).toEqual([0, 16, 12]);

    // Near the end of s1 (s2 header is ~5px below, remaining 5px):
    // header at min(0, 5 - 40) = -35 (vis 5px, touching s2 at 150-145 = 5px!).
    const nearEnd = computeStickyOverlay(multi, h, 145);
    expect(keys(nearEnd)).toEqual(['s1', 's1:f1', 's1:c2']);
    expect(tops(nearEnd)).toEqual([-35, -29, -33]);

    // Inside s2 (which is collapsed): NO sticky overlay! s2 renders in normal flow in virtual list.
    const inCollapsed = computeStickyOverlay(multi, h, 160);
    expect(inCollapsed).toEqual([]);

    // Inside s3 (which is expanded): s3 header sticks at top 0 at s3 start (190)!
    const at190 = computeStickyOverlay(multi, h, 190);
    expect(keys(at190)[0]).toBe('s3');
    expect(tops(at190)[0]).toBe(0);

    // Deep in s3 (scrollTop 200, remaining 68px):
    // s3 header (slot 0) is at min(0, 68 - 40) = 0.
    // s3:c4 (natural top 230 <= 200 + 40) is at min(40, 68 - 38) = 30.
    const at200 = computeStickyOverlay(multi, h, 200);
    expect(keys(at200)).toEqual(['s3', 's3:c4']);
    expect(tops(at200)).toEqual([0, 30]);
  });

  it('sticks an expanded unpinned folder header below the source header, bounded by its children', () => {
    // source(40) + expanded unpinned folder(34) + 2 children(38 each) + pinned root cat(38).
    // s1 0-40, fA 40-74, ca 74-112, cb 112-150, c2 150-188. Section ends at 188.
    const frows: SidebarRow[] = [
      { type: 'source', key: 's1', sourceId: 's1', name: 'S', count: 0, expanded: true } as SidebarRow, // 0-40
      { type: 'folder', key: 's1:fA', ownerId: 's1', folderId: 'fA', name: 'FA', count: 0, expanded: true, pinned: false } as SidebarRow, // 40-74
      { type: 'category', key: 's1:ca', sourceId: 's1', categoryId: 'ca', name: 'A', count: 0, pinned: false, folderChild: true, folderId: 'fA' } as SidebarRow, // 74-112
      { type: 'category', key: 's1:cb', sourceId: 's1', categoryId: 'cb', name: 'B', count: 0, pinned: false, folderChild: true, folderId: 'fA' } as SidebarRow, // 112-150
      { type: 'category', key: 's1:c2', sourceId: 's1', categoryId: 'c2', name: 'P', count: 0, pinned: true, folderChild: false, folderId: null } as SidebarRow, // 150-188
    ];
    // While scrolling folder: folder header sticks at 40; pinned root cat c2 reached its slot and stacks below at 40+38=78.
    // At scrollTop 60: folder remaining is 150 - 60 = 90 >= 74. fA at 40.
    const at60 = computeStickyOverlay(frows, h, 60);
    expect(keys(at60)).toEqual(['s1', 's1:fA']);
    expect(tops(at60)).toEqual([0, 40]);

    // At scrollTop 100: fA children end at 150 (remaining 50). fA at min(40, 50 - 34) = 16.
    // c2 at 150 has not reached slot 40 yet (150 > 100 + 40 = 140).
    const at100 = computeStickyOverlay(frows, h, 100);
    expect(keys(at100)).toEqual(['s1', 's1:fA']);
    expect(tops(at100)).toEqual([0, 16]);

    // Past the folder's children (scrollTop = 160): fA is off screen.
    // s1 header is at min(0, 188 - 160 - 40) = -12.
    // c2 is at min(40, 188 - 160 - 38) = -10.
    const at160 = computeStickyOverlay(frows, h, 160);
    expect(keys(at160)).toEqual(['s1', 's1:c2']);
    expect(tops(at160)).toEqual([-12, -10]);
  });

  it('never shows the incoming section header in the overlay before takeover', () => {
    const multi: SidebarRow[] = [
      ...rows,
      { type: 'source', key: 's2', sourceId: 's2', name: 'T', count: 0, expanded: true } as SidebarRow, // 150-190
    ];
    // While scrolling s1 (incoming header at up to 116px below), s2 is NOT in
    // the overlay at any point — it stays in normal flow until it takes over.
    const mid = computeStickyOverlay(multi, h, 100);
    expect(mid.every((s) => s.row.key !== 's2')).toBe(true);
    const nearEnd = computeStickyOverlay(multi, h, 145);
    expect(nearEnd.every((s) => s.row.key !== 's2')).toBe(true);
  });

  it('uses virtualizer measurements for the source handoff boundary', () => {
    // The third row is taller than the fixed 38px estimate. Without the
    // measured start/size, the model would incorrectly switch to s2 at 100.
    const measuredRows: SidebarRow[] = [
      { type: 'source', key: 's1', sourceId: 's1', name: 'S1', count: 0, expanded: true } as SidebarRow,
      { type: 'category', key: 's1:p1', sourceId: 's1', categoryId: 'p1', name: 'P1', count: 0, pinned: true, folderChild: false, folderId: null } as SidebarRow,
      { type: 'category', key: 's1:long', sourceId: 's1', categoryId: 'long', name: 'Long', count: 0, pinned: false, folderChild: false, folderId: null } as SidebarRow,
      { type: 'source', key: 's2', sourceId: 's2', name: 'S2', count: 0, expanded: true } as SidebarRow,
    ];
    const measurements = new Map([
      ['s1', { start: 0, size: 40 }],
      ['s1:p1', { start: 40, size: 38 }],
      ['s1:long', { start: 78, size: 100 }],
      ['s2', { start: 178, size: 40 }],
    ]);

    expect(keys(computeStickyOverlay(measuredRows, h, 100, measurements))).toContain('s1');
    expect(keys(computeStickyOverlay(measuredRows, h, 100, measurements))).not.toContain('s2');
  });
});

describe('resolveOwnerDragState', () => {
  // Minimal row fixtures: category rows carry sourceId + categoryId; link rows
  // carry playlistId + linkId. Keys mirror the model's `<ownerId>:<id>` scheme.
  const rows: SidebarRow[] = [
    { type: 'category', key: 's1:c10', sourceId: 's1', categoryId: '10', name: 'A', count: 1, pinned: false, folderChild: false, folderId: null },
    { type: 'category', key: 's1:c20', sourceId: 's1', categoryId: '20', name: 'B', count: 1, pinned: false, folderChild: false, folderId: null },
    { type: 'category', key: 's2:c30', sourceId: 's2', categoryId: '30', name: 'C', count: 1, pinned: false, folderChild: false, folderId: null },
    { type: 'link', key: 'p1:link:7', playlistId: 'p1', linkId: 7, categoryId: '10', name: 'L7', count: 1, pinned: false, folderChild: false, folderId: null },
    { type: 'link', key: 'p1:link:9', playlistId: 'p1', linkId: 9, categoryId: '20', name: 'L9', count: 1, pinned: false, folderChild: false, folderId: null },
    { type: 'link', key: 'p2:link:11', playlistId: 'p2', linkId: 11, categoryId: '10', name: 'L11', count: 1, pinned: false, folderChild: false, folderId: null },
    { type: 'source', key: 's1', sourceId: 's1', sourceName: 'S1', sourceCount: 0, expanded: true },
    { type: 'folder', key: 's1:f1', sourceId: 's1', folderId: 'f1', name: 'F', count: 0, expanded: false, pinned: false },
  ] as SidebarRow[];

  const nativeById = new Map<string, { category_id: string | number }>([
    ['10', { category_id: 10 }],
    ['20', { category_id: '20' }],
    ['30', { category_id: 30 }],
  ]);
  const linkById = new Map<number, { id: number }>([
    [7, { id: 7 }],
    [9, { id: 9 }],
    [11, { id: 11 }],
  ]);

  it('builds the owner list in persistence-id shape, only for that owner, in row order', () => {
    const { items } = resolveOwnerDragState(rows, 's1', nativeById as any, linkById as any);
    // s1 has two native categories; link rows and other owners must be excluded.
    expect(items).toEqual([
      { id: 10, type: 'native', nativeCat: { category_id: 10 } },
      { id: '20', type: 'native', nativeCat: { category_id: '20' } },
    ]);
  });

  it('uses link:<id> as the persistence id for playlist links', () => {
    const { items } = resolveOwnerDragState(rows, 'p1', nativeById as any, linkById as any);
    expect(items).toEqual([
      { id: 'link:7', type: 'link', customLink: { id: 7 } },
      { id: 'link:9', type: 'link', customLink: { id: 9 } },
    ]);
  });

  it('maps every dnd row key to its persistence id so event ids can be translated', () => {
    const { persistenceIdByKey } = resolveOwnerDragState(rows, 's1', nativeById as any, linkById as any);
    expect(persistenceIdByKey.get('s1:c10')).toBe(10);
    expect(persistenceIdByKey.get('s1:c20')).toBe('20');
    const p1 = resolveOwnerDragState(rows, 'p1', nativeById as any, linkById as any).persistenceIdByKey;
    expect(p1.get('p1:link:7')).toBe('link:7');
    expect(p1.get('p1:link:9')).toBe('link:9');
  });

  it('skips rows whose DB object is missing, and never includes other owners', () => {
    const nativeOnly = new Map<string, { category_id: string | number }>([['10', { category_id: 10 }]]);
    const { items, persistenceIdByKey } = resolveOwnerDragState(rows, 's1', nativeOnly as any, linkById as any);
    expect(items).toEqual([{ id: 10, type: 'native', nativeCat: { category_id: 10 } }]);
    expect(persistenceIdByKey.has('s1:c20')).toBe(false);
    expect(persistenceIdByKey.has('s2:c30')).toBe(false);
    expect(persistenceIdByKey.has('p1:link:7')).toBe(false);
  });
});

describe('ownerOfRow', () => {
  const cat = { type: 'category', key: 's1:c1', sourceId: 's1', categoryId: '1' } as SidebarRow;
  const link = { type: 'link', key: 'p1:link:2', playlistId: 'p1', linkId: 2 } as SidebarRow;
  const src = { type: 'source', key: 's1', sourceId: 's1' } as SidebarRow;

  it('returns the source for categories, the playlist for links, and nothing for other rows', () => {
    expect(ownerOfRow(cat)).toBe('s1');
    expect(ownerOfRow(link)).toBe('p1');
    expect(ownerOfRow(src)).toBe('');
  });
});
