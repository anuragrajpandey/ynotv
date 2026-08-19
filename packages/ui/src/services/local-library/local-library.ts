import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalEntry, LocalGroup, LocalSortKey, ParsedFilename, SortDir } from './types';
import type { VodPlayInfo } from '../../types/media';
import type { StoredMovie, StoredSeries, StoredEpisode } from '../../db';
import { db, type LocalEntryRow } from '../../db';
import { readAppKvSync, loadAppKv, writeAppKv } from '../appKv';

function toAssetUrl(urlOrPath: string | null | undefined): string | undefined {
  if (!urlOrPath) return undefined;
  if (
    urlOrPath.startsWith('http://') ||
    urlOrPath.startsWith('https://') ||
    urlOrPath.startsWith('data:') ||
    urlOrPath.startsWith('asset:')
  ) {
    return urlOrPath;
  }
  try {
    return convertFileSrc(urlOrPath);
  } catch {
    return urlOrPath;
  }
}

const KEY = 'ynotv.library.local.v1'; // legacy app_kv/localStorage blob (migration source only)
const FOLDERS_KEY = 'ynotv.library.local.folders.v1';
const subs = new Set<() => void>();

// Storage history: the library originally lived in localStorage as one JSON
// blob. Large libraries (tens of thousands of entries) exceeded the WebView2
// localStorage quota (~10 MB); the old write() swallowed the QuotaExceededError,
// so a big scan reported "added X items" while persisting nothing. It then
// moved to the SQLite app_kv blob, and now to a dedicated `local_entries` table
// (one row per media file) so mutations are incremental instead of rewriting a
// 10–20 MB JSON blob. Entries are served synchronously from an in-memory cache;
// writes go to SQLite in the background (errors logged, never swallowed). The
// local_entries table is user data — it survives "Clear All Cached Data". The
// app_kv blob and legacy localStorage copy remain only as migration sources.

function parseEntries(raw: string | null): LocalEntry[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as LocalEntry[]) : null;
  } catch {
    return null;
  }
}

function entryToRow(e: LocalEntry): LocalEntryRow {
  return {
    id: e.id,
    path: e.path,
    filename: e.filename,
    title: e.title,
    year: e.year ?? null,
    type: e.type,
    resolution: e.resolution ?? null,
    rating: e.rating ?? null,
    runtime: e.runtime ?? null,
    poster: e.poster ?? null,
    backdrop: e.backdrop ?? null,
    logo: e.logo ?? null,
    overview: e.overview ?? null,
    tmdbId: e.tmdbId ?? null,
    imdbId: e.imdbId ?? null,
    season: e.season ?? null,
    episode: e.episode ?? null,
    addedAt: e.addedAt,
    needsReview: e.needsReview ?? null,
    source: e.source ?? null,
    localArt: e.localArt ?? null,
  };
}

function rowToEntry(r: LocalEntryRow): LocalEntry {
  return {
    id: r.id,
    path: r.path,
    filename: r.filename,
    title: r.title,
    year: r.year ?? null,
    type: r.type,
    resolution: r.resolution ?? null,
    rating: r.rating ?? null,
    runtime: r.runtime ?? null,
    poster: r.poster ?? null,
    backdrop: r.backdrop ?? null,
    logo: r.logo ?? null,
    overview: r.overview ?? null,
    tmdbId: r.tmdbId ?? null,
    imdbId: r.imdbId ?? null,
    season: r.season ?? null,
    episode: r.episode ?? null,
    addedAt: r.addedAt,
    needsReview: r.needsReview === true ? true : undefined,
    source: (r.source as 'tmdb' | 'nfo') ?? undefined,
    localArt: r.localArt ?? undefined,
  };
}

// Authoritative in-memory cache (sorted newest-first like the original blob).
let entriesCache: LocalEntry[] = [];

function sortEntries(arr: LocalEntry[]): LocalEntry[] {
  return arr.slice().sort((a, b) => b.addedAt - a.addedAt);
}

