/**
 * usePhoneRemoteCompanion.ts
 *
 * Provides real-time synchronization between YNOTV desktop app and the
 * embedded Virtual Phone Remote web companion.
 *
 * Highly optimized for instant response:
 * - Category tree mirrors the exact ordering of LiveTV sidebar (Sources, Custom Playlists, Folders, Categories)
 * - Category channel queries use indexed stream lookups & SQL WHERE (instant sub-10ms response)
 * - Search runs indexed SQL query
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { db } from '../db';
import type {
  StoredChannel,
  StoredCategory,
  StoredProgram,
  CategoryFolder,
  CustomGroup,
  CustomPlaylist,
  PlaylistCategoryLink,
  PlaylistIndividualChannel,
} from '../db';
import {
  comparePlaylistCategory,
  compareSidebarCategory,
  compareSidebarFolder,
  readStoredKeys,
} from '../utils/categorySortRules';
import { useTeamChannelLinksStore, getTeamLinks } from '../stores/teamChannelLinksStore';
import { getGameStreamsForEvent } from '../services/sports/gameStreamSearcher';
import { buildTeamSearchQuery, buildTeamSearchQueries } from '../services/sports/teamChannelMatcher';
import { getStatusDisplay } from '../services/sports/utils';
import { isEventLiveOrPastStart } from '../services/sports';
import { getRecentChannels } from '../utils/recentChannels';
import { getCustomizedCategorySortOrders } from '../utils/categorySortOverrides';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { applyFilterWordsDetailed } from './useFilterWords';
import { parseCategoryIds } from './useChannels';
import type { LayoutMode, ViewerSlot } from './useMultiview';
import { getSportsCacheEvents, isSportsCacheFresh, subscribeSportsCache } from './useSportsPolling';

// Mirror the app guide's channel ordering (the final sort in useChannels.ts)
// so the remote shows the same order as the desktop for standard categories
// and playlist category links. The remote renders channels in received order,
// so this must match the app's sortOrder comparator exactly.
function guideSortComparator(sortOrder: 'alphabetical' | 'number' | 'provider') {
  return (a: StoredChannel, b: StoredChannel): number => {
    if (sortOrder === 'provider') {
      const aOrder = a.provider_order;
      const bOrder = b.provider_order;
      if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
      return 0;
    }
    if (sortOrder === 'number') {
      const aNum = a.channel_num;
      const bNum = b.channel_num;
      if (aNum !== undefined && bNum !== undefined) return aNum - bNum;
      if (aNum !== undefined) return -1;
      if (bNum !== undefined) return 1;
      return (a.alias || a.name).localeCompare(b.alias || b.name);
    }
    return (a.alias || a.name).localeCompare(b.alias || b.name);
  };
}

function applyGuideSortOrder(
  channels: StoredChannel[],
  sortOrder: 'alphabetical' | 'number' | 'provider'
): StoredChannel[] {
  return channels.sort(guideSortComparator(sortOrder));
}

/**
 * Apply a category's filter words to a channel's alias/name, mirroring the
 * desktop guide (useChannels.ts) so the remote shows the same cleaned names.
 */
function applyFilterWordsToChannel(ch: StoredChannel, filterWords: string[]): StoredChannel {
  const next: StoredChannel = { ...ch };
  if (ch.alias) {
    next.alias = applyFilterWordsDetailed(ch.alias, filterWords).text;
  }
  next.name = applyFilterWordsDetailed(ch.name, filterWords).text;
  return next;
}

/**
 * Apply each channel's home-category filter words, mirroring the desktop's
 * applyHomeCategoryFilterWords — used by the virtual Favorites and Recently
 * Viewed views, which span many categories with no single filter_words list.
 */
async function applyHomeCategoryFilterWords(results: StoredChannel[]): Promise<StoredChannel[]> {
  if (results.length === 0) return results;
  const categoryIds = new Set<string>();
  for (const ch of results) {
    for (const id of parseCategoryIds(ch.category_ids)) {
      categoryIds.add(id);
    }
  }
  if (categoryIds.size === 0) return results;
  const cats = await db.categories.where('category_id').anyOf(Array.from(categoryIds)).toArray();
  const wordsByCategory = new Map<string, string[]>();
  for (const cat of cats) {
    if (cat.filter_words && cat.filter_words.length > 0) {
      wordsByCategory.set(cat.category_id, cat.filter_words);
    }
  }
  if (wordsByCategory.size === 0) return results;
  return results.map(ch => {
    const words = new Set<string>();
    for (const id of parseCategoryIds(ch.category_ids)) {
      const fw = wordsByCategory.get(id);
      if (fw) {
        for (const w of fw) {
          if (w && w.trim()) words.add(w.trim());
        }
      }
    }
    if (words.size === 0) return ch;
    return applyFilterWordsToChannel(ch, Array.from(words));
  });
}

/**
 * Build the final ordered channel list for a standard category or playlist
 * category link, mirroring the desktop guide's pipeline:
 *   1. manual individual-channel additions are prepended in display_order
 *      (the desktop sets orderingIsFixed and skips the sortOrder sort);
 *   2. otherwise channels with a manual display_order sort first, with the
 *      remaining channels falling back to the user's sortOrder;
 *   3. otherwise the plain sortOrder sort.
 * Filter words are applied to names before any sort, exactly like the desktop.
 */
