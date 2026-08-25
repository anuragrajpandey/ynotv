import { db, type StoredChannel } from '../../db';
import { buildSearchQueryClauses } from '../../utils/searchNormalization';
import { useLeagueSearchConfigStore } from '../../stores/leagueSearchConfigStore';
import { useUIStore } from '../../stores/uiStore';

interface CacheEntry {
  channels: StoredChannel[];
  timestamp: number;
}

// In-memory cache for game streams (persists throughout session until sources re-sync)
const streamSearchCache = new Map<string, CacheEntry>();

export function getCachedGameStreams(cacheKey: string): StoredChannel[] | null {
  const entry = streamSearchCache.get(cacheKey);
  if (!entry) return null;
  return entry.channels;
}

export function setCachedGameStreams(cacheKey: string, channels: StoredChannel[]): void {
  streamSearchCache.set(cacheKey, {
    channels,
    timestamp: Date.now(),
  });
}

export function clearCachedGameStreams(): void {
  streamSearchCache.clear();
}

// Invalidate stream search cache whenever a source sync completes so fresh channels/EPG are queried
if (typeof window !== 'undefined') {
  useUIStore.subscribe((state, prev) => {
    if (prev.channelSyncing && !state.channelSyncing) {
      clearCachedGameStreams();
    }
  });
}

// Background prefetch queue: runs 1 game search at a time with 60ms polite yielding.
// Priority items (e.g. phone-remote requests) are served ahead of background prefetches,
// and callers can await their item's completion instead of firing-and-forgetting.
interface PrefetchItem {
  eventId: string;
  query: string | string[];
  leagueId: string;
  limit: number;
  priority: boolean;
  resolve: (channels: StoredChannel[]) => void;
}

let isPrefetching = false;
const prefetchQueue: PrefetchItem[] = [];
const queuedSearches = new Map<string, Promise<StoredChannel[]>>();

const prefetchKey = (eventId: string, query: string | string[], leagueId: string) =>
  `${eventId}_${Array.isArray(query) ? query.join('||') : query}_${leagueId}`;

// Fire-and-forget background prefetch (desktop sports sidebar).
export function queuePrefetchGameStreams(
  eventId: string,
  query: string | string[],
  leagueId: string,
  limit = 15
): void {
  const key = prefetchKey(eventId, query, leagueId);
  if (getCachedGameStreams(key) || queuedSearches.has(key)) return;
  enqueueGameStreamSearch(eventId, query, leagueId, limit, false);
}

/**
 * Returns streams for a single game, running the search through the serialized prefetch
 * queue so concurrent callers (e.g. the phone remote's sports list) never flood the
 * database with parallel full-EPG scans. Searches always run at the shared limit (15)
 * so cache keys align across callers; the result is sliced to `limit` for this caller.
 */
export function getGameStreamsForEvent(
  eventId: string,
  query: string | string[],
  leagueId: string,
  opts?: { limit?: number; priority?: boolean }
): Promise<StoredChannel[]> {
  const limit = opts?.limit ?? 15;
  const priority = opts?.priority ?? false;
  const key = prefetchKey(eventId, query, leagueId);

  const cached = getCachedGameStreams(key);
  if (cached) return Promise.resolve(cached.slice(0, limit));

  const existing = queuedSearches.get(key);
  if (existing) return existing.then((channels) => channels.slice(0, limit));

  return enqueueGameStreamSearch(eventId, query, leagueId, 15, priority).then((channels) =>
    channels.slice(0, limit)
  );
}

function enqueueGameStreamSearch(
  eventId: string,
  query: string | string[],
  leagueId: string,
  limit: number,
  priority: boolean
): Promise<StoredChannel[]> {
  const key = prefetchKey(eventId, query, leagueId);
  const promise = new Promise<StoredChannel[]>((resolve) => {
    prefetchQueue.push({ eventId, query, leagueId, limit, priority, resolve });
  });
  queuedSearches.set(key, promise);
  processPrefetchQueue();
  return promise;
}

