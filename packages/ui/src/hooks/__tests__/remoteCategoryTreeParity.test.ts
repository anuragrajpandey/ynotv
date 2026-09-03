/**
 * remoteCategoryTreeParity.test.ts
 *
 * Diffs the phone-remote companion's LiveTV category tree (built by the real
 * `buildCategoryTreeFromData` core) against the app's CategoryStrip ordering
 * for the SAME profile, reporting any remaining mismatches.
 *
 * The "app side" is simulated faithfully from CategoryStrip's assembly rules
 * (verified against its render code): one unified list of native categories +
 * custom links per owner, sorted once with the shared sidebar comparator,
 * distributed into folders/root, folders sorted pinned-first, and rendered in
 * folder-then-root order. Both sides now use the same comparators from
 * `categorySortRules`, so this test proves the wiring — owner ids, pin keys,
 * bucket distribution, and the playlist-vs-real-source rule split — produces
 * identical orderings.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCategoryTreeFromData,
  type CategoryTree,
  type CategoryTreeBuildInput,
} from '../usePhoneRemoteCompanion';
import {
  comparePlaylistCategory,
  compareSidebarCategory,
  compareSidebarFolder,
} from '../../utils/categorySortRules';
import type {
  StoredCategory,
  CategoryFolder,
  CustomGroup,
  CustomPlaylist,
  PlaylistCategoryLink,
} from '../../db';

// ---------------------------------------------------------------------------
// Fixture model
// ---------------------------------------------------------------------------

interface Fixture {
  sortOrder: string;
  customized: string[];
  pinnedCategories: string[];
  pinnedFolders: string[];
  sources: Array<{ id: string; name: string }>;
  categories: Array<{
    id: string;
    name: string;
    alias?: string | null;
    source: string;
    order?: number | null;
    folder?: string | null;
  }>;
  folders: Array<{ id: string; name: string; owner: string; order?: number | null }>;
  links: Array<{
    id: number;
    owner: string; // source id OR custom playlist id
    category: string;
    customName?: string | null;
    order?: number | null;
    folder?: string | null;
  }>;
  playlists: Array<{ id: string; name: string }>;
  sidebarOrder: string[] | null;
}

export function toInput(f: Fixture): CategoryTreeBuildInput {
  return {
    sourceList: f.sources.map((s) => ({ id: s.id, name: s.name })),
    categories: f.categories.map(
      (c) =>
        ({
          category_id: c.id,
          category_name: c.name,
          alias: c.alias ?? null,
          source_id: c.source,
          display_order: c.order ?? null,
          folder_id: c.folder ?? null,
          channel_count: 1,
          enabled: true,
        }) as unknown as StoredCategory
    ),
    foldersList: f.folders.map(
      (fo) =>
        ({
          folder_id: fo.id,
          name: fo.name,
          playlist_id: fo.owner,
          display_order: fo.order ?? null,
        }) as unknown as CategoryFolder
    ),
    customGroupsList: [] as CustomGroup[],
    customPlaylistsList: f.playlists.map(
      (p) => ({ playlist_id: p.id, name: p.name }) as unknown as CustomPlaylist
    ),
    playlistLinksList: f.links.map(
      (l) =>
        ({
          id: l.id,
          playlist_id: l.owner,
          category_id: l.category,
          custom_name: l.customName ?? null,
          display_order: l.order ?? null,
          folder_id: l.folder ?? null,
        }) as unknown as PlaylistCategoryLink
    ),
    sidebarOrder: f.sidebarOrder,
    categorySortOrder: f.sortOrder,
    pinnedCategories: f.pinnedCategories,
    pinnedFolders: f.pinnedFolders,
    customizedSourceIds: f.customized,
  };
}

// ---------------------------------------------------------------------------
// App-side (CategoryStrip) ordering simulation
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  order: number;
  folder?: string | null;
}

interface SourceRender {
  sourceId: string;
  folders: Array<{ folderId: string; name: string; order: number; items: Row[] }>;
  root: Row[];
}

function catName(c: Fixture['categories'][number]): string {
  return c.alias || c.name;
}

function linkName(f: Fixture, l: Fixture['links'][number]): string {
  const orig = f.categories.find((c) => c.id === l.category);
  return l.customName || (orig ? catName(orig) : l.category);
}

/** Mirrors CategoryStrip: unified sort, distribute into folders, folder-first render. */
export function appOrdering(f: Fixture): Map<string, SourceRender> {
  const map = new Map<string, SourceRender>();
  const owners: Array<{ key: string; raw: string; isPlaylist: boolean }> = [
    ...f.sources.map((s) => ({ key: s.id, raw: s.id, isPlaylist: false })),
    ...f.playlists.map((p) => ({ key: `playlist:${p.id}`, raw: p.id, isPlaylist: true })),
  ];
  for (const owner of owners) {
    const catsOf = f.categories.filter((c) => c.source === owner.raw);
    const linksOf = f.links.filter((l) => l.owner === owner.raw);

    const list: Row[] = owner.isPlaylist
      ? linksOf.map((l) => ({
          id: `link:${l.id}`,
          name: linkName(f, l),
          order: l.order ?? 0,
          folder: l.folder ?? null,
        }))
      : [
          ...catsOf.map((c) => ({
            id: c.id,
            name: catName(c),
            order: c.order ?? 0,
            folder: c.folder ?? null,
          })),
          ...linksOf.map((l) => ({
            id: `link:${l.id}`,
            name: linkName(f, l),
            order: l.order ?? 0,
            folder: l.folder ?? null,
          })),
        ];

    const ctx = {
      categorySortOrder: f.sortOrder,
      pinnedCategories: new Set(f.pinnedCategories),
      customizedSourceIds: new Set(f.customized),
    };
    list.sort((a, b) =>
      owner.isPlaylist
        ? comparePlaylistCategory(
            { id: a.id, name: a.name, displayOrder: a.order },
            { id: b.id, name: b.name, displayOrder: b.order },
            ctx,
            owner.raw
          )
        : compareSidebarCategory(
            { id: a.id, name: a.name, displayOrder: a.order },
            { id: b.id, name: b.name, displayOrder: b.order },
            ctx,
            owner.raw
          )
    );

    const folders = f.folders.filter((fo) => fo.owner === owner.raw);
    const folderMap = new Map(folders.map((fo) => [fo.id, [] as Row[]]));
    const root: Row[] = [];
    for (const it of list) {
      if (it.folder && folderMap.has(it.folder)) {
        folderMap.get(it.folder)!.push(it);
      } else {
        root.push(it);
      }
    }
    const sortedFolders = [...folders].sort((a, b) =>
      compareSidebarFolder(
        { folder_id: a.id, display_order: a.order ?? 0 },
        { folder_id: b.id, display_order: b.order ?? 0 },
        { pinnedFolders: new Set(f.pinnedFolders) },
        owner.raw
      )
    );

    map.set(owner.key, {
      sourceId: owner.key,
      folders: sortedFolders.map((fo) => ({
        folderId: fo.id,
        name: fo.name,
        order: fo.order ?? 0,
        items: folderMap.get(fo.id)!,
      })),
      root,
    });
  }
  return map;
}