async function buildOrderedCategoryChannels(
  channels: StoredChannel[],
  manualMappings: PlaylistIndividualChannel[],
  sortOrder: 'alphabetical' | 'number' | 'provider',
  filterWords: string[]
): Promise<StoredChannel[]> {
  let base: StoredChannel[];
  if (manualMappings.length > 0) {
    const streamIds = manualMappings.map(m => m.stream_id);
    const manualChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
    const manualMap = new Map(manualChannels.map(ch => [ch.stream_id, ch]));
    const orderedManual = manualMappings
      .sort((a, b) => a.display_order - b.display_order)
      .map(m => manualMap.get(m.stream_id))
      .filter((ch): ch is StoredChannel => ch !== undefined);
    const manualStreamIds = new Set(streamIds);
    base = [...orderedManual, ...channels.filter(ch => !manualStreamIds.has(ch.stream_id))];
  } else {
    base = channels;
  }

  // The desktop applies the enabled filter, then filter words, before ordering.
  base = base.filter(ch => ch.enabled !== false);
  if (filterWords.length > 0) {
    base = base.map(ch => applyFilterWordsToChannel(ch, filterWords));
  }

  if (manualMappings.length > 0) {
    return base; // orderingIsFixed on the desktop — no sortOrder sort
  }
  const hasAnyManualOrder = base.some(ch => ch.display_order != null);
  if (hasAnyManualOrder) {
    const cmp = guideSortComparator(sortOrder);
    return base.sort((a, b) => {
      const aHas = a.display_order != null;
      const bHas = b.display_order != null;
      if (aHas && bHas) return a.display_order! - b.display_order!;
      if (aHas) return -1;
      if (bHas) return 1;
      return cmp(a, b);
    });
  }
  return applyGuideSortOrder(base, sortOrder);
}

export interface UsePhoneRemoteCompanionOptions {
  currentChannel: StoredChannel | null;
  /** Channel the phone guide should highlight as "now viewing" (keep-view
   *  anchor when failover redirects tuning to a group primary). */
  viewChannel?: StoredChannel | null;
  currentProgram: StoredProgram | null;
  categories: StoredCategory[];
  activeView: string;
  /** Current app-wide search query (titlebar / controller modal / phone remote). */
  searchQuery: string;
  multiviewLayout: LayoutMode;
  multiviewSlots: ViewerSlot[];
  /** Current multiview engine ('hls' | 'mpv_canvas'); synced to the phone so
   *  its Multiview tab can show/pick the engine the desktop is using. */
  multiviewEngineMode?: string;
  volume?: number;
  isMuted?: boolean;
  onPlayChannel: (channel: StoredChannel, sourceCategoryId?: string) => void;
  onSendToSlot?: (slotIndex: number, channel: StoredChannel) => void;
  onSwitchLayout?: (layout: string) => void;
  onSetEngineMode?: (mode: string) => void;
  onSetAudioSlot?: (slotIndex: number) => void;
  onSetVolume?: (vol: number) => void;
  /** Trigger a one-shot sports scores refresh; called only when the cached data is stale. */
  onRequestSportsRefresh?: () => Promise<void>;
}

export interface CategoryTreeItem {
  id: string;
  name: string;
  count: number;
}

export interface CategoryFolderItem {
  folder_id: string;
  name: string;
  count: number;
  categories: CategoryTreeItem[];
}

export interface SourceGroupItem {
  source_id: string;
  source_name: string;
  type: 'real' | 'playlist';
  count: number;
  folders: CategoryFolderItem[];
  categories: CategoryTreeItem[];
}

export interface CategoryTree {
  virtuals: Array<{ id: string; name: string; count?: number; icon?: string }>;
  custom_groups: Array<{ id: string; name: string; count?: number }>;
  source_groups: SourceGroupItem[];
}

function broadcastToRemote(data: Record<string, any>) {
  invoke('remote_ws_broadcast', { payload: JSON.stringify(data) }).catch(() => {});
}

export interface CategoryTreeBuildInput {
  sourceList: Array<{ id: string; name: string; display_order?: number }>;
  categories: StoredCategory[];
  foldersList: CategoryFolder[];
  customGroupsList: CustomGroup[];
  customPlaylistsList: CustomPlaylist[];
  playlistLinksList: PlaylistCategoryLink[];
  sidebarOrder: string[] | null;
  categorySortOrder: string;
  pinnedCategories: string[];
  pinnedFolders: string[];
  customizedSourceIds: string[];
}

/**
 * Pure, environment-free tree builder used by the phone-remote companion.
 * No window/localStorage/store/db access — fixtures can drive it in tests and
 * diff it against the app's CategoryStrip ordering.
 */
