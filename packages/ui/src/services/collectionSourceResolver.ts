import type { NuvioCollection, NuvioCollectionFolder, NuvioCollectionSource } from './nuvio-api';
import type { StremioMetaPreview, InstalledAddon } from '../types/stremio';
import { fetchCatalog } from './stremio-addon';
import { scrobbler } from './scrobbler';
import { getTmdbImageUrl } from './tmdb';
import { useSettingsStore } from '../stores/settingsStore';

export const normalizeGenre = (genre: string | null | undefined): string | undefined => {
  const g = (genre || '').trim();
  return g && !/^none$/i.test(g) ? g : undefined;
};

export const isAioMetadataAddon = (addon: InstalledAddon): boolean => {
  const addonId = (addon.manifest?.id || addon.id || '').toLowerCase();
  const baseUrl = (addon.baseUrl || '').toLowerCase();
  const name = (addon.manifest?.name || '').toLowerCase();
  const description = (addon.manifest?.description || '').toLowerCase();

  return (
    addonId.includes('aio') ||
    addonId.includes('genres') ||
    baseUrl.includes('aio') ||
    baseUrl.includes('genres') ||
    name.includes('aio') ||
    name.includes('genres') ||
    description.includes('aio') ||
    description.includes('genres')
  );
};

export const isCinemetaAddon = (addon: InstalledAddon): boolean => {
  const addonId = (addon.manifest?.id || addon.id || '').toLowerCase();
  const baseUrl = (addon.baseUrl || '').toLowerCase();
  const name = (addon.manifest?.name || '').toLowerCase();

  return (
    addonId.includes('cinemeta') ||
    addonId.includes('linvo') ||
    baseUrl.includes('cinemeta') ||
    baseUrl.includes('linvo') ||
    name.includes('cinemeta') ||
    name.includes('linvo')
  );
};

export const fuzzyMatchAddon = (source: NuvioCollectionSource, addon: InstalledAddon): boolean => {
  const targetId = (source.addonId || '').trim().toLowerCase();
  if (!targetId) return false;

  const addonId = (addon.manifest?.id || addon.id || '').toLowerCase();
  if (addonId === targetId) return true;

  if ((targetId.includes('aio') || targetId.includes('genres')) && isAioMetadataAddon(addon)) return true;
  if ((targetId.includes('cinemeta') || targetId.includes('linvo')) && isCinemetaAddon(addon)) return true;

  return false;
};

export const findAddonForSource = (
  source: NuvioCollectionSource,
  addons: InstalledAddon[]
): InstalledAddon | undefined => {
  const catalogType = source.type === 'tv' ? 'series' : (source.type || 'movie');
  const catalogId = source.catalogId || 'top';
  const targetId = (source.addonId || '').trim().toLowerCase();

  const hasMatchingCatalog = (a: InstalledAddon) =>
    a.manifest?.catalogs?.some(
      (c: any) => (c.type === catalogType || (c.type === 'tv' && catalogType === 'series')) &&
           (c.id === catalogId || c.id === catalogId.split(',')[0])
    );

  if (targetId) {
    const exactMatch = addons.find(a => (a.manifest?.id || a.id || '').toLowerCase() === targetId);
    if (exactMatch && hasMatchingCatalog(exactMatch)) return exactMatch;
  }

  const heuristicMatch = addons.find(a => hasMatchingCatalog(a) && fuzzyMatchAddon(source, a));
  if (heuristicMatch) return heuristicMatch;

  return addons.find(hasMatchingCatalog);
};

export const getFolderResolvedSources = (folder: NuvioCollectionFolder): NuvioCollectionSource[] => {
  if (folder.sources && folder.sources.length > 0) return folder.sources;
  if ((folder as any).catalogSources && (folder as any).catalogSources.length > 0) {
    return (folder as any).catalogSources.map((cs: any) => ({
      provider: 'addon',
      addonId: cs.addonId,
      type: cs.type,
      catalogId: cs.catalogId,
      genre: normalizeGenre(cs.genre),
    }));
  }
  return [];
};

/**
 * Resolves meta preview items from a single collection source.
 */
