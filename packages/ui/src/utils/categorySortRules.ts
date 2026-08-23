/**
 * categorySortRules.ts
 *
 * Canonical ordering rules for the LiveTV sidebar (CategoryStrip), extracted
 * verbatim from its inline sort blocks so the phone-remote companion tree can
 * reuse them and provably produce the same order. Keep this module free of
 * React/DOM/tauri dependencies so it runs under vitest.
 */

/** One sortable category row (native category or playlist link). */
export interface SortableSidebarCategory {
  id: string;
  name: string;
  displayOrder?: number;
  /**
   * Precomputed pin key. When absent, falls back to `${ownerId}:${id}` —
   * the exact key CategoryStrip builds inline (e.g. `srcId:catId`,
   * `srcId:link:12`).
   */
  pinnedKey?: string;
}

/** One sortable folder row. */
export interface SortableSidebarFolder {
  folder_id: string;
  display_order?: number;
}

export interface CategorySortContext {
  /** The `categorySortOrder` preference ('default' | 'alphabetical' | ...). */
  categorySortOrder?: string;
  /** Set of pinned category keys, e.g. 'srcId:catId'. */
  pinnedCategories?: ReadonlySet<string>;
  /** Set of pinned folder keys, e.g. 'ownerId:folderId'. */
  pinnedFolders?: ReadonlySet<string>;
  /** Source/playlist ids whose order was drag-customized. */
  customizedSourceIds?: ReadonlySet<string>;
}

/** True when the user chose alphabetical order AND the owner wasn't drag-customized. */
export function isAlphabeticalFor(
  ctx: CategorySortContext,
  ownerId: string
): boolean {
  return (
    ctx.categorySortOrder === 'alphabetical' &&
    !(ctx.customizedSourceIds?.has(ownerId) ?? false)
  );
}

/**
 * Real-source category ordering (CategoryStrip): pinned first, then either
 * alphabetical (when the alphabetical preference is set and the source isn't
 * drag-customized) or display_order with an alphabetical name tiebreak.
 */
export function compareSidebarCategory(
  a: SortableSidebarCategory,
  b: SortableSidebarCategory,
  ctx: CategorySortContext,
  ownerId: string
): number {
  const pins = ctx.pinnedCategories;
  const aPinned = pins?.has(a.pinnedKey ?? `${ownerId}:${a.id}`) ?? false;
  const bPinned = pins?.has(b.pinnedKey ?? `${ownerId}:${b.id}`) ?? false;
  if (aPinned && !bPinned) return -1;
  if (!aPinned && bPinned) return 1;
  if (isAlphabeticalFor(ctx, ownerId)) {
    return a.name.localeCompare(b.name);
  }
  const ao = a.displayOrder ?? 0;
  const bo = b.displayOrder ?? 0;
  if (ao !== bo) return ao - bo;
  return a.name.localeCompare(b.name);
}

/**
 * Playlist category ordering (CategoryStrip): pure alphabetical when the
 * alphabetical preference is set (no pins), otherwise pure display_order —
 * playlists deliberately ignore pins and the name tiebreak.
 */
export function comparePlaylistCategory(
  a: SortableSidebarCategory,
  b: SortableSidebarCategory,
  ctx: CategorySortContext,
  ownerId: string
): number {
  if (isAlphabeticalFor(ctx, ownerId)) {
    return a.name.localeCompare(b.name);
  }
  return (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
}

/**
 * Folder ordering (CategoryStrip, used for both real sources and playlists):
 * pinned folders first, then display_order.
 */
export function compareSidebarFolder(
  a: SortableSidebarFolder,
  b: SortableSidebarFolder,
  ctx: CategorySortContext,
  ownerId: string
): number {
  const pins = ctx.pinnedFolders;
  const aPinned = pins?.has(`${ownerId}:${a.folder_id}`) ?? false;
  const bPinned = pins?.has(`${ownerId}:${b.folder_id}`) ?? false;
  if (aPinned && !bPinned) return -1;
  if (!aPinned && bPinned) return 1;
  return (a.display_order ?? 0) - (b.display_order ?? 0);
}

/**
 * Read a JSON array of keys (pinned categories / folders) from localStorage.
 * Tolerates a missing storage API so it can run in node (vitest) too.
 */
export function readStoredKeys(key: string): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const saved = localStorage.getItem(key);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