function readEntries(): LocalEntry[] {
  return entriesCache;
}

function readFolders(): string[] {
  const raw = readAppKvSync(FOLDERS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

/** Persist folders to the SQLite app_kv store (async, errors logged). */
function persistToKv(key: string, json: string): void {
  writeAppKv(key, json);
  if (!loaded) {
    void ensureLocalLibraryLoaded().then(() => writeAppKv(key, json));
  }
}

function writeFolders(folders: string[]): void {
  persistToKv(FOLDERS_KEY, JSON.stringify(folders));
  for (const s of subs) s();
}

/** Write rows to the local_entries table (INSERT OR REPLACE, incremental). */
function persistRows(rows: LocalEntryRow[]): void {
  if (rows.length === 0) return;
  void db.localEntries.bulkPut(rows).catch((e) => {
    console.warn('[LocalLibrary] Failed to persist entries:', e);
  });
}

/**
 * Persist a single entry row immediately (crash-safe checkpoint). The folder
 * scan writes each completed entry to SQLite as it finishes, so a mid-scan
 * crash or restart loses at most the in-flight file — a resume skips everything
 * already persisted instead of re-scanning it. Deliberately does not touch the
 * in-memory cache or subscribers (that happens once via addLocalEntries).
 */
export function persistLocalEntryIncremental(entry: LocalEntry): void {
  void db.localEntries.put(entryToRow(entry)).catch((e) => {
    console.warn('[LocalLibrary] Failed to persist entry checkpoint:', e);
  });
}

/** Delete rows by id (incremental). */
function persistRemove(ids: string[]): void {
  if (ids.length === 0) return;
  void db.localEntries.bulkDelete(ids).catch((e) => {
    console.warn('[LocalLibrary] Failed to remove entries:', e);
  });
}

let loadedPromise: Promise<void> | null = null;
let loaded = false;

/**
 * Load the authoritative library from the local_entries table (falling back to
 * the legacy app_kv blob / localStorage JSON, migrating them into the table on
 * first load). Folders load through the SQLite app_kv store. Idempotent; safe
 * to call from boot, hooks, and async scan entry points. Subscribers are
 * notified once loaded so hooks re-render with the persisted data.
 */
export function ensureLocalLibraryLoaded(): Promise<void> {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      await loadAppKv(FOLDERS_KEY).catch(() => null);

      let loadedEntries: LocalEntry[] = [];
      let tableRows = 0;
      try {
        const rows = await db.localEntries.toArray();
        tableRows = rows.length;
        if (rows.length > 0) {
          loadedEntries = rows.map(rowToEntry);
        }
      } catch (e) {
        console.warn('[LocalLibrary] Failed to read local_entries table:', e);
      }

      // TEMP DIAGNOSTIC — remove after migration retest. Shows where the data
      // actually is so a missing library can be traced to its source.
      try {
        const [kvEntries, kvFolders] = await Promise.all([
          db.appKv.get(KEY).catch(() => null),
          db.appKv.get(FOLDERS_KEY).catch(() => null),
        ]);
        console.log(
          '[LocalMigration] boot state',
          'lsEntries=' + (localStorage.getItem(KEY) ?? '').length,
          'lsFolders=' + (localStorage.getItem(FOLDERS_KEY) ?? '').length,
          'kvEntries=' + (kvEntries?.value?.length ?? 0),
          'kvFolders=' + (kvFolders?.value?.length ?? 0),
          'tableRows=' + tableRows,
        );
      } catch {
        /* ignore */
      }

      if (loadedEntries.length === 0) {
        // First run after upgrade: migrate the legacy JSON blob(s) into the table.
        const raw = await loadAppKv(KEY).catch(() => null);
        const legacy = parseEntries(raw) ?? parseEntries(readAppKvSync(KEY)) ?? [];
        if (legacy.length > 0) {
          console.log('[LocalMigration] migrating legacy entries blob → local_entries:', legacy.length);
          loadedEntries = legacy;
          persistRows(legacy.map(entryToRow));
          void db.appKv.delete(KEY).catch(() => {});
        }
      }

      console.log(
        '[LocalMigration] result',
        'loadedEntries=' + loadedEntries.length,
        'folders=' + JSON.stringify(readFolders()),
      );

      // Merge with anything a mutation already wrote this session (mutations
      // win on conflict; persisted rows we haven't seen yet are preserved).
      if (entriesCache.length === 0) {
        entriesCache = sortEntries(loadedEntries);
      } else {
        const byId = new Map(entriesCache.map((e) => [e.id, e]));
        for (const e of loadedEntries) {
          if (!byId.has(e.id)) byId.set(e.id, e);
        }
        entriesCache = sortEntries(Array.from(byId.values()));
      }
    })().then(
      () => {
        loaded = true;
        for (const s of subs) s();
      },
      () => {
        loadedPromise = null; // allow retry on failure
      },
    );
  }
  return loadedPromise;
}