async function processPrefetchQueue(): Promise<void> {
  if (isPrefetching) return;
  isPrefetching = true;

  while (prefetchQueue.length > 0) {
    // If a channel sync is currently running, pause and wait for it to complete
    if (useUIStore.getState().channelSyncing) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    // Serve priority (e.g. phone-remote) requests before background prefetches
    const priorityIndex = prefetchQueue.findIndex((item) => item.priority);
    const item = prefetchQueue.splice(priorityIndex === -1 ? 0 : priorityIndex, 1)[0];
    if (!item) break;

    const cacheKey = prefetchKey(item.eventId, item.query, item.leagueId);
    let results = getCachedGameStreams(cacheKey);
    if (!results) {
      try {
        results = await searchGameStreams(item.query, item.leagueId, item.limit);
        setCachedGameStreams(cacheKey, results);
      } catch (err) {
        console.error('[gameStreamSearcher] Background prefetch failed for', item.eventId, err);
        results = [];
      }
    }
    item.resolve(results);
    queuedSearches.delete(cacheKey);

    // Yield 60ms between game searches so database and UI thread remain silky smooth
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  isPrefetching = false;
}

/**
 * Searches local channels database and EPG programs for matching matchup query or queries,
 * scoped to the league's search configuration (sources and categories) if set.
 */
export async function searchGameStreams(
  query: string | string[],
  leagueId?: string,
  limit = 20
): Promise<StoredChannel[]> {
  const rawQueries = Array.isArray(query) ? query : [query];
  const cleanQueries = rawQueries
    .map((q) => q.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((q) => q.length > 0);

  if (cleanQueries.length === 0) return [];

  const cacheKey = `${cleanQueries.join('||')}_${leagueId || 'all'}_${limit}`;
  const cached = getCachedGameStreams(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
    const allEnabledSources =
      sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || [];

    if (allEnabledSources.length === 0) return [];

    // Retrieve league search configuration if leagueId is provided
    let searchConfig = null;
    if (leagueId) {
      await useLeagueSearchConfigStore.getState().ensureLoaded();
      searchConfig = useLeagueSearchConfigStore.getState().getConfig(leagueId);
    }

    // Filter sources based on league search config
    let targetSourceIds = allEnabledSources;
    if (searchConfig?.sourceIds && searchConfig.sourceIds.length > 0) {
      targetSourceIds = allEnabledSources.filter((id) => searchConfig.sourceIds.includes(id));
      if (targetSourceIds.length === 0) return [];
    }

    const sourcePlaceholders = targetSourceIds.map(() => '?').join(',');

    // Filter categories based on league search config
    let targetCategoryIds: string[] = [];
    if (searchConfig?.categoryIds && searchConfig.categoryIds.length > 0) {
      targetCategoryIds = searchConfig.categoryIds;
    } else {
      const enabledCategoryRows = await db.query<{ category_id: string | number }>(
        `SELECT category_id FROM categories WHERE source_id IN (${sourcePlaceholders}) AND (enabled IS NULL OR enabled != 0)`,
        targetSourceIds
      );
      targetCategoryIds = enabledCategoryRows.map((r) => String(r.category_id));
    }

    if (targetCategoryIds.length === 0) return [];

    const categoryPlaceholders = targetCategoryIds.map(() => '?').join(',');

    // Build multi-query OR clauses for channels and programs
    const channelClauses: string[] = [];
    const channelParams: string[] = [];
    const programClauses: string[] = [];
    const programParams: string[] = [];

    for (const q of cleanQueries) {
      const chClause = buildSearchQueryClauses('c.name', q);
      if (chClause.sql) {
        channelClauses.push(`(${chClause.sql})`);
        channelParams.push(...chClause.params);
      }
      const progClause = buildSearchQueryClauses('p.title', q);
      if (progClause.sql) {
        programClauses.push(`(${progClause.sql})`);
        programParams.push(...progClause.params);
      }
    }

    if (channelClauses.length === 0 && programClauses.length === 0) return [];

    const nowIso = new Date().toISOString();
    const mergedMap = new Map<string, StoredChannel>();

    if (channelClauses.length > 0) {
      const wordLikeClauses = channelClauses.join(' OR ');
      const channelMatches = await db.query<StoredChannel>(
        `SELECT DISTINCT c.* FROM channels c CROSS JOIN json_each(c.category_ids) AS cat WHERE (${wordLikeClauses}) AND c.source_id IN (${sourcePlaceholders}) AND (c.enabled IS NULL OR c.enabled != 0) AND cat.value IN (${categoryPlaceholders}) LIMIT ${limit}`,
        [...channelParams, ...targetSourceIds, ...targetCategoryIds]
      );
      for (const ch of channelMatches) mergedMap.set(ch.stream_id, ch);
    }

    if (programClauses.length > 0) {
      const progLikeClauses = programClauses.join(' OR ');
      const programMatches = await db.query<StoredChannel>(
        `SELECT DISTINCT c.* FROM channels c INNER JOIN programs p ON p.stream_id = c.stream_id CROSS JOIN json_each(c.category_ids) AS cat WHERE (${progLikeClauses}) AND p.end > ? AND c.source_id IN (${sourcePlaceholders}) AND (c.enabled IS NULL OR c.enabled != 0) AND cat.value IN (${categoryPlaceholders}) LIMIT ${limit}`,
        [...programParams, nowIso, ...targetSourceIds, ...targetCategoryIds]
      );
      for (const ch of programMatches) mergedMap.set(ch.stream_id, ch);
    }

    const results = Array.from(mergedMap.values()).slice(0, limit);
    setCachedGameStreams(cacheKey, results);
    return results;
  } catch (err) {
    console.error('[gameStreamSearcher] Stream search error:', err);
    return [];
  }
}