export async function buildCategoryTreeFromData(input: CategoryTreeBuildInput): Promise<CategoryTree> {
  const {
    sourceList,
    categories,
    foldersList,
    customGroupsList,
    customPlaylistsList,
    playlistLinksList,
    sidebarOrder,
    categorySortOrder,
    pinnedCategories,
    pinnedFolders,
    customizedSourceIds,
  } = input;

  const pinnedSet = new Set(pinnedCategories);
  const pinnedFoldersSet = new Set(pinnedFolders);
  const customizedSet = new Set(customizedSourceIds);
  const sortCtx = {
    categorySortOrder,
    pinnedCategories: pinnedSet,
    pinnedFolders: pinnedFoldersSet,
    customizedSourceIds: customizedSet,
  };

  const sortCategoriesWithSidebarRule = (
    items: Array<CategoryTreeItem & { _pinKey?: string; _displayOrder?: number }>,
    ownerId: string
  ) => {
    items.sort((a, b) =>
      compareSidebarCategory(
        { id: a.id, name: a.name, displayOrder: a._displayOrder, pinnedKey: a._pinKey },
        { id: b.id, name: b.name, displayOrder: b._displayOrder, pinnedKey: b._pinKey },
        sortCtx,
        ownerId
      )
    );
    // Strip the transient sort metadata before the tree is serialized to the phone.
    for (const it of items) {
      delete (it as any)._pinKey;
      delete (it as any)._displayOrder;
    }
  };

  // Playlists sort differently in the app: pure alphabetical (no pins) when
  // the user set alphabetical order, otherwise pure display_order. The
  // customized check uses the RAW playlist id, like CategoryStrip.
  const sortPlaylistCategoriesWithSidebarRule = (
    items: Array<CategoryTreeItem & { _pinKey?: string; _displayOrder?: number }>,
    playlistId: string
  ) => {
    items.sort((a, b) =>
      comparePlaylistCategory(
        { id: a.id, name: a.name, displayOrder: a._displayOrder },
        { id: b.id, name: b.name, displayOrder: b._displayOrder },
        sortCtx,
        playlistId
      )
    );
    for (const it of items) {
      delete (it as any)._pinKey;
      delete (it as any)._displayOrder;
  }
};

const sourceNameMap = new Map<string, string>();
sourceList.forEach((s) => sourceNameMap.set(s.id, s.name));

  // Map folders by playlist_id (which is source_id or custom playlist_id)
  const foldersBySource = new Map<string, typeof foldersList>();
  foldersList.forEach((f) => {
    const arr = foldersBySource.get(f.playlist_id) || [];
    arr.push(f);
    foldersBySource.set(f.playlist_id, arr);
  });

  // Sort each owner's folders the way CategoryStrip does: pinned folders
  // first, then display_order.
  for (const [ownerId, arr] of foldersBySource) {
    arr.sort((a, b) => compareSidebarFolder(a, b, sortCtx, ownerId));
  }

  const sourceGroupsMap = new Map<string, SourceGroupItem>();

  // 1. Build real sources
  for (const source of sourceList) {
    const sId = source.id;
    const sName = source.name;
    const sFolders: CategoryFolderItem[] = (foldersBySource.get(sId) || []).map((f) => ({
      folder_id: f.folder_id,
      name: f.name,
      count: 0,
      categories: [],
    }));

    sourceGroupsMap.set(sId, {
      source_id: sId,
      source_name: sName,
      type: 'real',
      count: 0,
      folders: sFolders,
      categories: [],
    });
  }

  // Populate categories into real sources
  for (const cat of categories) {
    if (cat.category_id.startsWith('__') || cat.enabled === false) continue;
    const sId = cat.source_id || 'default';
    let sGroup = sourceGroupsMap.get(sId);
    if (!sGroup) {
      const sFolders: CategoryFolderItem[] = (foldersBySource.get(sId) || []).map((f) => ({
        folder_id: f.folder_id,
        name: f.name,
        count: 0,
        categories: [],
      }));
      sGroup = {
        source_id: sId,
        source_name: sourceNameMap.get(sId) || sId,
        type: 'real',
        count: 0,
        folders: sFolders,
        categories: [],
      };
      sourceGroupsMap.set(sId, sGroup);
    }

    const item: CategoryTreeItem & { _pinKey?: string; _displayOrder?: number } = {
      id: cat.category_id,
      name: cat.alias || cat.category_name,
      count: cat.channel_count ?? 0,
    };
    item._pinKey = `${sId}:${cat.category_id}`;
    item._displayOrder = cat.display_order ?? 0;
    sGroup.count += item.count;

    if (cat.folder_id) {
      const folder = sGroup.folders.find((f) => f.folder_id === cat.folder_id);
      if (folder) {
        folder.categories.push(item);
        folder.count += item.count;
      } else {
        sGroup.categories.push(item);
      }
    } else {
      sGroup.categories.push(item);
    }
  }

  // Add each real source's custom playlist category links (categories added
  // to a source via the playlist editor) into the source group, matching the
  // app's sidebar which mixes them with native categories before sorting.
  for (const [sId, sGroup] of sourceGroupsMap) {
    if (sGroup.type !== 'real') continue;
    const sLinks = playlistLinksList.filter((l) => l.playlist_id === sId);
    for (const link of sLinks) {
      const origCat = categories.find((c) => c.category_id === link.category_id);
      const item: CategoryTreeItem & { _pinKey?: string; _displayOrder?: number } = {
        id: `__plcat_${link.id}`,
        name: link.custom_name || origCat?.alias || origCat?.category_name || link.category_id,
        count: origCat?.channel_count ?? 0,
      };
      item._pinKey = `${sId}:link:${link.id}`;
      item._displayOrder = link.display_order ?? 0;
      sGroup.count += item.count;
      if (link.folder_id) {
        const folder = sGroup.folders.find((f) => f.folder_id === link.folder_id);
        if (folder) {
          folder.categories.push(item);
          folder.count += item.count;
        } else {
          sGroup.categories.push(item);
        }
      } else {
        sGroup.categories.push(item);
      }
    }
  }

  // 2. Build custom playlists
  for (const pl of customPlaylistsList) {
    const plId = `playlist:${pl.playlist_id}`;
    const plFolders: CategoryFolderItem[] = (foldersBySource.get(pl.playlist_id) || []).map((f) => ({
      folder_id: f.folder_id,
      name: f.name,
      count: 0,
      categories: [],
    }));

    const plLinks = playlistLinksList.filter((l) => l.playlist_id === pl.playlist_id);
    const plCategories: CategoryTreeItem[] = [];
    let totalPlCount = 0;

    for (const link of plLinks) {
      const origCat = categories.find((c) => c.category_id === link.category_id);
      const item: CategoryTreeItem & { _pinKey?: string; _displayOrder?: number } = {
        id: `__plcat_${link.id}`,
        name: link.custom_name || origCat?.alias || origCat?.category_name || link.category_id,
        count: origCat?.channel_count ?? 0,
      };
      item._pinKey = `${pl.playlist_id}:link:${link.id}`;
      item._displayOrder = link.display_order ?? 0;
      totalPlCount += item.count;
      if (link.folder_id) {
        const folder = plFolders.find((f) => f.folder_id === link.folder_id);
        if (folder) {
          folder.categories.push(item);
          folder.count += item.count;
        } else {
          plCategories.push(item);
        }
      } else {
        plCategories.push(item);
      }
    }

    // Sort playlist categories with the app's playlist rule (pure
    // alphabetical or pure display_order — no pins, like CategoryStrip).
    sortPlaylistCategoriesWithSidebarRule(plCategories, pl.playlist_id);
    for (const plFolder of plFolders) {
      sortPlaylistCategoriesWithSidebarRule(plFolder.categories, pl.playlist_id);
    }

    sourceGroupsMap.set(plId, {
      source_id: plId,
      source_name: `📋 ${pl.name}`,
      type: 'playlist',
      count: totalPlCount,
      folders: plFolders.filter((f) => f.categories.length > 0),
      categories: plCategories,
    });
  }    // Sort real-source categories with the same sidebar rule the app uses.
    // Playlist groups were already sorted by the pure playlist rule (and their
    // sort metadata stripped), so skip them here — re-sorting would apply a
    // name tiebreak that overrides the display_order order.
    for (const sg of sourceGroupsMap.values()) {
      if (sg.type !== 'real') continue;
      sortCategoriesWithSidebarRule(sg.categories, sg.source_id);
      for (const f of sg.folders) {
        sortCategoriesWithSidebarRule(f.categories, sg.source_id);
      }
      sg.folders = sg.folders.filter((f) => f.categories.length > 0);
    }


  let sourceGroups = Array.from(sourceGroupsMap.values()).filter(
    (sg) => sg.count > 0 || sg.categories.length > 0 || sg.folders.length > 0
  );

  // Apply LiveTV sidebar source order
  if (sidebarOrder && sidebarOrder.length > 0) {
    const orderMap = new Map(sidebarOrder.map((id, index) => [id, index]));
    sourceGroups.sort((a, b) => {
      const orderA = orderMap.has(a.source_id) ? orderMap.get(a.source_id)! : Number.MAX_SAFE_INTEGER;
      const orderB = orderMap.has(b.source_id) ? orderMap.get(b.source_id)! : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.source_name.localeCompare(b.source_name);
    });
  }

  return {
    virtuals: [
      { id: '__favorites__', name: 'Favorites', icon: '⭐' },
      { id: '__recent__', name: 'Recently Viewed', icon: '🕐' },
    ],
    custom_groups: customGroupsList.map((g) => ({
      id: g.group_id,
      name: g.name,
    })),
    source_groups: sourceGroups,
  };
}

