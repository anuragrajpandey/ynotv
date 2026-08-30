/**
 * sidebarRowModel.ts
 *
 * Flattened row model for the LiveTV sidebar (CategoryStrip). Produces one
 * linear list of rows (source/playlist headers, folder headers, categories,
 * playlist links, special rows) that mirrors EXACTLY what the current
 * per-source renderer displays — same ordering rules, same expansion/search
 * semantics, same pinned flags. This is the data layer for virtualizing the
 * sidebar: the renderer still uses its own JSX for now, but the model is the
 * single source of truth for what rows exist and in what order.
 *
 * Pure and type-import-only (no React/DOM/tauri runtime deps) so it runs
 * under vitest, like categorySortRules.ts.
 */
import { comparePlaylistCategory, compareSidebarCategory, compareSidebarFolder } from './categorySortRules';
import { getCustomizedCategorySortOrders } from './categorySortOverrides';
import type { CategoryFolder, CustomPlaylist, PlaylistCategoryLink } from '../db';
import type { SourceWithCategories } from '../hooks/useChannels';

export type SidebarRowType = 'source' | 'playlist' | 'folder' | 'category' | 'link' | 'special';

export interface SourceHeaderRow {
  type: 'source';
  key: string;
  sourceId: string;
  name: string;
  count: number;
  expanded: boolean;
}

export interface PlaylistHeaderRow {
  type: 'playlist';
  key: string;
  playlistId: string;
  name: string;
  count: number;
  expanded: boolean;
}

export interface FolderHeaderRow {
  type: 'folder';
  key: string;
  ownerId: string; // source_id or playlist_id that owns the folder
  folderId: string;
  name: string;
  count: number;
  expanded: boolean;
  pinned: boolean;
}

export interface CategoryRow {
  type: 'category';
  key: string;
  sourceId: string;
  categoryId: string;
  name: string;
  count: number;
  pinned: boolean;
  folderChild: boolean;
  /** folder_id the category belongs to (null when root or unknown folder). */
  folderId: string | null;
}

export interface LinkRow {
  type: 'link';
  key: string;
  playlistId: string;
  linkId: number;
  categoryId: string;
  name: string;
  count: number;
  pinned: boolean;
  folderChild: boolean;
  /** folder_id the link belongs to (null when root or unknown folder). */
  folderId: string | null;
}

export interface SpecialRow {
  type: 'special';
  key: string;
  ownerId: string; // source_id or playlist_id this row belongs to
  kind: 'allChannels' | 'favorites' | 'individual' | 'empty';
  count: number;
}

export type SidebarRow = SourceHeaderRow | PlaylistHeaderRow | FolderHeaderRow | CategoryRow | LinkRow | SpecialRow;

export interface SidebarRowsInput {
  /** Sources with categories, already search-filtered (filteredGroupedCategories). */
  groupedCategories: SourceWithCategories[];
  customPlaylists?: CustomPlaylist[] | null;
  allPlaylistCategoryLinks?: PlaylistCategoryLink[] | null;
  allCategoryFolders?: CategoryFolder[] | null;
  /** category_id -> alias || category_name (for playlist link names). */
  categoryNamesMap?: Map<string, string> | null;
  totalPlaylistIndividualCounts?: Map<string, number> | null;
  flatPlaylistIndividualCounts?: Map<string, number> | null;
  manualCategoryChannelCounts?: Map<string, number> | null;
  sources: Record<string, string>;
  sidebarSourcesOrder?: string[] | null;
  expandedSources: Record<string, boolean>;
  expandedPlaylists: Record<string, boolean>;
  expandedFolders: Record<string, boolean>;
  pinnedCategories: string[];
  pinnedFolders: string[];
  categorySortOrder?: string;
  favoritesMode: string;
  perSourceFavoriteCounts?: Map<string, number> | null;
  includeAllChannelsToPlaylist: boolean;
  searchQuery: string;
}

interface RealEntry {
  id: string;
  kind: 'category' | 'link';
  name: string;
  count: number;
  displayOrder: number;
  folderId: string | null;
  pinned: boolean;
  categoryId?: string;
  linkId?: number;
}