export function readScannedFolders(): string[] {
  return readFolders();
}

export function saveScannedFolders(folders: string[]): void {
  writeFolders(folders);
}

export function addScannedFolder(folder: string): void {
  const norm = folder.trim();
  if (!norm) return;
  const existing = readFolders();
  if (!existing.some((f) => f.toLowerCase() === norm.toLowerCase())) {
    writeFolders([...existing, norm]);
  }
}

export function removeScannedFolder(folder: string): void {
  const norm = folder.replace(/\\/g, '/').toLowerCase();
  const nextFolders = readFolders().filter((f) => f.replace(/\\/g, '/').toLowerCase() !== norm);
  writeFolders(nextFolders);

  // Remove all entries residing under this folder (incremental row deletes).
  const prefix = norm.endsWith('/') ? norm : `${norm}/`;
  const removedIds: string[] = [];
  for (const e of entriesCache) {
    const p = e.path.replace(/\\/g, '/').toLowerCase();
    if (p.startsWith(prefix) || p === norm) removedIds.push(e.id);
  }
  removeLocalEntries(removedIds);
}

export function useScannedFolders(): string[] {
  const [folders, setFolders] = useState<string[]>(() => readFolders());
  useEffect(() => {
    ensureLocalLibraryLoaded().catch(() => {});
    const tick = () => setFolders(readFolders());
    subs.add(tick);
    return () => {
      subs.delete(tick);
    };
  }, []);
  return folders;
}

export function readLocalLibrary(): LocalEntry[] {
  return readEntries();
}

export function addLocalEntries(entries: LocalEntry[]): void {
  if (entries.length === 0) return;
  const byPath = new Map(entriesCache.map((e) => [e.path, e]));
  const changed: LocalEntry[] = [];
  for (const e of entries) {
    const prev = byPath.get(e.path);
    byPath.set(e.path, e);
    if (!prev || prev.id !== e.id || prev.addedAt !== e.addedAt || prev.title !== e.title) {
      changed.push(e);
    }
  }
  entriesCache = sortEntries(Array.from(byPath.values()));
  persistRows(changed.map(entryToRow));
  for (const s of subs) s();
}

export function removeLocalEntry(id: string): void {
  removeLocalEntries([id]);
}

export function removeLocalEntries(ids: string[]): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const next = entriesCache.filter((e) => !idSet.has(e.id));
  if (next.length === entriesCache.length) return;
  entriesCache = next;
  persistRemove(Array.from(idSet));
  for (const s of subs) s();
}

export function updateLocalEntries(
  ids: string[],
  patch: Partial<LocalEntry> | ((entry: LocalEntry) => Partial<LocalEntry>),
): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const changed: LocalEntry[] = [];
  const next = entriesCache.map((e) => {
    if (!idSet.has(e.id)) return e;
    const p = typeof patch === 'function' ? patch(e) : patch;
    const updated = { ...e, ...p };
    changed.push(updated);
    return updated;
  });
  if (changed.length === 0) return;
  entriesCache = next;
  persistRows(changed.map(entryToRow));
  for (const s of subs) s();
}