async function buildCategoryTree(categories: StoredCategory[]): Promise<CategoryTree> {
  try {
    let sourceList: Array<{ id: string; name: string; display_order?: number }> = [];
    if ((window as any).storage?.getSources) {
      const res = await (window as any).storage.getSources();
      if (res?.data) {
        sourceList = res.data.map((s: any) => ({
          id: s.id,
          name: s.name,
          display_order: s.display_order ?? Number.MAX_SAFE_INTEGER,
        }));
      }
    }

    const [foldersList, customGroupsList, customPlaylistsList, playlistLinksList, sidebarOrderPref] = await Promise.all([
      db.categoryFolders.orderBy('display_order').toArray().catch(() => []),
      db.customGroups.orderBy('display_order').toArray().catch(() => []),
      db.customPlaylists.orderBy('display_order').toArray().catch(() => []),
      db.playlistCategoryLinks.toArray().catch(() => []),
      db.prefs.get('sidebar_sources_order').catch(() => null),
    ]);

    let sidebarOrder: string[] | null = null;
    if (sidebarOrderPref?.value) {
      try {
        sidebarOrder = JSON.parse(sidebarOrderPref.value);
      } catch (e) {}
    }

    return await buildCategoryTreeFromData({
      sourceList,
      categories,
      foldersList,
      customGroupsList,
      customPlaylistsList,
      playlistLinksList,
      sidebarOrder,
      categorySortOrder: useSettingsStore.getState().categorySortOrder || 'default',
      pinnedCategories: readStoredKeys('ynotv:pinnedCategories'),
      pinnedFolders: readStoredKeys('ynotv:pinnedFolders'),
      customizedSourceIds: getCustomizedCategorySortOrders(),
    });
  } catch (err) {
    console.error('[usePhoneRemoteCompanion] buildCategoryTree error:', err);
    return {
      virtuals: [
        { id: '__favorites__', name: 'Favorites', icon: '⭐' },
        { id: '__recent__', name: 'Recently Viewed', icon: '🕐' },
      ],
      custom_groups: [],
      source_groups: [],
    };
  }
}

