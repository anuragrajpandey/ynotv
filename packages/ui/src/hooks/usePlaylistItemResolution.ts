import { useEffect } from 'react';
import { useLiveQuery } from './useSqliteLiveQuery';
import { resolvePlaylistItem, applyPlaylistResolutions } from '../utils/playlistPlayback';
import { useVodMetadataOverridesStore } from '../stores/vodMetadataOverridesStore';
import type { PlaylistItem } from '../stores/vodPlaylistStore';

/**
 * Resolve a set of playlist items against the CURRENT source rows (vodMovies /
 * vodEpisodes / vodSeries) and the local library, keyed by playlist item id.
 *
 * The DB subscription makes the map refresh automatically whenever those
 * tables change — i.e. after a source re-sync, credential change, or metadata
 * edit — so the Playlists view shows live titles/posters/stream URLs instead
 * of the snapshot taken when the item was added (same philosophy as Favorites,
 * which resolve by id at render time). Items that can't be found resolve to
 * their stored snapshot.
 *
 * User-corrected metadata (vodMetadataOverrides) is re-applied too: subscribing
 * to the overrides store puts it in the query deps, so editing a title/poster
 * refreshes the playlist rows without waiting for a DB event.
 */
export function usePlaylistItemResolutions(items: PlaylistItem[]): Map<string, PlaylistItem> {
  const overrides = useVodMetadataOverridesStore((s) => s.overrides);
  const resolved = useLiveQuery(
    async () => {
      if (items.length === 0) return new Map<string, PlaylistItem>();
      const entries = await Promise.all(items.map((i) => resolvePlaylistItem(i)));
      return new Map(entries.map((e) => [e.id, e]));
    },
    [items, overrides],
    new Map<string, PlaylistItem>(),
    0,
    ['vodMovies', 'vodSeries', 'vodEpisodes', 'localEntries', 'vodMetadataOverrides'],
  );
  const map = resolved ?? new Map();

  // Write the resolved fields back into the store so the persisted blob (and
  // thus exports/imports) carries fresh metadata, and prune items whose
  // source/file has been gone for the stale-removal window. Diffs converge to
  // no-ops, so this settles after one pass.
  useEffect(() => {
    applyPlaylistResolutions(Array.from(map.values()));
  }, [map]);

  return map;
}