interface SourceItem {
  id: string;
  type: 'real' | 'playlist';
  name: string;
  count: number;
  expanded: boolean;
  categories?: SourceWithCategories['categories'];
  customLinks?: PlaylistCategoryLink[];
  playlist?: CustomPlaylist;
  playlistLinks?: PlaylistCategoryLink[];
  individualCount: number;
}

/** Build the flattened sidebar row list in display order. */
export function buildSidebarRows(input: SidebarRowsInput): SidebarRow[] {
  const rows: SidebarRow[] = [];
  const links = input.allPlaylistCategoryLinks ?? [];
  const searching = input.searchQuery.trim().length > 0;
  const manual = input.manualCategoryChannelCounts ?? new Map<string, number>();
  const nameForLink = (l: PlaylistCategoryLink) =>
    l.custom_name || input.categoryNamesMap?.get(l.category_id) || l.category_id;

  // categoryChannelCounts is derived exactly like CategoryStrip: from the
  // (already search-filtered) grouped categories.
  const categoryChannelCounts = new Map<string, number>();
  for (const g of input.groupedCategories) {
    for (const c of g.categories) categoryChannelCounts.set(c.category_id, c.channelCount);
  }

  // Assemble sources/playlists in sidebar order (mirrors combinedSources).
  const items: SourceItem[] = [];
  for (const group of input.groupedCategories) {
    const customLinks = links.filter((l) => l.playlist_id === group.sourceId);
    const individualCount = input.totalPlaylistIndividualCounts?.get(group.sourceId) || 0;
    let count = group.categories.reduce((s, c) => s + c.channelCount, 0);
    for (const l of customLinks) count += categoryChannelCounts.get(l.category_id) || 0;
    count += individualCount;
    items.push({
      id: group.sourceId,
      type: 'real',
      name: input.sources[group.sourceId] || 'Loading',
      count,
      categories: group.categories,
      customLinks,
      individualCount,
      expanded: !!input.expandedSources[group.sourceId] || searching,
    });
  }
  for (const p of input.customPlaylists ?? []) {
    const playlistLinks = links.filter((l) => l.playlist_id === p.playlist_id);
    const individualCount = input.flatPlaylistIndividualCounts?.get(p.playlist_id) || 0;
    let total = 0;
    for (const l of playlistLinks) {
      total += (categoryChannelCounts.get(l.category_id) || 0) + (manual.get(`${p.playlist_id}:link:${l.id}`) || 0);
    }
    total += individualCount;
    items.push({
      id: `playlist:${p.playlist_id}`,
      type: 'playlist',
      name: p.name,
      count: total,
      playlist: p,
      playlistLinks,
      individualCount,
      expanded: !!input.expandedPlaylists[p.playlist_id],
    });
  }
  if (input.sidebarSourcesOrder) {
    const orderMap = new Map(input.sidebarSourcesOrder.map((id, i) => [id, i]));
    items.sort((a, b) => {
      const oa = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
      const ob = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
  }

  const customizedSourceIds = new Set(getCustomizedCategorySortOrders());

  for (const item of items) {
    if (item.type === 'real' && item.categories) {
      rows.push({ type: 'source', key: item.id, sourceId: item.id, name: item.name, count: item.count, expanded: item.expanded });
      if (!item.expanded) continue;

      if (input.includeAllChannelsToPlaylist) {
        rows.push({ type: 'special', key: `__allsrc_${item.id}`, ownerId: item.id, kind: 'allChannels', count: item.count });
      }
      const favCount = input.perSourceFavoriteCounts?.get(item.id) || 0;
      if ((input.favoritesMode === 'perSource' || input.favoritesMode === 'both') && favCount > 0) {
        rows.push({ type: 'special', key: `__favsrc_${item.id}`, ownerId: item.id, kind: 'favorites', count: favCount });
      }

      const entries: RealEntry[] = [];
      for (const cat of item.categories) {
        entries.push({
          id: cat.category_id,
          kind: 'category',
          name: cat.alias || cat.category_name,
          count: cat.channelCount + (manual.get(`${item.id}:${cat.category_id}`) || 0),
          displayOrder: cat.display_order ?? 0,
          folderId: cat.folder_id || null,
          pinned: input.pinnedCategories.includes(`${item.id}:${cat.category_id}`),
          categoryId: cat.category_id,
        });
      }
      for (const l of item.customLinks ?? []) {
        const count = (categoryChannelCounts.get(l.category_id) || 0) + (manual.get(`${item.id}:link:${l.id}`) || 0);
        entries.push({
          id: `link:${l.id}`,
          kind: 'link',
          name: nameForLink(l),
          count,
          displayOrder: l.display_order ?? 0,
          folderId: l.folder_id || null,
          pinned: input.pinnedCategories.includes(`${item.id}:link:${l.id}`),
          categoryId: l.category_id,
          linkId: l.id,
        });
      }
      entries.sort((a, b) =>
        compareSidebarCategory(
          { id: a.id, name: a.name, displayOrder: a.displayOrder },
          { id: b.id, name: b.name, displayOrder: b.displayOrder },
          {
            categorySortOrder: input.categorySortOrder,
            pinnedCategories: new Set(input.pinnedCategories),
            customizedSourceIds,
          },
          item.id
        )
      );

      appendEntries(rows, item.id, entries, input, searching);

      if (item.individualCount > 0) {
        rows.push({ type: 'special', key: `__plindiv_${item.id}`, ownerId: item.id, kind: 'individual', count: item.individualCount });
      }
    } else if (item.type === 'playlist' && item.playlist) {
      const playlist = item.playlist;
      const playlistId = playlist.playlist_id;
      rows.push({ type: 'playlist', key: item.id, playlistId, name: item.name, count: item.count, expanded: item.expanded });
      if (!item.expanded) continue;

      if (input.includeAllChannelsToPlaylist) {
        rows.push({ type: 'special', key: `__allsrc_pl_${playlistId}`, ownerId: playlistId, kind: 'allChannels', count: item.count });
      }

      const playlistLinks = [...(item.playlistLinks ?? [])].sort((a, b) =>
        comparePlaylistCategory(
          { id: String(a.id), name: nameForLink(a), displayOrder: a.display_order },
          { id: String(b.id), name: nameForLink(b), displayOrder: b.display_order },
          { categorySortOrder: input.categorySortOrder, customizedSourceIds },
          playlistId
        )
      );

      const linkEntries: RealEntry[] = playlistLinks.map((l) => ({
        id: `link:${l.id}`,
        kind: 'link',
        name: nameForLink(l),
        count: (categoryChannelCounts.get(l.category_id) || 0) + (manual.get(`${playlistId}:link:${l.id}`) || 0),
        displayOrder: l.display_order ?? 0,
        folderId: l.folder_id || null,
        pinned: input.pinnedCategories.includes(`${playlistId}:link:${l.id}`),
        categoryId: l.category_id,
        linkId: l.id,
      }));

      appendEntries(rows, playlistId, linkEntries, input, searching);

      if (item.individualCount > 0) {
        rows.push({ type: 'special', key: `__plindiv_${playlistId}`, ownerId: playlistId, kind: 'individual', count: item.individualCount });
      }
      if (playlistLinks.length === 0 && item.individualCount === 0) {
        rows.push({ type: 'special', key: `empty_${item.id}`, ownerId: playlistId, kind: 'empty', count: 0 });
      }
    }
  }

  return rows;
}

/** Folder partition + folder rows + child rows, mirroring the renderer. */
function appendEntries(
  rows: SidebarRow[],
  ownerId: string,
  entries: RealEntry[],
  input: SidebarRowsInput,
  searching: boolean
): void {
  const folders = (input.allCategoryFolders ?? []).filter((f) => f.playlist_id === ownerId);
  const folderMap = new Map<string, RealEntry[]>();
  const rootEntries: RealEntry[] = [];
  for (const e of entries) {
    if (e.folderId && folders.some((f) => f.folder_id === e.folderId)) {
      if (!folderMap.has(e.folderId)) folderMap.set(e.folderId, []);
      folderMap.get(e.folderId)!.push(e);
    } else {
      rootEntries.push(e);
    }
  }

  const sortedFolders = [...folders].sort((a, b) =>
    compareSidebarFolder(a, b, { pinnedFolders: new Set(input.pinnedFolders) }, ownerId)
  );

  for (const folder of sortedFolders) {
    const folderEntries = folderMap.get(folder.folder_id) || [];
    if (searching && folderEntries.length === 0) continue;
    const isPinned = input.pinnedFolders.includes(`${ownerId}:${folder.folder_id}`);
    const expanded = !!input.expandedFolders[folder.folder_id] || searching;
    rows.push({
      type: 'folder',
      key: `${ownerId}:${folder.folder_id}`,
      ownerId,
      folderId: folder.folder_id,
      name: folder.name,
      count: folderEntries.reduce((s, e) => s + e.count, 0),
      expanded,
      pinned: isPinned,
    });
    if (expanded) {
      for (const e of folderEntries) rows.push(toRow(ownerId, e, true));
    }
  }
  for (const e of rootEntries) rows.push(toRow(ownerId, e, false));
}

function toRow(ownerId: string, e: RealEntry, folderChild: boolean): SidebarRow {
  if (e.kind === 'category') {
    return {
      type: 'category',
      key: `${ownerId}:${e.id}`,
      sourceId: ownerId,
      categoryId: e.categoryId!,
      name: e.name,
      count: e.count,
      pinned: e.pinned,
      folderChild,
      folderId: e.folderId ?? null,
    };
  }
  return {
    type: 'link',
    key: `${ownerId}:${e.id}`,
    playlistId: ownerId,
    linkId: e.linkId!,
    categoryId: e.categoryId!,
    name: e.name,
    count: e.count,
    pinned: e.pinned,
    folderChild,
    folderId: e.folderId ?? null,
  };
}

/** Interface for rows that carry the pinned flag (categories, links, folders). */
export type PinnableRow = Extract<SidebarRow, { pinned: boolean }>;

export function isPinnableRow(r: SidebarRow): r is PinnableRow {
  return 'pinned' in r;
}

/**
 * Compute which pinned rows are currently "stuck" (fully scrolled above the top
 * of the virtualized viewport). Drives the Slice-3 pinned overlay: each pinned
 * row keeps its natural slot in the flattened list (so height/scroll position
 * are reserved and scroll-to-selected targets its logical index), and a pin is
 * shown in the overlay only once its own top has scrolled past, so a pin always
 * has exactly one live copy (its slot row is unmounted by the virtualizer once
 * it leaves the viewport). Returns stuck pins in natural row order.
 */

/** One row rendered in the sticky overlay, with its cumulative top offset and z-index. */
export interface StickyOverlayRow {
  row: SidebarRow;
  top: number;
  zIndex: number;
}

/** A row position reported by the virtualizer after it has been measured. */
export interface SidebarRowMeasurement {
  start: number;
  size: number;
}

// Source/playlist headers are 40px tall (matches the renderer estimator).
const SECTION_HEADER_HEIGHT = 40;

/**
 * Compute which rows are sticky at the viewport top for a given scrollTop,
 * replicating the legacy sidebar's native `position: sticky` header stack:
 *
 *  1. The ACTIVE source/playlist header (the section containing scrollTop) sticks
 *     at top: 0 ONLY IF EXPANDED. Collapsed sources are never position:sticky in
 *     legacy CSS (.category-source-group.is-expanded only) and remain in normal
 *     flow in the virtualized list so they scroll past naturally without locking
 *     or causing out-of-order takeover glitches.
 *  2. Below an active expanded header, currently-stuck pinned categories/links
 *     and pinned/expanded folders stack at cumulative slots (base 40, +34 for folder,
 *     +38 for category/link).
 *  3. In native CSS sticky, each element sticks within its containing block:
 *       visualTop = min(targetSlot, containerRemaining - height)
 *     - The source header (slot 0, height 40, zIndex 100) stays glued at top 0
 *       all the way until containerRemaining < 40, and then slides smoothly
 *       from 0 to -40 as the next section approaches from 40 to 0.
 *     - Pinned rows (slot 40, 78, etc. with lower z-index) slide up under the
 *       header as containerRemaining < slot + height.
 *  4. Stuck rows are kept in the overlay as long as visualTop + height > 0.
 *
 * Returns `{ row, top, zIndex }` in overlay render order; empty at scrollTop <= 0.
 */
export function computeStickyOverlay(
  rows: SidebarRow[],
  heightOf: (row: SidebarRow) => number,
  scrollTop: number,
  measurementsByKey?: ReadonlyMap<string, SidebarRowMeasurement>
): StickyOverlayRow[] {
  if (scrollTop <= 0 || rows.length === 0) return [];

  // Precompute absolute tops + heights for cheap indexing below.
  const hs = rows.map((r) => measurementsByKey?.get(r.key)?.size ?? heightOf(r));
  const tops: number[] = new Array(rows.length);
  let acc = 0;
  for (let i = 0; i < rows.length; i++) {
    const measuredStart = measurementsByKey?.get(rows[i].key)?.start;
    tops[i] = measuredStart ?? acc;
    acc = Math.max(acc, tops[i] + hs[i]);
  }
  const total = acc;

  // Pass 1: find sections and folder boundaries.
  interface SectionInfo {
    key: string;
    ownerId: string;
    headerRow: SidebarRow;
    start: number;
    end: number;
    expanded: boolean;
    headerIndex: number;
  }

  const sections: SectionInfo[] = [];
  let lastSecIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === 'source' || r.type === 'playlist') {
      if (lastSecIdx >= 0) {
        sections[lastSecIdx].end = tops[i];
      }
      const isExpanded = r.expanded;
      const ownerId = r.type === 'source' ? r.sourceId : r.playlistId;
      sections.push({
        key: r.key,
        ownerId,
        headerRow: r,
        start: tops[i],
        end: tops[i] + hs[i],
        expanded: isExpanded,
        headerIndex: i,
      });
      lastSecIdx = sections.length - 1;
    }
  }
  if (lastSecIdx >= 0) {
    sections[lastSecIdx].end = total;
  }

  // Per-folder end = bottom of its last child row
  const folderEnds = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type !== 'folder') continue;
    let end = tops[i] + hs[i];
    for (let j = i + 1; j < rows.length; j++) {
      const c = rows[j];
      const isChild =
        (c.type === 'category' || c.type === 'link') &&
        c.folderChild &&
        c.folderId === r.folderId &&
        ownerOfRow(c) === r.ownerId;
      if (!isChild) break;
      end = tops[j] + hs[j];
    }
    folderEnds.set(r.key, end);
  }

  // Pass 2: Active section = the section spanning [start, end) containing scrollTop.
  // In legacy CSS, only EXPANDED sources/playlists are position:sticky. Collapsed
  // sources scroll in normal flow.
  const activeSection = sections.find((s) => s.start <= scrollTop && scrollTop < s.end);
  if (!activeSection || !activeSection.expanded) {
    return [];
  }

  interface CandidateSticky {
    row: SidebarRow;
    naturalTop: number;
    height: number;
    targetSlot: number;
    containerEnd: number;
    zIndex: number;
  }

  const candidates: CandidateSticky[] = [];

  // Active section header sticks at top: 0 with zIndex: 100
  const headerHeight = hs[activeSection.headerIndex];
  candidates.push({
    row: activeSection.headerRow,
    naturalTop: activeSection.start,
    height: headerHeight,
    targetSlot: 0,
    containerEnd: activeSection.end,
    zIndex: 100,
  });

  let pinStackTop = headerHeight; // base 40px

  // Collect pinned rows / expanded folders within this active section
  for (let i = activeSection.headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.type === 'source' || r.type === 'playlist') break; // next section
    if (ownerOfRow(r) !== activeSection.ownerId) continue;

    const rowH = hs[i];
    const rowTop = tops[i];

    if (r.type === 'category' || r.type === 'link') {
      if (r.pinned) {
        const slot = pinStackTop;
        pinStackTop += rowH;
        if (rowTop <= scrollTop + slot) {
          candidates.push({
            row: r,
            naturalTop: rowTop,
            height: rowH,
            targetSlot: slot,
            containerEnd: activeSection.end,
            zIndex: r.folderChild ? 90 : 99,
          });
        }
      }
    } else if (r.type === 'folder') {
      if (r.pinned) {
        const slot = pinStackTop;
        pinStackTop += rowH;
        if (rowTop <= scrollTop + slot) {
          candidates.push({
            row: r,
            naturalTop: rowTop,
            height: rowH,
            targetSlot: slot,
            containerEnd: activeSection.end,
            zIndex: 96,
          });
        }
      } else if (r.expanded) {
        // Unpinned expanded folder header sticks below the current pin stack
        const slot = pinStackTop;
        const fEnd = folderEnds.get(r.key) ?? (rowTop + rowH);
        if (rowTop <= scrollTop + slot) {
          candidates.push({
            row: r,
            naturalTop: rowTop,
            height: rowH,
            targetSlot: slot,
            containerEnd: fEnd,
            zIndex: 95,
          });
        }
      }
    }
  }

  const out: StickyOverlayRow[] = [];

  for (const c of candidates) {
    const containerRemaining = c.containerEnd - scrollTop;
    const visualTop = Math.min(c.targetSlot, containerRemaining - c.height);

    if (visualTop + c.height > 0) {
      out.push({
        row: c.row,
        top: visualTop,
        zIndex: c.zIndex,
      });
    }
  }

  return out;
}