export function usePhoneRemoteCompanion({
  currentChannel,
  viewChannel,
  currentProgram,
  categories,
  activeView,
  searchQuery,
  multiviewLayout,
  multiviewSlots,
  multiviewEngineMode,
  volume,
  isMuted,
  onPlayChannel,
  onSendToSlot,
  onSwitchLayout,
  onSetEngineMode,
  onSetAudioSlot,
  onSetVolume,
  onRequestSportsRefresh,
}: UsePhoneRemoteCompanionOptions) {
  const latestRefs = useRef({
    currentChannel,
    currentProgram,
    categories,
    activeView,
    searchQuery,
    multiviewLayout,
    multiviewSlots,
    multiviewEngineMode,
    volume,
    isMuted,
    onPlayChannel,
    onSendToSlot,
    onSwitchLayout,
    onSetEngineMode,
    onSetAudioSlot,
    onSetVolume,
    onRequestSportsRefresh,
  });

  latestRefs.current = {
    currentChannel,
    currentProgram,
    categories,
    activeView,
    searchQuery,
    multiviewLayout,
    multiviewSlots,
    multiviewEngineMode,
    volume,
    isMuted,
    onPlayChannel,
    onSendToSlot,
    onSwitchLayout,
    onSetEngineMode,
    onSetAudioSlot,
    onSetVolume,
    onRequestSportsRefresh,
  };

  // Push volume / mute state when volume or mute state changes
  useEffect(() => {
    broadcastToRemote({
      type: 'volume',
      volume: volume ?? 100,
      muted: !!isMuted,
    });
  }, [volume, isMuted]);

  // Push Now Playing state when current channel or program changes
  useEffect(() => {
    if (!currentChannel) {
      broadcastToRemote({
        type: 'nowPlaying',
        nowPlaying: null,
      });
      return;
    }

    const now = Date.now();
    let progressPercent = 0;
    let timeRemaining = '';

    if (currentProgram?.start && currentProgram?.end) {
      const startMs = new Date(currentProgram.start).getTime();
      const endMs = new Date(currentProgram.end).getTime();
      const total = endMs - startMs;
      if (total > 0) {
        const elapsed = now - startMs;
        progressPercent = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        const remMinutes = Math.max(0, Math.round((endMs - now) / 60000));
        timeRemaining = remMinutes > 60 ? `${Math.floor(remMinutes / 60)}h ${remMinutes % 60}m remaining` : `${remMinutes}m remaining`;
      }
    }

    broadcastToRemote({
      type: 'nowPlaying',
      nowPlaying: {
        stream_id: currentChannel.stream_id,
        name: currentChannel.alias || currentChannel.name,
        logo: currentChannel.stream_icon || '',
        channel_num: currentChannel.channel_num,
        current_program: currentProgram ? {
          title: currentProgram.title,
          description: currentProgram.description,
          start: currentProgram.start,
          end: currentProgram.end,
          progress_percent: progressPercent,
          time_remaining: timeRemaining,
        } : null,
      },
    });
  }, [currentChannel, currentProgram]);

  // Push category tree when categories update
  useEffect(() => {
    if (categories.length > 0) {
      buildCategoryTree(categories).then((tree) => {
        broadcastToRemote({
          type: 'categoryTree',
          categoryTree: tree,
        });
      });
    }
  }, [categories]);

  // Push the app's active view so the phone can highlight the matching section.
  // Debounced so rapid view toggling (e.g. tapping G to flip the guide) sends
  // only the settled state, not every intermediate value.
  useEffect(() => {
    const timer = setTimeout(() => {
      broadcastToRemote({ type: 'view', view: activeView });
    }, 200);
    return () => clearTimeout(timer);
  }, [activeView]);

  // Push the app's search query so the phone remote's search box stays in sync
  // (including when it's cleared or changed from the titlebar / controller
  // modal). The remote only sets the input value on receipt — it never echoes
  // the update back, so there is no feedback loop.
  useEffect(() => {
    broadcastToRemote({ type: 'searchQuery', query: searchQuery || '' });
  }, [searchQuery]);

  // Push multiview slots when layout or slots change
  useEffect(() => {
    broadcastToRemote({
      type: 'multiview',
      multiview: {
        layout: multiviewLayout,
        engine: multiviewEngineMode,
        slots: multiviewSlots.map((s, idx) => ({
          index: idx,
          slot_id: s.id,
          channel_name: s.channelName || null,
          channel_url: s.channelUrl || null,
          is_active: s.active,
        })),
      },
    });
  }, [multiviewLayout, multiviewSlots, multiviewEngineMode]);

  // Track whether at least one phone is currently paired/connected, so the app
  // can scope background work (e.g. sports polling) to active remote sessions.
  const clientCountRef = useRef(0);
  const [isRemoteClientConnected, setIsRemoteClientConnected] = useState(false);

  // Sync Phone Remote custom configuration in real-time
  const phoneRemoteConfig = useSettingsStore((s) => s.phoneRemoteConfig);
  useEffect(() => {
    if (phoneRemoteConfig) {
      broadcastToRemote({
        type: 'remoteConfig',
        config: phoneRemoteConfig,
      });
    }
  }, [phoneRemoteConfig]);

  // Sync failover playback settings to the phone in real-time (the phone guide
  // shows the Always Play Primary toggle and tunes through the same wrapper, so
  // it must know the current values). The view channel is the channel the phone
  // guide should highlight as now-viewing (the keep-view anchor when active).
  const failoverAlwaysPlayPrimary = useSettingsStore((s) => s.failoverAlwaysPlayPrimary);
  const failoverKeepView = useSettingsStore((s) => s.failoverKeepView);
  const viewChannelStreamId = viewChannel?.stream_id ?? null;
  useEffect(() => {
    broadcastToRemote({
      type: 'failoverSettings',
      failoverAlwaysPlayPrimary,
      failoverKeepView,
      viewChannel: viewChannel
        ? { stream_id: viewChannel.stream_id, name: viewChannel.name }
        : null,
    });
  }, [failoverAlwaysPlayPrimary, failoverKeepView, viewChannelStreamId]);

  // Handle incoming commands and queries from the phone remote
  useEffect(() => {
    let unlistenCmd: (() => void) | null = null;
    let unlistenClient: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        unlistenClient = await listen<any>('remote://client', (event) => {
          if (event.payload?.event === 'connected') {
            clientCountRef.current += 1;
            setIsRemoteClientConnected(true);
            sendInitialStateSnapshot();
          } else if (event.payload?.event === 'disconnected') {
            clientCountRef.current = Math.max(0, clientCountRef.current - 1);
            setIsRemoteClientConnected(clientCountRef.current > 0);
          }
        });

        unlistenCmd = await listen<any>('remote://cmd', async (event) => {
          const payload = event.payload;
          if (!payload) return;

          switch (payload.action) {
            case 'getInitialState':
              await sendInitialStateSnapshot();
              break;

            case 'getGuide':
              await handleGetGuide(payload.categoryId, payload.search);
              break;

            case 'getSports':
              await handleGetSports();
              break;

            case 'playChannel':
              if (payload.channelId) {
                const chan = await db.channels.get(payload.channelId);
                if (chan) {
                  latestRefs.current.onPlayChannel(chan, payload.categoryId);
                }
              }
              break;

            case 'setVolume':
              if (typeof payload.volume === 'number' && latestRefs.current.onSetVolume) {
                latestRefs.current.onSetVolume(payload.volume);
              }
              break;

            case 'volumeStep':
              if (typeof payload.delta === 'number' && latestRefs.current.onSetVolume) {
                const cur = latestRefs.current.volume ?? 100;
                const target = Math.max(0, Math.min(200, cur + payload.delta));
                latestRefs.current.onSetVolume(target);
              }
              break;

            case 'assignMultiview':
              if (payload.channelId && typeof payload.slotIndex === 'number') {
                const chan = await db.channels.get(payload.channelId);
                if (chan && latestRefs.current.onSendToSlot) {
                  latestRefs.current.onSendToSlot(payload.slotIndex, chan);
                }
              }
              break;

            case 'switchMultiviewLayout':
              if (payload.layout && latestRefs.current.onSwitchLayout) {
                latestRefs.current.onSwitchLayout(payload.layout);
              }
              break;

            case 'setMultiviewEngine':
              if (payload.mode && latestRefs.current.onSetEngineMode) {
                latestRefs.current.onSetEngineMode(payload.mode);
              }
              break;

            case 'setAudioSlot':
              if (typeof payload.slotIndex === 'number' && latestRefs.current.onSetAudioSlot) {
                latestRefs.current.onSetAudioSlot(payload.slotIndex);
              }
              break;

            case 'setRemoteConfig':
              if (payload.config && typeof payload.config === 'object') {
                useSettingsStore.getState().setPhoneRemoteConfig(payload.config);
              }
              break;

            case 'setFailoverAlwaysPlayPrimary':
              if (typeof payload.enabled === 'boolean') {
                useSettingsStore.getState().setFailoverAlwaysPlayPrimary(payload.enabled);
              }
              break;

            case 'setFailoverKeepView':
              if (typeof payload.enabled === 'boolean') {
                useSettingsStore.getState().setFailoverKeepView(payload.enabled);
              }
              break;

            case 'tuneChannelNumber':
              if (typeof payload.channelNum === 'number') {
                const num = payload.channelNum;
                db.channels
                  .where('channel_num')
                  .equals(num)
                  .first()
                  .then((ch) => {
                    if (ch) {
                      latestRefs.current.onPlayChannel(ch);
                    }
                  })
                  .catch(() => {});
              }
              break;
          }
        });
      } catch (err) {
        console.warn('[usePhoneRemoteCompanion] Listeners setup error:', err);
      }
    };

    setupListeners();

    return () => {
      unlistenCmd?.();
      unlistenClient?.();
    };
  }, []);

  const sendInitialStateSnapshot = useCallback(async () => {
    const curChan = latestRefs.current.currentChannel;
    const curProg = latestRefs.current.currentProgram;
    const cats = latestRefs.current.categories;
    const mvLayout = latestRefs.current.multiviewLayout;
    const mvSlots = latestRefs.current.multiviewSlots;
    const mvEngine = latestRefs.current.multiviewEngineMode;

    const now = Date.now();
    let progressPercent = 0;
    let timeRemaining = '';

    if (curProg?.start && curProg?.end) {
      const startMs = new Date(curProg.start).getTime();
      const endMs = new Date(curProg.end).getTime();
      const total = endMs - startMs;
      if (total > 0) {
        const elapsed = now - startMs;
        progressPercent = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        const remMinutes = Math.max(0, Math.round((endMs - now) / 60000));
        timeRemaining = remMinutes > 60 ? `${Math.floor(remMinutes / 60)}h ${remMinutes % 60}m remaining` : `${remMinutes}m remaining`;
      }
    }

    const tree = await buildCategoryTree(cats);

    broadcastToRemote({
      type: 'initialState',
      activeView: latestRefs.current.activeView,
      searchQuery: latestRefs.current.searchQuery || '',
      volume: latestRefs.current.volume ?? 100,
      muted: !!latestRefs.current.isMuted,
      nowPlaying: curChan ? {
        stream_id: curChan.stream_id,
        name: curChan.alias || curChan.name,
        logo: curChan.stream_icon || '',
        channel_num: curChan.channel_num,
        current_program: curProg ? {
          title: curProg.title,
          description: curProg.description,
          start: curProg.start,
          end: curProg.end,
          progress_percent: progressPercent,
          time_remaining: timeRemaining,
        } : null,
      } : null,
      categoryTree: tree,
      phoneRemoteConfig: useSettingsStore.getState().phoneRemoteConfig,
      failoverSettings: {
        failoverAlwaysPlayPrimary: useSettingsStore.getState().failoverAlwaysPlayPrimary,
        failoverKeepView: useSettingsStore.getState().failoverKeepView,
        viewChannel: viewChannel
          ? { stream_id: viewChannel.stream_id, name: viewChannel.name }
          : null,
      },
      multiview: {
        layout: mvLayout,
        engine: mvEngine,
        slots: mvSlots.map((s, idx) => ({
          index: idx,
          slot_id: s.id,
          channel_name: s.channelName || null,
          channel_url: s.channelUrl || null,
          is_active: s.active,
        })),
      },
    });

    handleGetGuide('__favorites__');
    handleGetSports();
  }, []);

  const handleGetGuide = async (categoryId?: string, search?: string) => {
    try {
      const targetCatId = categoryId || '__favorites__';
      // Live sortOrder preference from the app's UI store (default 'provider'),
      // so standard categories and playlist links match the desktop guide.
      const sortOrder = useUIStore.getState().channelSortOrder;

      // 1. Fast Indexed Search
      if (search && search.trim().length > 0) {
        const term = search.trim();
        const results = await db.channels.whereRaw(
          `(name LIKE ? OR alias LIKE ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false')) LIMIT 80`,
          [`%${term}%`, `%${term}%`]
        ).toArray();
        await sendGuideChannels(results, targetCatId, search);
        return;
      }

      // 2. Favorites
      if (targetCatId === '__favorites__') {
        const favs = await db.channels.whereRaw(
          `(is_favorite = 1 OR is_favorite = true) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`
        ).toArray();
        // Apply home-category filter words before sorting (the desktop does the
        // same) so names and order match the app.
        const cleaned = await applyHomeCategoryFilterWords(favs);
        cleaned.sort((a, b) => {
          if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
          if (a.fav_order != null) return -1;
          if (b.fav_order != null) return 1;
          return (a.alias || a.name).localeCompare(b.alias || b.name);
        });
        await sendGuideChannels(cleaned, targetCatId);
        return;
      }

      // 3. Recently Viewed
      if (targetCatId === '__recent__') {
        const recentEntries = getRecentChannels();
        const recentIds = recentEntries.map((e) => e.streamId);
        if (recentIds.length > 0) {
          const channels = await db.channels.where('stream_id').anyOf(recentIds).toArray();
          const channelMap = new Map(channels.map((ch) => [ch.stream_id, ch]));
          const ordered = recentEntries
            .map((entry) => channelMap.get(entry.streamId))
            .filter((ch): ch is StoredChannel => ch !== undefined);
          // Apply home-category filter words so names match the app's view.
          const cleaned = await applyHomeCategoryFilterWords(ordered);
          await sendGuideChannels(cleaned, targetCatId);
          return;
        }
        await sendGuideChannels([], targetCatId);
        return;
      }

      // 4. Custom Playlist Category Link (__plcat_123)
      if (targetCatId.startsWith('__plcat_')) {
        const linkId = parseInt(targetCatId.replace('__plcat_', ''), 10);
        if (!isNaN(linkId)) {
          const link = await db.playlistCategoryLinks.get(linkId);
          if (link) {
            const channels = await db.channels.whereRaw(
              `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
              [link.source_id, link.category_id]
            ).toArray();
            // Manual additions to this playlist link (desktop uses the link's
            // own id first, then falls back to the linked source category).
            let manualMappings = await db.playlistIndividualChannels
              .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.playlist_id, `link:${link.id}`])
              .toArray();
            if (manualMappings.length === 0) {
              manualMappings = await db.playlistIndividualChannels
                .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.source_id, link.category_id])
                .toArray();
            }
            const ordered = await buildOrderedCategoryChannels(channels, manualMappings, sortOrder, []);
            await sendGuideChannels(ordered, targetCatId);
            return;
          }
        }
        await sendGuideChannels([], targetCatId);
        return;
      }

      // 5. Custom Group
      const customGroup = await db.customGroups.get(targetCatId).catch(() => null);
      if (customGroup) {
        const groupChannels = await db.customGroupChannels
          .where('group_id')
          .equals(targetCatId)
          .sortBy('display_order');
        if (groupChannels.length > 0) {
          const streamIds = groupChannels.map((gc) => gc.stream_id);
          const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
          const channelMap = new Map(channels.map((ch) => [ch.stream_id, ch]));
          const ordered = groupChannels
            .map((gc) => channelMap.get(gc.stream_id))
            .filter((ch): ch is StoredChannel => ch !== undefined);
          await sendGuideChannels(ordered, targetCatId);
          return;
        }
        await sendGuideChannels([], targetCatId);
        return;
      }

      // 6. Standard Category via indexed SQL query (same shape as the LiveTV
      // guide: idx_channels_source + json_each match + enabled filter, ordered
      // by rowid to preserve table/insertion order). Sends the full channel
      // list so the remote shows every channel in the category.
      const category = await db.categories.get(targetCatId);
      if (category) {
        const channels = await db.channels.whereRaw(
          `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false')) ORDER BY rowid`,
          [category.source_id, category.category_id]
        ).toArray();
        // Manual additions: channels individually added to this category
        // (the desktop prepends them in display_order and skips the sortOrder
        // sort). Apply the category's filter words so names match the app.
        const manualMappings = await db.playlistIndividualChannels
          .whereRaw('playlist_id = ? AND parent_category_id = ?', [category.source_id, targetCatId])
          .toArray();
        const ordered = await buildOrderedCategoryChannels(channels, manualMappings, sortOrder, category.filter_words || []);
        await sendGuideChannels(ordered, targetCatId);
        return;
      }

      // Fallback: category row missing (stale reference) — match by id alone
      const sqlChannels = await db.channels.whereRaw(
        `EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
        [targetCatId]
      ).toArray();

      await sendGuideChannels(sqlChannels, targetCatId);
    } catch (err) {
      console.error('[usePhoneRemoteCompanion] Guide fetch error:', err);
    }
  };

  const sendGuideChannels = async (channels: StoredChannel[], categoryId?: string, search?: string) => {
    if (!channels.length) {
      broadcastToRemote({
        type: 'guideData',
        categoryId: categoryId || '__favorites__',
        search: search || '',
        channels: [],
      });
      return;
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const streamIds = channels.map((c) => c.stream_id);

    // Fast Batch query currently airing programs for ONLY the target channels
    const programMap = new Map<string, StoredProgram>();
    const nextProgramMap = new Map<string, StoredProgram>();

    try {
      const dbInstance = await (db as any).dbPromise;
      // Chunk the IN query: with full-size categories the stream-id list can
      // exceed SQLite's variable limit, which would silently drop program info.
      const PROGRAM_CHUNK = 500;
      const rows: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += PROGRAM_CHUNK) {
        const chunkIds = streamIds.slice(i, i + PROGRAM_CHUNK);
        const placeholders = chunkIds.map(() => '?').join(',');
        const chunkRows = (await dbInstance.select(
          `SELECT stream_id, title, start, end, description FROM programs_effective
           WHERE stream_id IN (${placeholders}) AND end > ?
           ORDER BY start ASC`,
          [...chunkIds, nowIso]
        )) as StoredProgram[];
        rows.push(...chunkRows);
      }

      for (const row of rows) {
        const startMs = new Date(row.start).getTime();
        const endMs = new Date(row.end).getTime();

        if (startMs <= now && endMs >= now) {
          if (!programMap.has(row.stream_id)) {
            programMap.set(row.stream_id, row);
          }
        } else if (startMs > now) {
          if (!nextProgramMap.has(row.stream_id)) {
            nextProgramMap.set(row.stream_id, row);
          }
        }
      }
    } catch (e) {}

    const formatted = channels.map((c) => {
      const prog = programMap.get(c.stream_id);
      const nextProg = nextProgramMap.get(c.stream_id);

      let progPercent = 0;
      let timeRem = '';

      if (prog) {
        const sMs = new Date(prog.start).getTime();
        const eMs = new Date(prog.end).getTime();
        const dur = eMs - sMs;
        if (dur > 0) {
          progPercent = Math.max(0, Math.min(100, Math.round(((now - sMs) / dur) * 100)));
          const remMin = Math.max(0, Math.round((eMs - now) / 60000));
          timeRem = remMin > 60 ? `${Math.floor(remMin / 60)}h ${remMin % 60}m left` : `${remMin}m left`;
        }
      }

      return {
        stream_id: c.stream_id,
        name: c.alias || c.name,
        logo: c.stream_icon || '',
        channel_num: c.channel_num,
        current_program: prog ? {
          title: prog.title,
          start: prog.start,
          end: prog.end,
          progress_percent: progPercent,
          time_remaining: timeRem,
        } : null,
        next_program: nextProg ? {
          title: nextProg.title,
          start: nextProg.start,
        } : null,
      };
    });

    broadcastToRemote({
      type: 'guideData',
      categoryId: categoryId || '__favorites__',
      search: search || '',
      channels: formatted,
    });
  };

  const handleGetSports = async () => {
    try {
      // Serve from the shared sports cache — the data the app already fetches when
      // the Sports view/overlay is used — instead of running a dedicated poll.
      const events = getSportsCacheEvents();
      const links = useTeamChannelLinksStore.getState().links;

      const liveList = events.filter((e) => isEventLiveOrPastStart(e));
      const targetEvents = liveList.length > 0 ? liveList : events.slice(0, 15);

      const enriched = await Promise.all(
        targetEvents.slice(0, 20).map(async (event) => {
          const awayLinks = getTeamLinks(links, event.league.id, event.awayTeam.id);
          const homeLinks = getTeamLinks(links, event.league.id, event.homeTeam.id);

          const statusText = getStatusDisplay(event) || (event.status === 'live' ? 'LIVE' : event.status);

          let availableStreams: Array<{ stream_id: string; channel_name: string; logo?: string }> = [];
          try {
            const queries = buildTeamSearchQueries(event.homeTeam.name, event.awayTeam.name, event.league?.id, event.title);
            // Route through the serialized prefetch queue (priority) so concurrent game
            // searches never flood the database; slices the shared 15-result cache to 8.
            const streams = await getGameStreamsForEvent(event.id, queries, event.league.id, {
              limit: 8,
              priority: true,
            });
            if (streams.length > 0) {
              availableStreams = streams.map((c) => ({
                stream_id: c.stream_id,
                channel_name: c.alias || c.name,
                logo: c.stream_icon,
              }));
            }
          } catch (e) {}

          return {
            id: event.id,
            league: {
              id: event.league.id,
              name: event.league.name,
            },
            status: event.status,
            status_text: statusText,
            period: event.period,
            time_elapsed: event.timeElapsed,
            away_team: {
              name: event.awayTeam.shortName || event.awayTeam.name,
              full_name: event.awayTeam.name,
              logo: event.awayTeam.logo,
              score: event.awayScore ?? 0,
              links: awayLinks.map((l) => ({
                stream_id: l.stream_id,
                channel_name: l.channel_name,
                priority: l.priority ?? 0,
              })),
            },
            home_team: {
              name: event.homeTeam.shortName || event.homeTeam.name,
              full_name: event.homeTeam.name,
              logo: event.homeTeam.logo,
              score: event.homeScore ?? 0,
              links: homeLinks.map((l) => ({
                stream_id: l.stream_id,
                channel_name: l.channel_name,
                priority: l.priority ?? 0,
              })),
            },
            available_streams: availableStreams,
          };
        })
      );

      broadcastToRemote({
        type: 'sportsData',
        events: enriched,
      });

      // If the shared cache is stale/empty, trigger a one-shot refresh. When it
      // completes, the cache subscription below re-broadcasts the fresh data.
      if (!isSportsCacheFresh()) {
        latestRefs.current.onRequestSportsRefresh?.().catch(() => {});
      }
    } catch (err) {
      console.error('[usePhoneRemoteCompanion] Sports fetch error:', err);
    }
  };

  // Push fresh sports data to connected phones whenever ANY app instance refreshes
  // the shared sports cache (Sports view, overlay widget, or a phone-triggered refresh).
  useEffect(() => {
    return subscribeSportsCache(() => {
      handleGetSports();
    });
  }, []);

  return { isRemoteClientConnected };
}