/** Mirrors the app's combinedSources global order (sidebar order pref or natural). */
function appGlobalOrder(f: Fixture): string[] {
  const ids = [...f.sources.map((s) => s.id), ...f.playlists.map((p) => `playlist:${p.id}`)];
  if (f.sidebarOrder && f.sidebarOrder.length > 0) {
    const orderMap = new Map(f.sidebarOrder.map((id, i) => [id, i]));
    const names = new Map<string, string>([
      ...f.sources.map((s) => [s.id, s.name] as [string, string]),
      ...f.playlists.map((p) => [`playlist:${p.id}`, p.name] as [string, string]),
    ]);
    ids.sort((a, b) => {
      const oa = orderMap.has(a) ? orderMap.get(a)! : Number.MAX_SAFE_INTEGER;
      const ob = orderMap.has(b) ? orderMap.get(b)! : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return (names.get(a) || a).localeCompare(names.get(b) || b);
    });
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Companion-side extraction (runs the REAL tree builder)
// ---------------------------------------------------------------------------

/** Companion link items are `__plcat_<id>`; the app uses `link:<id>`. */
function normalizeId(id: string): string {
  const m = /^__plcat_(\d+)$/.exec(id);
  return m ? `link:${m[1]}` : id;
}

function companionOrdering(tree: CategoryTree): Map<string, SourceRender> {
  const map = new Map<string, SourceRender>();
  for (const sg of tree.source_groups) {
    map.set(sg.source_id, {
      sourceId: sg.source_id,
      folders: sg.folders.map((f) => ({
        folderId: f.folder_id,
        name: f.name,
        order: 0,
        items: f.categories.map((c) => ({ id: normalizeId(c.id), name: c.name, order: 0 })),
      })),
      root: sg.categories.map((c) => ({ id: normalizeId(c.id), name: c.name, order: 0 })),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Diff + report
// ---------------------------------------------------------------------------

interface SeqItem {
  id: string;
  name: string;
  loc: string;
}

function flatten(render: SourceRender, sourceId: string): SeqItem[] {
  const out: SeqItem[] = [];
  for (const fo of render.folders) {
    for (const it of fo.items) {
      out.push({ id: it.id, name: it.name, loc: `${sourceId} > 📁 ${fo.name}` });
    }
  }
  for (const it of render.root) {
    out.push({ id: it.id, name: it.name, loc: `${sourceId} > root` });
  }
  return out;
}

function diffSequences(app: SeqItem[], comp: SeqItem[]): string[] {
  const issues: string[] = [];
  const compIds = new Set(comp.map((c) => c.id));
  const appIds = new Set(app.map((a) => a.id));
  for (const it of app) {
    if (!compIds.has(it.id)) issues.push(`missing in companion: ${it.loc} ('${it.name}')`);
  }
  for (const it of comp) {
    if (!appIds.has(it.id)) issues.push(`extra in companion: ${it.loc} ('${it.name}')`);
  }
  const common = app.filter((a) => compIds.has(a.id));
  const posA = new Map(common.map((a, i) => [a.id, i]));
  const posB = new Map(comp.filter((c) => appIds.has(c.id)).map((c, i) => [c.id, i]));
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const a = common[i].id;
      const b = common[j].id;
      const relA = posA.get(a)! < posA.get(b)!;
      const relB = posB.get(a)! < posB.get(b)!;
      if (relA !== relB) {
        issues.push(
          `order mismatch: '${a}' should come ${relA ? 'before' : 'after'} '${b}' (app order)`
        );
      }
    }
  }
  const compByName = new Map(comp.map((c) => [c.id, c.name]));
  for (const it of app) {
    const cn = compByName.get(it.id);
    if (cn !== undefined && cn !== it.name) {
      issues.push(`name mismatch for '${it.id}': app='${it.name}' companion='${cn}'`);
    }
  }
  return issues;
}

async function parityIssuesAsync(name: string, f: Fixture): Promise<string[]> {
  const app = appOrdering(f);
  const comp = companionOrdering(await buildCategoryTreeFromData(toInput(f)));
  const issues: string[] = [];

  // 1. Global source order
  const appGlobal = appGlobalOrder(f);
  const compGlobal = [...comp.keys()];
  if (JSON.stringify(appGlobal) !== JSON.stringify(compGlobal)) {
    issues.push(
      `source order mismatch: app=[${appGlobal.join(', ')}] companion=[${compGlobal.join(', ')}]`
    );
  }

  // 2. Per-owner sequences
  for (const sourceId of appGlobal) {
    const appRender = app.get(sourceId);
    const compRender = comp.get(sourceId);
    if (!compRender) {
      issues.push(`missing source in companion: ${sourceId}`);
      continue;
    }
    const seqIssues = diffSequences(flatten(appRender!, sourceId), flatten(compRender, sourceId));
    for (const issue of seqIssues) issues.push(`[${name}] ${sourceId}: ${issue}`);
  }

  return issues;
}

async function expectParity(name: string, f: Fixture): Promise<void> {
  const issues = await parityIssuesAsync(name, f);
  const msg = `[${name}] parity mismatches:\n${issues.map((i) => `  - ${i}`).join('\n') || '(none)'}`;
  expect(issues, msg).toEqual([]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const plain: Fixture = {
  sortOrder: 'default',
  customized: [],
  pinnedCategories: [],
  pinnedFolders: [],
  sources: [
    { id: 's1', name: 'Source One' },
    { id: 's2', name: 'Source Two' },
  ],
  categories: [
    { id: 'cA', name: 'Alpha', source: 's1', order: 1 },
    { id: 'cB', name: 'Bravo', source: 's1', order: 2 },
    { id: 'cC', name: 'Charlie', source: 's2', order: 2 },
    { id: 'cD', name: 'Delta', source: 's2', order: 1 },
  ],
  folders: [],
  links: [],
  playlists: [],
  sidebarOrder: null,
};

const folders: Fixture = {
  ...plain,
  folders: [
    { id: 'f1', name: 'News', owner: 's1', order: 2 },
    { id: 'f2', name: 'Sports', owner: 's1', order: 1 },
  ],
  categories: [
    ...plain.categories.map((c) => (c.source === 's1' && (c.id === 'cA' || c.id === 'cB') ? { ...c, folder: c.id === 'cA' ? 'f2' : 'f1' } : c)),
  ],
};

const displayOrder: Fixture = {
  ...plain,
  // Ties on purpose: order 5 for three items → alphabetical tiebreak.
  categories: [
    { id: 'cA', name: 'Zulu', source: 's1', order: 5 },
    { id: 'cB', name: 'Alpha', source: 's1', order: 5 },
    { id: 'cC', name: 'Mid', source: 's1', order: 1 },
    { id: 'cD', name: 'Delta', source: 's2', order: 1 },
  ],
};

const alphabetical: Fixture = {
  ...plain,
  sortOrder: 'alphabetical',
  categories: [
    { id: 'cA', name: 'Zulu', source: 's1', order: 1 },
    { id: 'cB', name: 'Alpha', source: 's1', order: 2 },
    { id: 'cC', name: 'Mid', source: 's1', order: 3 },
    { id: 'cD', name: 'Delta', source: 's2', order: 1 },
  ],
};

const customizedSource: Fixture = {
  ...alphabetical,
  customized: ['s1'],
};

const pins: Fixture = {
  ...plain,
  pinnedCategories: ['s1:cB', 's1:link:1'],
  pinnedFolders: ['s1:f1'],
  folders: [
    { id: 'f1', name: 'Folder A', owner: 's1', order: 2 },
    { id: 'f2', name: 'Folder B', owner: 's1', order: 1 },
  ],
  categories: [
    { id: 'cA', name: 'Alpha', source: 's1', order: 3 },
    { id: 'cB', name: 'Bravo', source: 's1', order: 2 },
    { id: 'cC', name: 'Charlie', source: 's1', order: 1, folder: 'f1' },
    { id: 'cD', name: 'Delta', source: 's1', order: 4, folder: 'f2' },
    { id: 'cE', name: 'Echo', source: 's2', order: 1 },
  ],
  links: [{ id: 1, owner: 's1', category: 'cA', order: 0 }],
};

const realLinks: Fixture = {
  sortOrder: 'default',
  customized: [],
  pinnedCategories: [],
  pinnedFolders: [],
  sources: [{ id: 's1', name: 'Source One' }],
  categories: [
    { id: 'cA', name: 'Alpha', source: 's1', order: 1 },
    { id: 'cB', name: 'Bravo', source: 's1', order: 2 },
  ],
  folders: [{ id: 'f1', name: 'News', owner: 's1', order: 1 }],
  links: [
    { id: 1, owner: 's1', category: 'cB', order: 5, folder: 'f1' },
    { id: 2, owner: 's1', category: 'cA', customName: 'Extra', order: 3 },
    { id: 3, owner: 's1', category: 'cA', order: 4 },
  ],
  playlists: [],
  sidebarOrder: null,
};

const playlist: Fixture = {
  sortOrder: 'default',
  customized: [],
  pinnedCategories: [],
  pinnedFolders: [],
  sources: [{ id: 's1', name: 'Source One' }],
  categories: [
    { id: 'cA', name: 'Alpha', source: 's1', order: 1 },
    { id: 'cB', name: 'Bravo', source: 's1', order: 2 },
    { id: 'cC', name: 'Charlie', source: 's1', order: 3 },
    { id: 'cD', name: 'Delta', source: 's1', order: 4 },
  ],
  folders: [
    { id: 'pf1', name: 'Playlist Folder', owner: 'pl1', order: 2 },
    { id: 'pf2', name: 'Playlist Folder B', owner: 'pl1', order: 1 },
  ],
  links: [
    { id: 1, owner: 'pl1', category: 'cA', order: 5, folder: 'pf1' },
    { id: 2, owner: 'pl1', category: 'cB', order: 1 },
    { id: 3, owner: 'pl1', category: 'cC', order: 4, folder: 'pf2' },
    { id: 4, owner: 'pl1', category: 'cD', order: 2 },
  ],
  playlists: [{ id: 'pl1', name: 'My Playlist' }],
  sidebarOrder: null,
};

const onlyLinksSource: Fixture = {
  ...plain,
  sources: [{ id: 'sEmpty', name: 'Links Only' }],
  categories: [],
  folders: [],
  links: [
    { id: 1, owner: 'sEmpty', category: 'cA', order: 2 },
    { id: 2, owner: 'sEmpty', category: 'cB', order: 1 },
  ],
};

const sidebarOrdered: Fixture = {
  ...plain,
  playlists: [{ id: 'pl1', name: 'Zed Playlist' }],
  links: [
    { id: 1, owner: 'pl1', category: 'cA', order: 2 },
    { id: 2, owner: 'pl1', category: 'cB', order: 1 },
  ],
  sidebarOrder: ['s2', 'playlist:pl1', 's1'],
};

// Deterministic seeded RNG so the random profile is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomProfile(seed: number, sortOrder: string, customized: string[]): Fixture {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const int = (n: number) => Math.floor(rnd() * n);

  const sources = ['s1', 's2', 's3'].map((id, i) => ({ id, name: `Source ${['One', 'Two', 'Three'][i]}` }));
  const playlists = ['pl1', 'pl2'].map((id, i) => ({ id, name: `Playlist ${i + 1}` }));
  const catIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13', 'c14'];

  const categories = catIds.map((id, i) => ({
    id,
    name: `Category ${String.fromCharCode(65 + i)}`,
    alias: rnd() < 0.4 ? `Alias ${i}` : null,
    source: pick(sources).id,
    order: rnd() < 0.3 ? null : int(8),
    folder: null as string | null,
  }));

  // Folders: 2 per source + 1 per playlist, assigned to a subset of categories.
  const folders: Fixture['folders'] = [];
  for (const s of sources) {
    for (let i = 0; i < 2; i++) {
      const fid = `${s.id}_f${i}`;
      folders.push({ id: fid, name: `Folder ${fid}`, owner: s.id, order: i });
      let assigned = 0;
      for (const c of categories) {
        if (c.source === s.id && c.folder === null && rnd() < 0.25 && assigned < 2) {
          c.folder = fid;
          assigned++;
        }
      }
    }
  }
  for (const p of playlists) {
    folders.push({ id: `${p.id}_f0`, name: `Folder ${p.id}`, owner: p.id, order: 1 });
    folders.push({ id: `${p.id}_f1`, name: `Folder ${p.id}b`, owner: p.id, order: 0 });
  }

  // Links: ~8, split between real sources and playlists, sometimes in folders.
  const links: Fixture['links'] = [];
  for (let i = 1; i <= 8; i++) {
    const toPlaylist = rnd() < 0.5;
    const owner = toPlaylist ? pick(playlists).id : pick(sources).id;
    const category = pick(categories).id;
    const ownerFolders = folders.filter((fo) => fo.owner === owner);
    const folder = ownerFolders.length > 0 && rnd() < 0.4 ? pick(ownerFolders).id : null;
    links.push({
      id: i,
      owner,
      category,
      customName: rnd() < 0.3 ? `Custom ${i}` : null,
      order: int(8),
      folder,
    });
  }

  const pinnedCategories = [
    ...categories.filter((c) => rnd() < 0.2).map((c) => `${c.source}:${c.id}`),
    ...links.filter((l) => rnd() < 0.3).map((l) => `${l.owner}:link:${l.id}`),
  ];
  const pinnedFolders = folders.filter((fo) => rnd() < 0.25).map((fo) => `${fo.owner}:${fo.id}`);

  return {
    sortOrder,
    customized,
    pinnedCategories,
    pinnedFolders,
    sources,
    categories,
    folders,
    links,
    playlists,
    sidebarOrder: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phone remote category tree parity with CategoryStrip', () => {
  it('plain default ordering', async () => {
    await expectParity('plain', plain);
  });

  it('folders distribute and sort (pinned-first, display_order)', async () => {
    await expectParity('folders', folders);
  });

  it('display_order with alphabetical tiebreak', async () => {
    await expectParity('displayOrder', displayOrder);
  });

  it('alphabetical preference (uncustomized source)', async () => {
    await expectParity('alphabetical', alphabetical);
  });

  it('alphabetical preference ignored for drag-customized source', async () => {
    await expectParity('customizedSource', customizedSource);
  });

  it('pinned categories and pinned folders', async () => {
    await expectParity('pins', pins);
  });

  it('real-source custom playlist links (root + folder + pinned)', async () => {
    await expectParity('realLinks', realLinks);
  });

  it('custom playlist pure rule (no pins, no name tiebreak) + folders', async () => {
    await expectParity('playlist', playlist);
  });

  it('real source containing only links', async () => {
    await expectParity('onlyLinksSource', onlyLinksSource);
  });

  it('sidebar source order preference', async () => {
    await expectParity('sidebarOrdered', sidebarOrdered);
  });

  it('seeded random profile (default order)', async () => {
    await expectParity('random-default', randomProfile(42, 'default', []));
  });

  it('seeded random profile (alphabetical + one customized source)', async () => {
    await expectParity('random-alphabetical', randomProfile(1337, 'alphabetical', ['s2']));
  });
});
