import type { FolderType, LocalEntry, ParsedFilename, ScannedFile, SeriesPathInfo } from './types';
import { parseFilename, extractEpisodeNumber } from './local-library';
import {
  findLocalArt,
  findNfo,
  findShowArt,
  findShowNfo,
  readNfo,
} from './sidecars';
import { rateLimitedFetch } from '../../services/tmdbRateLimit';

export type TmdbLookup = {
  tmdbId?: number;
  imdbId?: string;
  poster?: string;
  backdrop?: string;
  matchedTitle?: string;
  matchedYear?: number | null;
  overview?: string;
  rating?: number;
  runtime?: number;
};

export function hashPath(path: string): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) | 0;
  }
  return `local-${(hash >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Per-(title, year, type) TMDB result cache
// ---------------------------------------------------------------------------
// A series folder scan derives every episode's title from the SAME folder
// name, so keying lookups by (type | title | year) means a whole series reuses
// a single TMDB search instead of re-matching every file. Matches are kept in
// memory for the session and persisted to localStorage with a TTL so re-scans
// and the 15-minute auto-sync don't re-fetch unchanged series. Only confident
// matches are cached — a failed or low-confidence lookup is never stored, so
// "Rescan Missing" can genuinely retry.

const TMDB_MATCH_CACHE_KEY = 'ynotv.local.cache.tmdbMatch.v1';
const TMDB_MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const tmdbMatchMemory = new Map<string, TmdbLookup>();
let tmdbMatchStorage: Record<string, { value: TmdbLookup; ts: number }> | null = null;

function loadTmdbMatchStorage(): Record<string, { value: TmdbLookup; ts: number }> {
  if (tmdbMatchStorage) return tmdbMatchStorage;
  try {
    const raw = localStorage.getItem(TMDB_MATCH_CACHE_KEY);
    tmdbMatchStorage = raw
      ? (JSON.parse(raw) as Record<string, { value: TmdbLookup; ts: number }>)
      : {};
  } catch {
    tmdbMatchStorage = {};
  }
  return tmdbMatchStorage;
}

function persistTmdbMatchStorage(): void {
  try {
    localStorage.setItem(TMDB_MATCH_CACHE_KEY, JSON.stringify(tmdbMatchStorage));
  } catch {
    /* quota / storage unavailable */
  }
}

export function tmdbMatchCacheKey(
  title: string,
  year: number | null,
  type: 'movie' | 'show',
): string {
  return `${type}|${title.toLowerCase().trim()}|${year ?? ''}`;
}

function getCachedMatch(key: string): TmdbLookup | null {
  const memory = tmdbMatchMemory.get(key);
  if (memory) return memory;
  const stored = loadTmdbMatchStorage()[key];
  if (stored && Date.now() - stored.ts < TMDB_MATCH_TTL_MS) {
    tmdbMatchMemory.set(key, stored.value);
    return stored.value;
  }
  return null;
}

function setCachedMatch(key: string, value: TmdbLookup): void {
  tmdbMatchMemory.set(key, value);
  loadTmdbMatchStorage()[key] = { value, ts: Date.now() };
  persistTmdbMatchStorage();
}

/** Drop the whole match cache (e.g. after a user manually fixes a match). */
export function clearTmdbMatchCache(): void {
  tmdbMatchMemory.clear();
  tmdbMatchStorage = null;
  try {
    localStorage.removeItem(TMDB_MATCH_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Drop a single (title, year, type) entry from the match cache so the next
 * lookup re-queries TMDB (used by "Refresh Metadata" — the cache only holds
 * confident matches, but one may hold a stale/broken poster).
 */
export function invalidateTmdbMatchCache(
  title: string,
  year: number | null,
  type: 'movie' | 'show',
): void {
  const key = tmdbMatchCacheKey(title, year, type);
  tmdbMatchMemory.delete(key);
  const stored = loadTmdbMatchStorage();
  if (stored[key]) {
    delete stored[key];
    persistTmdbMatchStorage();
  }
}

/**
 * TMDB lookup that reuses a cached confident match for the same
 * (title, year, type) and only caches new confident matches. A low-confidence
 * or failed lookup is never cached so re-matching can improve.
 */
async function tmdbLookupCached(
  token: string,
  title: string,
  year: number | null,
  type: 'movie' | 'show',
  parsed: ParsedFilename,
  signal?: AbortSignal,
): Promise<TmdbLookup> {
  const key = tmdbMatchCacheKey(title, year, type);
  const cached = getCachedMatch(key);
  if (cached) return cached;

  const result = await tmdbLookup(token, title, year, type, signal);
  if (result.tmdbId != null && !lowConfidence(parsed, result)) {
    setCachedMatch(key, result);
  }
  return result;
}

export async function buildTmdbEntry(
  f: ScannedFile,
  parsed: ParsedFilename,
  tmdbToken: string | null,
  signal?: AbortSignal,
): Promise<LocalEntry> {
  let tmdb: TmdbLookup = {};
  if (tmdbToken) {
    tmdb = await tmdbLookupCached(tmdbToken, parsed.title, parsed.year, parsed.type, parsed, signal).catch(
      (e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        return {};
      },
    );
  }
  const needsReview = tmdbToken ? lowConfidence(parsed, tmdb) : false;
  const identified = tmdb.tmdbId != null && !needsReview;
  return {
    id: hashPath(f.path),
    path: f.path,
    filename: f.filename,
    title: identified ? tmdb.matchedTitle?.trim() || parsed.title : parsed.title,
    year: (identified ? tmdb.matchedYear : null) ?? parsed.year,
    type: parsed.type,
    resolution: parsed.resolution,
    rating: tmdb.rating ?? null,
    runtime: tmdb.runtime ?? null,
    poster: tmdb.poster ?? null,
    backdrop: tmdb.backdrop ?? null,
    overview: tmdb.overview ?? null,
    tmdbId: tmdb.tmdbId ?? null,
    imdbId: tmdb.imdbId ?? null,
    season: parsed.season,
    episode: parsed.episode,
    addedAt: Date.now(),
    source: 'tmdb',
    needsReview: needsReview || undefined,
  };
}

export async function buildNfoEntry(
  f: ScannedFile,
  parsed: ParsedFilename,
  tmdbToken: string | null,
  signal?: AbortSignal,
): Promise<LocalEntry> {
  const nfoPath = await findNfo(f.path);
  const nfo = nfoPath ? await readNfo(nfoPath) : null;

  const isShow = parsed.type === 'show';
  let seriesNfo: Awaited<ReturnType<typeof readNfo>> = null;
  if (isShow) {
    const showNfoPath = await findShowNfo(f.path);
    seriesNfo = showNfoPath ? await readNfo(showNfoPath) : null;
  }
  const meta = isShow ? seriesNfo : nfo;

  const files = isShow ? await findShowArt(f.path, parsed.season) : await findLocalArt(f.path);

  const art = {
    poster: files.poster ?? meta?.art?.poster,
    logo: files.logo ?? meta?.art?.logo,
    backdrop: files.backdrop ?? meta?.art?.backdrop,
  };

  let title = (
    isShow ? meta?.title || nfo?.showTitle || parsed.title : nfo?.title || parsed.title
  ).trim();
  const year = meta?.year ?? parsed.year;
  let tmdbId = meta?.tmdbId ?? null;
  let imdbId = meta?.imdbId ?? null;
  let poster: string | null = null;
  let backdrop: string | null = null;
  let overview = meta?.plot ?? null;
  let rating = meta?.rating ?? null;
  let runtime = meta?.runtime ?? null;

  if (tmdbToken && !tmdbId) {
    const look = await tmdbLookupCached(tmdbToken, title, year, parsed.type, parsed, signal).catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      return {} as TmdbLookup;
    });
    if (look.tmdbId) tmdbId = look.tmdbId;
    if (!imdbId && look.imdbId) imdbId = look.imdbId;
    if (!art.poster && look.poster) poster = look.poster;
    if (!art.backdrop && look.backdrop) backdrop = look.backdrop;
    if (!overview && look.overview) overview = look.overview;
    if (rating == null && look.rating != null) rating = look.rating;
    if (runtime == null && look.runtime != null) runtime = look.runtime;
    const hadNfoTitle = isShow ? !!(meta?.title || nfo?.showTitle) : !!nfo?.title;
    if (!hadNfoTitle && look.matchedTitle) title = look.matchedTitle.trim();
  }

  const localArt = art.poster || art.logo || art.backdrop ? art : undefined;
  const needsReview = !tmdbId && !imdbId && !art.poster;

  return {
    id: hashPath(f.path),
    path: f.path,
    filename: f.filename,
    title,
    year,
    type: parsed.type,
    resolution: parsed.resolution,
    rating,
    runtime,
    poster,
    backdrop,
    overview,
    tmdbId,
    imdbId,
    season: parsed.season,
    episode: parsed.episode,
    addedAt: Date.now(),
    source: 'nfo',
    localArt,
    needsReview: needsReview || undefined,
  };
}

// ---------------------------------------------------------------------------
// Series-folder scanning
// ---------------------------------------------------------------------------
// A typed 'show' folder is expected to look like Plex/Jellyfin:
//
//   <Root>/
//     <Series Name>/
//       Season 1/...
//       Season 2/...
//   or
//     <Series Name>/
//       all episodes flat here
//
// The series title is taken from the folder name (not each filename), so the
// per-(title, year, type) cache above collapses a whole series into ONE TMDB
// lookup that every episode reuses. If the user happens to point at a single
// series folder (root itself is the series, with or without Season subfolders)
// that is handled too.

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function relativeSegments(path: string, rootPath: string): string[] {
  const p = path.replace(/\\/g, '/');
  const r = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = p;
  if (r && p.toLowerCase().startsWith(r.toLowerCase())) {
    rel = p.slice(r.length);
  }
  return rel.replace(/^\/+/, '').split('/').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Series folder-name cleaning
// ---------------------------------------------------------------------------
// Ported from Jellyfin's Emby.Naming (SeriesResolver + CleanDateTime + CleanStrings):
// release-style folder names like "A.Shop.for.Killers.S01.1080p.DSNP.WEB-DL.DDP5.1.H.264-APEX"
// are reduced to "A Shop for Killers" by stripping the year, season marker, and
// resolution/source/codec/audio tokens. Combined forms ("H.264", "DDP5.1") are
// listed before their bare prefixes so no stray digits are left behind.

const SERIES_FOLDER_NOISE = [
  // resolutions
  '2160p', '1080p', '720p', '480p', '576p', '4k', 'uhd', 'ultrahd', '1080', '2160', 'hrhd', 'hrhdtv', 'hddvd',
  // codecs / hdr
  'h\\s*\\.?\\s*264', 'h\\s*\\.?\\s*265', 'x264', 'x265', 'h264', 'h265', 'hevc', 'av1', 'xvid', 'divx',
  '10bit', 'hdr10', 'hdr', 'dv', 'mvc', 'sbs', 'tab', 'hsbs', 'htab',
  // audio (combined forms first)
  'ddp5\\s*\\.?\\s*1', 'ddp2\\s*\\.?\\s*0', 'aac2\\s*\\.?\\s*0', 'aac\\s*2\\s*\\.?\\s*0',
  '5\\s*\\.?\\s*1', '7\\s*\\.?\\s*1',
  'ac3', 'dts', 'aac', 'ddp5', 'ddp2', 'ddp', 'atmos', 'truehd', 'flac', 'ogg', 'dual',
  // sources
  'web[-\\s]?dl', 'webrip', 'web', 'bluray', 'blu\\s*-?ray', 'bdrip', 'brrip', 'hdtv', 'hdtvrip', 'hdrip',
  'dvdrip', 'dvdscr', 'screener', 'dvdscreener', 'cam', 'telesync', 'telecine', 'tc', 'r5', 'bd5', 'remux',
  // streaming services
  'dsnp', 'disney\\+?', 'netflix', 'nf', 'amzn', 'amazon', 'hulu', 'iqiyi', 'tving', 'kcw', 'sbs\\b', 'jtbc',
  'tvn', 'hbo', 'showtime', 'coupang', 'cpng', 'apple',
  'viki', 'wetv', 'viu', 'youku', 'iq', 'mangotv', 'bilibili',
  // annotations
  'complete', 'proper', 'repack', 'rerip', 'retail', 'internal', 'limited', 'multi', 'subs', 'subtitle',
  'subtitles', 'english', 'korean', 'unrated', 'nfofix', 'read\\s*\\.?nfo', 'extended', 'uncut', 'remuxed',
];
const SERIES_FOLDER_NOISE_RX = new RegExp(`\\b(${SERIES_FOLDER_NOISE.join('|')})\\b`, 'gi');

/**
 * "Season 1" / "Season 01" / "S01" (not followed by E) / "Specials" / "Extras"
 * -> season number. Lenient: matches an Sxx marker anywhere in the name, like
 * Jellyfin's SeasonPathParser, so per-season release folders
 * ("Work.Later.Drink.Now.S01.1080p.AMZN...") are detected too.
 */
export function parseSeasonFolder(name: string): number | null {
  const n = name.trim();
  const season = n.match(/^season\s*(\d{1,4})/i);
  if (season) return parseInt(season[1], 10);
  const prefix = n.match(/[sS](\d{1,4})(?!\d|[eE]\d)(?=\.|_|-|\[|\]|\s|$)/);
  if (prefix) return parseInt(prefix[1], 10);
  if (/^(?:specials?|extras?)$/i.test(n)) return 0;
  return null;
}

/**
 * True when a folder directly under the scan root is a pure season folder
 * ("Season 1", "S01", "Specials"). Used to detect a single-series root: a
 * release-style series folder like "A.Shop.for.Killers.S01.1080p..." does NOT
 * count even though it contains "S01".
 */
function isSeriesSeasonRoot(name: string): boolean {
  const n = name.trim();
  return /^(?:season\s*\d{1,4}|s\d{1,4}|specials?|extras?)(?:\s|$)/i.test(n);
}

/**
 * Clean a series folder name into a title + year, Jellyfin-style. Handles
 * "Title (2008)", release-group suffixes ("-APEX"), release metadata noise
 * ("S01.1080p.DSNP.WEB-DL.DDP5.1.H.264"), leading tags ("[SBS]"), and dirs
 * that are oddly named like files ("...-Phanteam.mkv").
 */
export function parseTitleFolder(name: string): { title: string; year: number | null } {
  let s = String(name).trim();
  // Leading bracket tags: "[SBS] The Chaser".
  s = s.replace(/^\s*\[[^\]]*\]\s*/, '');
  // Trailing container extension (some release dirs end in ".mkv").
  s = s.replace(/\.(mkv|mp4|m4v|avi|ts|m2ts|webm)$/i, '');

  // Year (Jellyfin CleanDateTime): 19xx/20xx bounded by separators, not a
  // date and not glued to more letters/digits ("2010s" is not a year). We
  // read the year from the WHOLE name because it often sits after the season
  // marker ("Generation.to.Generation.S01.2026.1080p...").
  let year: number | null = null;
  const ym = s.match(/(?:^|[ _\.\(\)\[\]\-])(?:\(|\[|\{)?(19[0-9]{2}|20[0-9]{2})(?:\)|\]|\})?(?![0-9]+|\W[0-9]{2}\W[0-9]{2}|[a-z])/i);
  if (ym && ym.index != null) {
    year = parseInt(ym[1], 10);
    s = (s.slice(0, ym.index) + ' ' + s.slice(ym.index + ym[0].length)).trim();
  }

  // Jellyfin's SeriesPathParser derives the series name by cutting at the FIRST
  // season marker ("S01" / "Season 1" / "Specials"). Everything after it is
  // release metadata (resolution, source, codec, audio, release group), so we
  // discard it wholesale instead of enumerating every possible token. This is
  // what lets "A.Dream.Within.a.Dream.2025.S01.1080p.VIKI.WEB-DL.AAC2.0.H.264-
  // DUSKLiGHT" reduce to "A Dream Within a Dream".
  const seasonCut = s.match(/(?:^|[.\s_\-(])(?:season\s*\d{1,4}|s\d{1,4}|specials?|extras?)(?![a-z0-9])(?=$|[.\s_\-)\]])/i);
  if (seasonCut && seasonCut.index != null && seasonCut.index > 0) {
    s = s.slice(0, seasonCut.index);
  }

  // Dots/underscores -> spaces (dashes kept so combined tokens like "WEB-DL"
  // still match the noise list), then strip release/source/codec tokens, then
  // dashes -> spaces.
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(SERIES_FOLDER_NOISE_RX, ' ');
  s = s.replace(/[\s\-–—]+/g, ' ');
  s = s.replace(/[\[\(\{].*?[\]\)\}]/g, ' ');
  s = s.replace(/\s+/g, ' ').replace(/[\s\-–—_·+]+$/g, '').replace(/^[\s\-–—_·+]+/g, '').trim();
  return { title: s || name, year };
}

/**
 * Derive the series title/year and the season/episode for one file inside a
 * series scan root. Returns null when the path isn't under the root.
 */
export function parseSeriesPath(path: string, rootPath: string): SeriesPathInfo | null {
  const rel = relativeSegments(path, rootPath);
  if (rel.length === 0) return null;
  const filename = rel[rel.length - 1];

  let seriesName: string;
  let seasonFromPath: number | null = null;
  if (rel.length === 1) {
    // Episode directly inside the scan root -> the root itself is the series.
    seriesName = baseName(rootPath);
  } else if (rel.length === 2) {
    if (isSeriesSeasonRoot(rel[0])) {
      // Root is a single series with Season subfolders.
      seriesName = baseName(rootPath);
      seasonFromPath = parseSeasonFolder(rel[0]);
    } else {
      // <Series>/<flat episode>
      seriesName = rel[0];
    }
  } else {
    // <Series>/Season N/... or <Series>/<subfolder>/...
    seriesName = rel[0];
    const s = parseSeasonFolder(rel[1]);
    if (s != null) seasonFromPath = s;
  }

  const parsed = parseFilename(filename);
  const { title, year } = parseTitleFolder(seriesName);
  const ep = extractEpisodeNumber(filename);
  const season = seasonFromPath ?? parsed.season;
  const episode = parsed.episode ?? ep?.episode ?? null;

  return { title, year, season, episode, resolution: parsed.resolution };
}

function seriesParsedInfo(file: ScannedFile, rootPath: string): ParsedFilename | null {
  const series = parseSeriesPath(file.path, rootPath);
  if (!series) return null;
  return {
    title: series.title,
    year: series.year,
    type: 'show',
    season: series.season,
    episode: series.episode,
    resolution: series.resolution,
  };
}

// ---------------------------------------------------------------------------
// Movie title fallback to the folder name
// ---------------------------------------------------------------------------
// A movie file whose name carries no title information ("disc1.mkv",
// "movie.mkv", "untitled.mkv") says nothing about the film, so the parent
// folder name — which in a per-movie layout IS the title
// ("Pulp Fiction/disc1.mkv") — is used instead, mirroring how Jellyfin names
// folder-based movies. Well-named files are never touched, and the scan root
// itself is considered too ("Add Movies folder" pointed straight at a
// per-movie folder). The fallback runs BEFORE the TMDB lookup so the lookup
// searches the folder-derived title and matches properly.

const GENERIC_MOVIE_NAME_RX =
  /^(?:disc|cd|dvd|part|pt|movie|movies|films?|video|videos?|title|untitled|unknown|file|new|copy|clip|sample|trailer|episode|ep|scene|media|library|downloads?|collection|complete|series|shows?|season|special)(?:\s*[-_.]?\s*\d*)?$/i;

/** True when a name is a generic file/folder label, not a movie title. */
export function isGenericMovieName(name: string): boolean {
  const n = name.trim();
  return /^\d+$/.test(n) || GENERIC_MOVIE_NAME_RX.test(n);
}

function dirnameOf(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(0, i) : '';
}

/**
 * Derive a movie file's parsed identity. Uses the filename (cleaned exactly
 * like Jellyfin); when the filename yields a generic/meaningless title, falls
 * back to the cleaned parent folder name (or the scan root when it looks like
 * a per-movie folder).
 */
export function movieFileInfo(path: string, filename: string, rootPath: string | null): ParsedFilename {
  const parsed: ParsedFilename = { ...parseFilename(filename), type: 'movie', season: null, episode: null };
  if (!isGenericMovieName(parsed.title)) return parsed;

  const candidates = new Set<string>();
  const dir = dirnameOf(path);
  if (dir) candidates.add(dir);
  if (rootPath) candidates.add(rootPath);

  for (const c of candidates) {
    const name = baseName(c);
    if (!name || isGenericMovieName(name)) continue;
    const { title, year } = parseTitleFolder(name);
    if (title) return { ...parsed, title, year };
  }
  return parsed;
}

/**
 * Build a TMDB entry honouring the scan folder's type:
 * - 'show'  -> series title from the folder path (one cached lookup per series).
 * - 'movie' -> every file is treated as a movie regardless of filename hints.
 * - 'mixed'/undefined -> legacy per-file parsing.
 */
export async function buildTmdbEntryForFolder(
  file: ScannedFile,
  folderType: FolderType | undefined,
  rootPath: string | null,
  tmdbToken: string | null,
  signal?: AbortSignal,
): Promise<LocalEntry> {
  let info: ParsedFilename;
  if (folderType === 'show' && rootPath) {
    info = seriesParsedInfo(file, rootPath) ?? parseFilename(file.filename);
  } else if (folderType === 'movie') {
    info = movieFileInfo(file.path, file.filename, rootPath);
  } else {
    info = parseFilename(file.filename);
  }
  return buildTmdbEntry(file, info, tmdbToken, signal);
}

/** Same as buildTmdbEntryForFolder but for NFO sidecar mode. */
export async function buildNfoEntryForFolder(
  file: ScannedFile,
  folderType: FolderType | undefined,
  rootPath: string | null,
  tmdbToken: string | null,
  signal?: AbortSignal,
): Promise<LocalEntry> {
  let info: ParsedFilename;
  if (folderType === 'show' && rootPath) {
    info = seriesParsedInfo(file, rootPath) ?? parseFilename(file.filename);
  } else if (folderType === 'movie') {
    info = movieFileInfo(file.path, file.filename, rootPath);
  } else {
    info = parseFilename(file.filename);
  }
  return buildNfoEntry(file, info, tmdbToken, signal);
}

function lowConfidence(parsed: ParsedFilename, tmdb: TmdbLookup): boolean {
  if (!tmdb.tmdbId) return true;
  if (
    parsed.year != null &&
    tmdb.matchedYear != null &&
    Math.abs(parsed.year - tmdb.matchedYear) > 1
  ) {
    return true;
  }
  if (tmdb.matchedTitle) {
    const a = tokenize(parsed.title);
    const b = tokenize(tmdb.matchedTitle);
    if (a.length && b.length && !a.some((w) => b.includes(w))) return true;
  }
  return false;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1);
}

interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
}

/** Normalize a title for loose comparison: lowercase, strip accents, and keep
 * CJK characters while turning everything else into single spaces. */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function yearFromDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/**
 * TMDB search ranks by popularity, not relevance, so `results[0]` is often a
 * more-famous show that merely shares a word. Prefer an exact title match,
 * then a year match; otherwise keep TMDB's original ordering.
 */
function pickBestTmdbResult(results: TmdbSearchResult[], queryTitle: string, year: number | null): TmdbSearchResult | null {
  if (!results.length) return null;
  const q = normalizeForMatch(queryTitle);
  const qTokens = q ? q.split(' ').filter(Boolean) : [];
  let best: TmdbSearchResult | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = normalizeForMatch(String(r.title ?? r.name ?? ''));
    const nameTokens = name ? name.split(' ').filter(Boolean) : [];
    let score = 0;
    if (q && name === q) {
      score += 100;
    } else if (qTokens.length && nameTokens.length && qTokens.every((t) => nameTokens.includes(t))) {
      score += 40;
    }
    const rYear = yearFromDate(r.release_date ?? r.first_air_date);
    if (year != null && rYear != null) {
      if (rYear === year) score += 20;
      else if (Math.abs(rYear - year) === 1) score += 5;
    }
    score -= i * 0.001; // tiebreak toward earlier (more popular) results
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

function getTmdbHeadersAndParams(token: string): { headers: Record<string, string>; queryParam?: { key: string; value: string } } {
  const isBearer = token.length > 40 && token.includes('.');
  if (isBearer) {
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
  }
  return {
    headers: {
      'Content-Type': 'application/json',
    },
    queryParam: { key: 'api_key', value: token },
  };
}

export async function tmdbLookup(
  token: string,
  title: string,
  year: number | null,
  type: 'movie' | 'show',
  signal?: AbortSignal,
): Promise<TmdbLookup> {
  const path = type === 'movie' ? 'movie' : 'tv';
  const { headers, queryParam } = getTmdbHeadersAndParams(token);

  const search = async (queryTitle: string, y: number | null): Promise<TmdbSearchResult[]> => {
    const params = new URLSearchParams({ query: queryTitle, include_adult: 'false' });
    if (queryParam) params.set(queryParam.key, queryParam.value);
    if (y && type === 'movie') params.set('year', String(y));
    if (y && type === 'show') params.set('first_air_date_year', String(y));
    const r = await rateLimitedFetch(`https://api.themoviedb.org/3/search/${path}?${params}`, { headers, signal });
    if (!r.ok) return [];
    const json = await r.json();
    return Array.isArray(json.results) ? json.results : [];
  };

  let results = await search(title, year);
  // A slightly-off folder year makes TMDB's strict first_air_date_year filter
  // return nothing (common for dramas where the rip year differs from the
  // first-air year). Retry without the year so the show still matches.
  if (results.length === 0 && year) {
    results = await search(title, null);
  }

  const top = pickBestTmdbResult(results, title, year) ?? results[0];
  if (!top) return {};

  let imdbId: string | undefined;
  let rating: number | undefined;
  let runtime: number | undefined;
  let backdrop: string | undefined;

  if (top.backdrop_path) {
    backdrop = `https://image.tmdb.org/t/p/w1280${top.backdrop_path}`;
  }

  try {
    const dparams = new URLSearchParams({ append_to_response: 'external_ids' });
    if (queryParam) dparams.set(queryParam.key, queryParam.value);
    const dr = await rateLimitedFetch(`https://api.themoviedb.org/3/${path}/${top.id}?${dparams}`, { headers, signal });
    if (dr.ok) {
      const dj = await dr.json();
      const imdb = dj.imdb_id ?? dj.external_ids?.imdb_id;
      if (typeof imdb === 'string' && imdb.startsWith('tt')) imdbId = imdb;
      if (typeof dj.vote_average === 'number' && dj.vote_average > 0) rating = dj.vote_average;
      if (type === 'movie' && typeof dj.runtime === 'number' && dj.runtime > 0) runtime = dj.runtime;
      if (type === 'show' && Array.isArray(dj.episode_run_time) && dj.episode_run_time[0] > 0) {
        runtime = dj.episode_run_time[0];
      }
      if (dj.backdrop_path) {
        backdrop = `https://image.tmdb.org/t/p/w1280${dj.backdrop_path}`;
      }
    }
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    /* noop */
  }

  if (rating == null && typeof top.vote_average === 'number' && top.vote_average > 0) {
    rating = top.vote_average;
  }
  const date: string | undefined = top.release_date ?? top.first_air_date;

  return {
    tmdbId: top.id,
    imdbId,
    poster: top.poster_path ? `https://image.tmdb.org/t/p/w342${top.poster_path}` : undefined,
    backdrop,
    matchedTitle: top.title ?? top.name,
    matchedYear: date ? parseInt(date.slice(0, 4), 10) : null,
    overview: top.overview ?? undefined,
    rating,
    runtime,
  };
}