export function useLocalLibrary(): LocalEntry[] {
  const [items, setItems] = useState<LocalEntry[]>(() => readEntries());
  useEffect(() => {
    ensureLocalLibraryLoaded().catch(() => {});
    const tick = () => setItems(readEntries());
    subs.add(tick);
    return () => {
      subs.delete(tick);
    };
  }, []);
  return items;
}

const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'm4v', 'mov', 'avi', 'wmv', 'webm', 'ts', 'm2ts', 'mpg', 'mpeg', 'flv', 'ogv',
]);

export function isVideoFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTS.has(ext);
}

const NOISE = [
  '1080p', '720p', '2160p', '4k', 'uhd', 'hdr', 'hdr10', 'dv',
  'bluray', 'bdrip', 'brrip', 'webrip', 'web-dl', 'webdl', 'hdtv', 'dvdrip', 'remux',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', '10bit',
  'atmos', 'ddp', 'dts', 'ac3', 'aac',
  'yify', 'yts', 'rarbg', 'fgt', 'evo', 'psa',
];
const NOISE_RX = new RegExp(`\\b(${NOISE.join('|')})\\b`, 'gi');
const TV_RX =
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b|\bseason[\s._-]*(\d{1,2})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,3})\b/i;
const YEAR_RX = /\b(19\d{2}|20\d{2})\b/;

export function parseFilename(filename: string): ParsedFilename {
  const stem = filename.replace(/\.(mkv|mp4|m4v|mov|avi|wmv|webm|ts|m2ts|mpg|mpeg|flv|ogv)$/i, '');
  const tv = stem.match(TV_RX);
  const season = tv ? parseInt(tv[1] ?? tv[3] ?? tv[5], 10) : null;
  const episode = tv ? parseInt(tv[2] ?? tv[4] ?? tv[6], 10) : null;
  const yearMatch = stem.match(YEAR_RX);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  const resMatch = stem.match(/\b(2160p|1080p|720p|480p|4k|uhd)\b/i);
  const resolution = resMatch ? resMatch[1].toLowerCase() : null;
  let title = stem;
  if (tv) title = title.slice(0, tv.index);
  if (yearMatch && yearMatch.index != null && yearMatch.index < title.length) {
    title = title.slice(0, yearMatch.index);
  }
  title = title
    .replace(/[._]+/g, ' ')
    .replace(NOISE_RX, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\[\(\{].*?[\]\)\}]/g, '')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[\s\-–—_]+$/g, '')
    .replace(/^[\s\-–—_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) title = stem;
  return {
    title,
    year,
    type: tv ? 'show' : 'movie',
    season,
    episode,
    resolution,
  };
}

export function extractEpisodeNumber(filename: string): { season: number; episode: number } | null {
  const stem = filename.replace(/\.(mkv|mp4|m4v|mov|avi|wmv|webm|ts|m2ts|mpg|mpeg|flv|ogv)$/i, '');
  const tv = stem.match(
    /(?:^|[\s._\-\[\(])s(\d{1,2})[\s._-]*e(\d{1,3})(?:[\s._\-\]\)]|$)|(?:^|[\s._\-\[\(])(\d{1,2})x(\d{1,3})(?:[\s._\-\]\)]|$)|(?:^|[\s._\-\[\(])season[\s._-]*(\d{1,2})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,3})(?:[\s._\-\]\)]|$)/i,
  );
  if (tv) {
    const season = parseInt(tv[1] ?? tv[3] ?? tv[5], 10);
    const episode = parseInt(tv[2] ?? tv[4] ?? tv[6], 10);
    return { season: isNaN(season) ? 1 : season, episode: isNaN(episode) ? 1 : episode };
  }
  const epOnly = stem.match(/(?:^|[\s._\-\[\(])(?:ep|episode|e)[\s._-]*(\d{1,3})(?:[\s._\-\]\)]|$)/i);
  if (epOnly) {
    const ep = parseInt(epOnly[1], 10);
    if (!isNaN(ep)) return { season: 1, episode: ep };
  }
  const numMatch = stem.match(/(?:[-_\s\[\(])(\d{1,3})(?:[-_\s\]\)]|$)/);
  if (numMatch) {
    const ep = parseInt(numMatch[1], 10);
    if (!isNaN(ep) && ep < 1000) return { season: 1, episode: ep };
  }
  return null;
}