export async function resolveSourceItems(
  source: NuvioCollectionSource,
  activeAddons: InstalledAddon[],
  options?: { limit?: number; skip?: number }
): Promise<StremioMetaPreview[]> {
  const limit = options?.limit ?? 20;
  const skip = options?.skip ?? 0;

  if (source.provider === 'trakt') {
    try {
      if (source.traktListId) {
        const page = Math.floor(skip / 30) + 1;
        const res = await scrobbler.fetchTraktListCatalog(String(source.traktListId), page);
        return res.items || [];
      } else if (source.catalogId) {
        const page = Math.floor(skip / 30) + 1;
        const res = await scrobbler.fetchTraktCatalog(source.catalogId as any, page);
        return res.items || [];
      }
    } catch (e) {
      console.warn('[CollectionSourceResolver] Failed to resolve Trakt source:', e);
      return [];
    }
  }

  if (source.provider === 'tmdb') {
    try {
      const apiKey = useSettingsStore.getState().tmdbApiKey;
      if (!apiKey) return [];

      const isJwt = apiKey.startsWith('ey');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json;charset=utf-8',
      };
      if (isJwt) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const tmdbType = (source.tmdbSourceType || '').toLowerCase();
      let endpoint = '';
      const authQuery = isJwt ? '' : `api_key=${encodeURIComponent(apiKey)}&`;

      if (tmdbType === 'collection' && source.tmdbId) {
        endpoint = `https://api.themoviedb.org/3/collection/${source.tmdbId}?${authQuery}`;
      } else if (tmdbType === 'list' && source.tmdbId) {
        endpoint = `https://api.themoviedb.org/3/list/${source.tmdbId}?${authQuery}`;
      } else if (source.tmdbId) {
        endpoint = `https://api.themoviedb.org/3/list/${source.tmdbId}?${authQuery}`;
      } else {
        const media = source.mediaType === 'tv' ? 'tv' : 'movie';
        endpoint = `https://api.themoviedb.org/3/discover/${media}?${authQuery}sort_by=popularity.desc&page=${Math.floor(skip / 20) + 1}`;
      }

      const res = await fetch(endpoint, { headers });
      if (!res.ok) return [];
      const json = await res.json();

      const rawItems: any[] = json.parts || json.items || json.results || [];
      return rawItems.map((raw: any) => {
        const isTv = raw.first_air_date !== undefined || raw.name !== undefined;
        return {
          id: raw.imdb_id || (raw.id ? `tmdb:${raw.id}` : Math.random().toString(36).substring(2)),
          type: isTv ? 'series' : 'movie',
          name: raw.name || raw.title || 'Untitled',
          poster: getTmdbImageUrl(raw.poster_path, 'w500') || undefined,
          background: getTmdbImageUrl(raw.backdrop_path, 'w1280') || getTmdbImageUrl(raw.poster_path, 'w500') || undefined,
          description: raw.overview || undefined,
          imdbRating: raw.vote_average ? raw.vote_average.toFixed(1) : undefined,
          releaseInfo: (raw.release_date || raw.first_air_date || '').substring(0, 4) || undefined,
        };
      });
    } catch (e) {
      console.warn('[CollectionSourceResolver] Failed to resolve TMDB source:', e);
      return [];
    }
  }

  // Stremio Addon Provider
  const catalogType = source.type === 'tv' ? 'series' : (source.type || 'movie');
  const catalogId = source.catalogId || 'top';
  const resolvedAddon = findAddonForSource(source, activeAddons);
  if (!resolvedAddon) return [];

  const extra: Record<string, string> = {};
  const normalizedGenre = normalizeGenre(source.genre);
  if (normalizedGenre) extra.genre = normalizedGenre;
  if (skip > 0) extra.skip = String(skip);
  extra.limit = String(limit);

  try {
    const resp = await fetchCatalog(resolvedAddon.baseUrl, catalogType, catalogId, extra);
    return (resp?.metas || []).filter((m: StremioMetaPreview) => m.background || m.poster);
  } catch (e) {
    console.warn('[CollectionSourceResolver] Failed to fetch catalog items for addon:', resolvedAddon.manifest?.name, e);
    return [];
  }
}

/**
 * Resolves items from a collection folder (either specific sourceIndex or all sources).
 */
export async function resolveCollectionFolderItems(
  folder: NuvioCollectionFolder,
  activeAddons: InstalledAddon[],
  options?: { limit?: number; skip?: number; sourceIndex?: number }
): Promise<StremioMetaPreview[]> {
  const sources = getFolderResolvedSources(folder);
  if (sources.length === 0) return [];

  if (options?.sourceIndex !== undefined) {
    const source = sources[options.sourceIndex];
    if (!source) return [];
    return resolveSourceItems(source, activeAddons, options);
  }

  // Fetch from all sources in folder concurrently
  const sourcePromises = sources.map(s => resolveSourceItems(s, activeAddons, options));
  const results = await Promise.all(sourcePromises);
  const combined: StremioMetaPreview[] = [];
  const maxLen = Math.max(0, ...results.map(r => r.length));

  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < results.length; j++) {
      if (i < results[j].length) {
        combined.push(results[j][i]);
      }
    }
  }

  return combined;
}

/**
 * Resolves hero items from a list of collections.
 * Mirrors Nuvio Desktop's HomeRepository.ensureCollectionHeroFallback logic.
 */
export async function resolveCollectionsForHero(
  collections: NuvioCollection[],
  activeAddons: InstalledAddon[],
  maxItems: number = 15
): Promise<StremioMetaPreview[]> {
  const folders: NuvioCollectionFolder[] = collections.flatMap(c => c.folders || []);
  if (folders.length === 0) return [];

  // Gather sources across all folders (capped at top 10 sources)
  const sources = folders.flatMap(f => getFolderResolvedSources(f)).slice(0, 10);
  if (sources.length === 0) return [];

  const sourcePromises = sources.map(source =>
    resolveSourceItems(source, activeAddons, { limit: 12 }).catch(() => [] as StremioMetaPreview[])
  );

  const results = await Promise.all(sourcePromises);
  const combined: StremioMetaPreview[] = [];
  const maxLen = Math.max(0, ...results.map(r => r.length));

  // Round-robin selection across sources
  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < results.length; j++) {
      if (i < results[j].length) {
        combined.push(results[j][i]);
      }
    }
  }

  // Deduplicate by type:id
  const seen = new Set<string>();
  const uniqueItems = combined.filter(item => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(item.background || item.poster);
  });

  // Shuffle pseudo-randomly to give variety
  const shuffled = [...uniqueItems].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, maxItems);
}