/**
 * A drag entry in the shape the legacy `handleCategoryDragEnd` persistence
 * handler expects: `id` is the *persistence* id (raw `category_id` for native
 * categories, `link:<id>` for playlist links) — NOT the namespaced row key.
 * The handler only uses `id` for findIndex (active vs over), and persists via
 * the attached `nativeCat`/`customLink` objects.
 */
export interface OwnerDragItem {
  id: string | number;
  type: 'native' | 'link';
  nativeCat?: unknown;
  customLink?: unknown;
}

/**
 * Build the ordered drag list for one owner (source or playlist) in the
 * persistence-id shape, plus a row-key -> persistence-id map so the dnd event's
 * active/over ids can be translated before reaching the shared handler.
 *
 * The virtualized sidebar sorts by globally-namespaced row keys
 * (`<ownerId>:<id>`), but the legacy handler's contract is that event ids and
 * list ids match each other — and they are conventionally the raw persistence
 * ids. Translating both sides here keeps the virtual path id-compatible with
 * the legacy handler no matter how it evolves.
 */
export function resolveOwnerDragState(
  rows: SidebarRow[],
  ownerId: string,
  nativeById: Map<string, unknown>,
  linkById: Map<number, unknown>
): { items: OwnerDragItem[]; persistenceIdByKey: Map<string, string | number> } {
  const items: OwnerDragItem[] = [];
  const persistenceIdByKey = new Map<string, string | number>();
  for (const r of rows) {
    if (r.type === 'category' && r.sourceId === ownerId) {
      const cat = nativeById.get(r.categoryId);
      if (!cat) continue;
      const id = (cat as { category_id: string | number }).category_id;
      items.push({ id, type: 'native', nativeCat: cat });
      persistenceIdByKey.set(r.key, id);
    } else if (r.type === 'link' && r.playlistId === ownerId) {
      const link = linkById.get(r.linkId);
      if (!link) continue;
      const id = `link:${(link as { id: number }).id}`;
      items.push({ id, type: 'link', customLink: link });
      persistenceIdByKey.set(r.key, id);
    }
  }
  return { items, persistenceIdByKey };
}

/** Owner of a section row (source/playlist header for category/link/folder rows). */
export function ownerOfRow(row: SidebarRow): string {
  if (row.type === 'category') return row.sourceId;
  if (row.type === 'link') return row.playlistId;
  if (row.type === 'folder') return row.ownerId;
  if (row.type === 'special') return row.ownerId;
  return '';
}