export function episodeLabel(e: LocalEntry): string | null {
  if (e.type === 'show' && e.season != null && e.episode != null) {
    return `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
  }
  return null;
}

export function groupLocal(items: LocalEntry[]): LocalGroup[] {
  const out: LocalGroup[] = [];
  const showIdx = new Map<string, number>();
  for (const it of items) {
    if (it.type !== 'show') {
      out.push({ kind: 'movie', entry: it });
      continue;
    }
    const key = (it.imdbId || (it.tmdbId ? `tmdb_${it.tmdbId}` : null) || it.title || it.filename).toLowerCase();
    const at = showIdx.get(key);
    if (at != null) {
      (out[at] as { episodes: LocalEntry[] }).episodes.push(it);
    } else {
      showIdx.set(key, out.length);
      out.push({ kind: 'show', key, head: it, episodes: [it] });
    }
  }
  for (const g of out) {
    if (g.kind !== 'show') continue;
    g.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    g.head = g.episodes.find((e) => e.poster) ?? g.episodes[0];
  }
  return out;
}

export function sortGroups(
  groups: LocalGroup[],
  sortKey: LocalSortKey,
  sortDir: SortDir,
): LocalGroup[] {
  const mul = sortDir === 'asc' ? 1 : -1;
  const list = [...groups];
  list.sort((a, b) => {
    const headA = a.kind === 'movie' ? a.entry : a.head;
    const headB = b.kind === 'movie' ? b.entry : b.head;
    if (sortKey === 'name') {
      return mul * (headA.title || '').localeCompare(headB.title || '');
    }
    if (sortKey === 'rating') {
      const rA = headA.rating ?? 0;
      const rB = headB.rating ?? 0;
      return mul * (rA - rB);
    }
    if (sortKey === 'year') {
      const yA = headA.year ?? 0;
      const yB = headB.year ?? 0;
      return mul * (yA - yB);
    }
    // 'added'
    const tA = headA.addedAt ?? 0;
    const tB = headB.addedAt ?? 0;
    return mul * (tA - tB);
  });
  return list;
}

/**
 * Resolve the ordered episode list (season → episode) of the local series the
 * given episode belongs to, or null when `episodeId` isn't a local series
 * episode. Mirrors groupLocal's grouping key so navigation matches the show
 * cards in the Local tab. Used by the player's prev/next episode buttons.
 */
export function getLocalEpisodeList(episodeId?: string | null): LocalEntry[] | null {
  if (!episodeId) return null;
  const all = readLocalLibrary();
  const current = all.find((e) => e.id === episodeId);
  if (!current || current.type !== 'show') return null;
  const key = (
    current.imdbId ||
    (current.tmdbId ? `tmdb_${current.tmdbId}` : null) ||
    current.title ||
    current.filename
  ).toLowerCase();
  return all
    .filter(
      (e) =>
        e.type === 'show' &&
        (e.imdbId || (e.tmdbId ? `tmdb_${e.tmdbId}` : null) || e.title || e.filename).toLowerCase() ===
          key,
    )
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
}

/**
 * Converts a LocalEntry into standard VodPlayInfo for playback via MPV
 */
export function localEntryToVodPlayInfo(
  entry: LocalEntry,
  seriesGroup?: { key: string; head: LocalEntry },
): VodPlayInfo {
  const epLabel = episodeLabel(entry);
  const isSeries = entry.type === 'show';
  const seriesTitle = seriesGroup?.head?.title || entry.title;
  const seriesKey = seriesGroup?.key || (entry.imdbId || (entry.tmdbId ? `tmdb_${entry.tmdbId}` : null) || seriesTitle).toLowerCase().replace(/[^a-z0-9]+/g, '_');

  const mediaId = isSeries
    ? `local_${seriesKey}_ep_${entry.id}`
    : `local_${entry.id}`;

  return {
    url: entry.path,
    title: isSeries ? seriesTitle : entry.title,
    year: entry.year ? String(entry.year) : undefined,
    plot: entry.overview ?? undefined,
    type: isSeries ? 'series' : 'movie',
    episodeInfo: epLabel ? `${epLabel}${entry.title && entry.title !== seriesTitle ? ` · ${entry.title}` : ''}` : undefined,
    source_id: 'local',
    mediaId,
    seriesId: isSeries ? `local_${seriesKey}` : undefined,
    episodeId: isSeries ? entry.id : undefined,
    seasonNum: entry.season ?? undefined,
    episodeNum: entry.episode ?? undefined,
    posterUrl: entry.poster || entry.localArt?.poster || seriesGroup?.head?.poster || undefined,
    backdropUrl: entry.backdrop || entry.localArt?.backdrop || seriesGroup?.head?.backdrop || undefined,
    logoUrl: entry.logo || entry.localArt?.logo || undefined,
    tmdbId: entry.tmdbId ?? undefined,
    imdbId: entry.imdbId ?? undefined,
  };
}

/**
 * Converts a LocalEntry (movie) into StoredMovie for VOD browsing and detail pages
 */
export function localEntryToStoredMovie(entry: LocalEntry): StoredMovie {
  const poster = toAssetUrl(entry.poster || entry.localArt?.poster) || '';
  const backdrop = toAssetUrl(entry.backdrop || entry.localArt?.backdrop);

  return {
    stream_id: `local_${entry.id}`,
    name: entry.title || entry.filename,
    title: entry.title,
    year: entry.year ? String(entry.year) : undefined,
    stream_icon: poster,
    category_ids: JSON.stringify(['local']),
    direct_url: entry.path,
    source_id: 'local',
    plot: entry.overview ?? undefined,
    rating: entry.rating != null ? String(entry.rating) : undefined,
    duration: entry.runtime ? entry.runtime * 60 : undefined,
    tmdb_id: entry.tmdbId ?? undefined,
    imdb_id: entry.imdbId ?? undefined,
    backdrop_path: backdrop,
    added: new Date(entry.addedAt),
  };
}

/**
 * Converts a local show group into StoredSeries for VOD browsing and detail pages
 */
export function localGroupToStoredSeries(group: { key: string; head: LocalEntry; episodes: LocalEntry[] }): StoredSeries {
  const head = group.head;
  const cover = toAssetUrl(head.poster || head.localArt?.poster) || '';
  const backdrop = toAssetUrl(head.backdrop || head.localArt?.backdrop);

  return {
    series_id: `local_${group.key}`,
    name: head.title || head.filename,
    title: head.title,
    year: head.year ? String(head.year) : undefined,
    cover,
    category_ids: ['local'],
    source_id: 'local',
    plot: head.overview ?? undefined,
    rating: head.rating != null ? String(head.rating) : undefined,
    tmdb_id: head.tmdbId ?? undefined,
    imdb_id: head.imdbId ?? undefined,
    backdrop_path: backdrop,
    added: new Date(head.addedAt),
    direct_url: head.path,
  };
}

/**
 * Converts a local episode entry into StoredEpisode for SeriesDetail
 */
export function localEntryToStoredEpisode(
  entry: LocalEntry,
  seriesId: string,
  seriesTitle?: string
): StoredEpisode {
  const epNum = entry.episode ?? 1;
  const epTitle = entry.title && entry.title !== seriesTitle ? entry.title : `Episode ${epNum}`;

  return {
    id: entry.id,
    series_id: seriesId,
    title: epTitle,
    episode_num: epNum,
    season_num: entry.season ?? 1,
    direct_url: entry.path,
    plot: entry.overview ?? undefined,
    duration: entry.runtime ? entry.runtime * 60 : undefined,
  };
}

