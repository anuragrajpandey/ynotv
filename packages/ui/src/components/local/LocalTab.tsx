import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { VirtuosoGrid } from 'react-virtuoso';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { IdentifyResolution, LocalEntry, LocalGroup, LocalSortKey, ScannedFile, SortDir } from '../../services/local-library/types';
import {
  addLocalEntries,
  groupLocal,
  parseFilename,
  readLocalLibrary,
  readScannedFolders,
  extractEpisodeNumber,
  removeLocalEntries,
  sortGroups,
  updateLocalEntries,
  useLocalLibrary,
  localEntryToVodPlayInfo,
  addScannedFolder,
  ensureLocalLibraryLoaded,
  persistLocalEntryIncremental,
} from '../../services/local-library/local-library';
import { countNfoFor, clearSidecarCache } from '../../services/local-library/sidecars';
import { buildNfoEntry, buildTmdbEntry } from '../../services/local-library/scan';
import {
  readScanStateSync,
  loadScanState,
  writeScanState,
  clearScanState,
  loadScanFiles,
  writeScanFiles,
  clearScanFiles,
} from '../../services/local-library/scan-state';
import { markLocalMovieWatched, markLocalEpisodeWatched } from '../../services/local-library/local-watch';
import { useActiveTmdbToken } from '../../hooks/useTmdbLists';
import { PosterSizeSlider } from '../PosterSizeSlider';
import { useAutoLocalSync } from '../../services/local-library/auto-sync';
import { LocalMovieCard } from './LocalMovieCard';
import { LocalShowGroupCard } from './LocalShowGroupCard';
import { LocalEpisodesModal } from './LocalEpisodesModal';
import { LocalDetail } from './LocalDetail';
import { LocalFoldersModal } from './LocalFoldersModal';
import { IdentifyModal } from './IdentifyModal';
import { BatchMatchModal } from './BatchMatchModal';
import { ScanModeModal, type ScanMode } from './ScanModeModal';
import type { VodPlayInfo } from '../../types/media';
import './LocalTab.css';

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Block a scan worker while the scan is paused. In-flight TMDB lookups are
// allowed to finish; each worker then waits here before pulling the next file,
// so no new requests start until the user resumes. Resolves immediately on
// abort so Stop works even while paused.
function waitWhilePaused(pausedRef: { current: boolean }, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!pausedRef.current || signal.aborted) return resolve();
    const id = setInterval(() => {
      if (!pausedRef.current || signal.aborted) {
        clearInterval(id);
        resolve();
      }
    }, 150);
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(id);
        resolve();
      },
      { once: true },
    );
  });
}

interface QueuedScanJob {
  id: number;
  run: () => Promise<void>;
  cancelled: boolean;
  settled: () => void;
}

interface LocalGridContext {
  selectMode: boolean;
  selectedIds: Set<string>;
  handleToggleSelectId: (id: string) => void;
  handleToggleSelectGroup: (ids: string[]) => void;
  handlePlayEntry: (entry: LocalEntry, seriesGroup?: { key: string; head: LocalEntry }) => void;
  handleOpenDetail: (g: LocalGroup) => void;
  openIdentify: (target: LocalEntry[]) => void;
  openEpisodes: (target: { head: LocalEntry; episodes: LocalEntry[] }) => void;
}

// Stable item renderer for the virtualized grid (defined outside render so
// Virtuoso only mounts items that are actually on screen — at 50k+ entries the
// DOM stays tiny and tab switches stay instant).
const LocalGridItem = (
  _index: number,
  g: LocalGroup,
  context?: LocalGridContext,
) => {
  if (!g || !context) return null;
  if (g.kind === 'movie') {
    return (
      <LocalMovieCard
        entry={g.entry}
        selectMode={context.selectMode}
        isSelected={context.selectedIds.has(g.entry.id)}
        onToggleSelect={context.handleToggleSelectId}
        onPlay={context.handlePlayEntry}
        onOpenDetail={() => context.handleOpenDetail(g)}
        onFixMatch={(entry) => context.openIdentify([entry])}
      />
    );
  }
  return (
    <LocalShowGroupCard
      head={g.head}
      episodes={g.episodes}
      selectMode={context.selectMode}
      isSelected={g.episodes.every((e) => context.selectedIds.has(e.id))}
      onToggleSelect={context.handleToggleSelectGroup}
      onOpenEpisodes={(head, episodes) => context.openEpisodes({ head, episodes })}
      onOpenDetail={() => context.handleOpenDetail(g)}
      onFixMatch={(episodes) => context.openIdentify(episodes)}
    />
  );
};

interface LocalTabProps {
  initialFilter?: 'all' | 'movies' | 'series';
  lockFilter?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onPlayVod?: (info: VodPlayInfo) => void;
  onOpenDetail?: (item: any) => void;
}

export function LocalTab({
  initialFilter = 'all',
  lockFilter = false,
  searchQuery: searchQueryProp,
  onSearchChange,
  onPlayVod,
  onOpenDetail,
}: LocalTabProps) {
  const { t } = useTranslation('vod');
  const items = useLocalLibrary();
  const tmdbToken = useActiveTmdbToken();

  const [activeFilter, setActiveFilter] = useState<'all' | 'movies' | 'series'>(initialFilter);
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const searchQuery = searchQueryProp !== undefined ? searchQueryProp : internalSearchQuery;
  const handleSearchChange = useCallback((query: string) => {
    setInternalSearchQuery(query);
    onSearchChange?.(query);
  }, [onSearchChange]);
  const [sortKey, setSortKey] = useState<LocalSortKey>('added');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Poster Size state (persisted)
  const [posterSize, setPosterSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('localPosterSize');
      const num = saved ? parseInt(saved, 10) : NaN;
      return Number.isFinite(num) && num >= 100 && num <= 300 ? num : 170;
    } catch {
      return 170;
    }
  });

  const handlePosterSizeChange = useCallback((newSize: number) => {
    setPosterSize(newSize);
    try {
      localStorage.setItem('localPosterSize', String(newSize));
    } catch {
      /* ignore */
    }
  }, []);

  // Fixed item geometry for the virtualized grid: poster (aspect 2/3) + gap +
  // title + subtitle line. Virtuoso needs this to size rows and total height.
  const itemHeight = useMemo(() => Math.round(posterSize * 1.5) + 44, [posterSize]);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [walking, setWalking] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null);
  const [rateEta, setRateEta] = useState<{ rate: number; eta: number } | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [interruptedScan, setInterruptedScan] = useState<{ folderPath: string; current: number; total: number } | null>(null);
  const [rescanningMissing, setRescanningMissing] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  // Serial scan queue: TMDB-heavy scans run one at a time so a second folder
  // added mid-scan waits instead of fighting the shared rate limit. Jobs can
  // be cancelled while still waiting (before they start).
  const scanQueueRef = useRef<QueuedScanJob[]>([]);
  const queueRunningRef = useRef(false);
  const nextScanJobIdRef = useRef(1);
  // Live rate/ETA bookkeeping (refs so the 500ms overlay tick can read them).
  const scanStartRef = useRef(0);
  const sessionDoneRef = useRef(0);
  const baseDoneRef = useRef(0);
  const totalRef = useRef(0);
  const [pendingScanFiles, setPendingScanFiles] = useState<ScannedFile[] | null>(null);
  const [pendingNfoCount, setPendingNfoCount] = useState<number>(0);
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [foldersModalOpen, setFoldersModalOpen] = useState(false);

  // Modals / Details state
  const [identifyTarget, setIdentifyTarget] = useState<LocalEntry[] | null>(null);
  const [batchMatchTargets, setBatchMatchTargets] = useState<LocalEntry[] | null>(null);
  const [episodesModalTarget, setEpisodesModalTarget] = useState<{ head: LocalEntry; episodes: LocalEntry[] } | null>(null);
  const [selectedDetailGroup, setSelectedDetailGroup] = useState<LocalGroup | null>(null);

  // Toast
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  // Background folder sync on mount / interval
  useAutoLocalSync(
    tmdbToken,
    useCallback(
      (res: { added: number; removed: number }) => {
        if (res.added > 0 && res.removed > 0) {
          showToast(t('syncResult', { added: res.added, removed: res.removed }));
        } else if (res.added > 0) {
          showToast(t('addedNewItems', { count: res.added }));
        } else if (res.removed > 0) {
          showToast(t('cleanedMissingItems', { count: res.removed }));
        }
      },
      [showToast, t],
    ),
  );

  // Offer to resume a scan that was interrupted by an app restart. Progress is
  // persisted to SQLite (scan-state.ts); entries already scanned are in the
  // library (persisted incrementally), so a resume only processes the rest.
  useEffect(() => {
    void (async () => {
      try {
        await ensureLocalLibraryLoaded();
        const state = await loadScanState();
        if (!state || !state.folderPath) return;
        if (state.status === 'completed') {
          clearScanState();
          return;
        }
        const folders = readScannedFolders();
        const stillTracked = folders.some(
          (f) => f.replace(/\\/g, '/').toLowerCase() === state.folderPath.replace(/\\/g, '/').toLowerCase(),
        );
        if (!stillTracked) {
          clearScanState();
          return;
        }
        setInterruptedScan({ folderPath: state.folderPath, current: state.current, total: state.total });
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Group items into movies & series
  const groups = useMemo(() => groupLocal(items), [items]);

  // Counts
  const movieCount = useMemo(() => groups.filter((g) => g.kind === 'movie').length, [groups]);
  const seriesCount = useMemo(() => groups.filter((g) => g.kind === 'show').length, [groups]);
  const needsReviewList = useMemo(() => items.filter((e) => e.needsReview), [items]);

  // Keep selected detail group fresh if underlying items update
  const currentDetailGroup = useMemo(() => {
    if (!selectedDetailGroup) return null;
    if (selectedDetailGroup.kind === 'movie') {
      const match = items.find((i) => i.id === selectedDetailGroup.entry.id);
      return match ? { kind: 'movie' as const, entry: match } : null;
    }
    const matchGroup = groups.find((g) => g.kind === 'show' && g.key === selectedDetailGroup.key);
    return matchGroup ?? null;
  }, [selectedDetailGroup, items, groups]);

  // Filter & Sort
  const filteredGroups = useMemo(() => {
    const effFilter = lockFilter ? initialFilter : activeFilter;
    let list = groups;

    if (effFilter === 'movies') {
      list = list.filter((g) => g.kind === 'movie');
    } else if (effFilter === 'series') {
      list = list.filter((g) => g.kind === 'show');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((g) => {
        const title = (g.kind === 'movie' ? g.entry.title : g.head.title) || '';
        return title.toLowerCase().includes(q);
      });
    }

    return sortGroups(list, sortKey, sortDir);
  }, [groups, lockFilter, initialFilter, activeFilter, searchQuery, sortKey, sortDir]);

  // Play handler
  const handlePlayEntry = useCallback((entry: LocalEntry, seriesGroup?: { key: string; head: LocalEntry }) => {
    const playInfo = localEntryToVodPlayInfo(entry, seriesGroup);
    if (onPlayVod) {
      onPlayVod(playInfo);
    } else {
      // Dispatch global playback event
      window.dispatchEvent(new CustomEvent('ynotv:stremio-play', { detail: playInfo }));
    }
  }, [onPlayVod]);

  // Detail handler: cross-link matched items to an external detail view when provided
  const handleOpenDetail = useCallback((group: LocalGroup) => {
    const entry = group.kind === 'movie' ? group.entry : group.head;
    if (onOpenDetail && (entry.tmdbId != null || entry.imdbId != null)) {
      onOpenDetail(entry);
    } else {
      setSelectedDetailGroup(group);
    }
  }, [onOpenDetail]);

  // Folder picking & scan initiation
  const handleAddFolder = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('selectFolderDialogTitle', 'Select Folder with Movies or Shows'),
      });
      if (!selected || typeof selected !== 'string') return;

      setWalking(true);
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: selected });

      if (!files || files.length === 0) {
        setWalking(false);
        showToast(t('noVideoFilesFound'));
        return;
      }

      addScannedFolder(selected);
      setPendingFolderPath(selected);

      const nfos = await countNfoFor(files.map((f) => f.path));
      if (nfos > 0) {
        setPendingScanFiles(files);
        setPendingNfoCount(nfos);
        setScanModalOpen(true);
        setWalking(false);
      } else {
        await executeScan(files, 'tmdb', { folderPath: selected });
      }
    } catch (err: any) {
      console.error('[LocalTab] Folder scan failed:', err);
      setWalking(false);
      showToast(err?.message || t('folderScanFailed'));
    }
  }, [showToast, t]);

  const handleRescanSpecificFolder = useCallback(async (folderPath: string) => {
    try {
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: folderPath });
      if (!files || files.length === 0) {
        showToast(t('noVideoFilesFound'));
        return;
      }
      addScannedFolder(folderPath);
      await executeScan(files, 'tmdb', { folderPath });
    } catch (err: any) {
      console.error('[LocalTab] Rescan failed:', err);
      showToast(err?.message || t('rescanFailed'));
    }
  }, [showToast, t]);

  // TMDB lookups are global rate-limited (~40 req/s, services/tmdbRateLimit.ts),
  // so scanning with a small worker pool saturates the limit without tripping
  // 429s — far faster than the old one-at-a-time loop.
  const SCAN_CONCURRENCY = 12;

  // Serialize TMDB-heavy scans: folder scans and rescan-missing share one queue
  // so a second folder added mid-scan waits for the first instead of running
  // two concurrent scans that fight over the global TMDB rate limit. The drain
  // loop skips jobs that were cancelled while waiting.
  const drainQueue = useCallback(async () => {
    if (queueRunningRef.current) return;
    queueRunningRef.current = true;
    try {
      for (;;) {
        const head = scanQueueRef.current[0];
        if (!head) break;
        if (head.cancelled) {
          scanQueueRef.current.shift();
          setQueuedCount(scanQueueRef.current.length);
          continue;
        }
        setQueuedCount(scanQueueRef.current.length);
        try {
          await head.run();
        } catch {
          /* run() implementations handle their own errors */
        }
        head.settled();
        scanQueueRef.current.shift();
        setQueuedCount(scanQueueRef.current.length);
      }
    } finally {
      queueRunningRef.current = false;
    }
  }, []);

  const enqueueScan = useCallback((run: () => Promise<void>): Promise<void> => {
    return new Promise<void>((resolve) => {
      const job: QueuedScanJob = {
        id: nextScanJobIdRef.current++,
        run,
        cancelled: false,
        settled: resolve,
      };
      scanQueueRef.current.push(job);
      setQueuedCount(scanQueueRef.current.length);
      void drainQueue();
    });
  }, [drainQueue]);

  // Drop every scan still waiting in the queue (the one actively running keeps
  // its own Cancel button). Settles their promises so callers don't hang.
  const cancelQueuedScans = useCallback(() => {
    for (const job of scanQueueRef.current) {
      if (job.cancelled) continue;
      job.cancelled = true;
      job.settled();
    }
    setQueuedCount(scanQueueRef.current.filter((j) => !j.cancelled).length);
  }, []);

  // Live items/sec + ETA readout. Workers only bump the counters; a 500ms
  // interval recomputes the rate from elapsed time so the ETA keeps moving
  // even while individual lookups are slow (e.g. rate-limit backoff).
  useEffect(() => {
    if (!scanning && !rescanningMissing) return;
    const update = () => {
      const elapsed = (Date.now() - scanStartRef.current) / 1000;
      const done = sessionDoneRef.current;
      const rate = elapsed > 1 ? done / elapsed : 0;
      const remaining = Math.max(0, totalRef.current - (baseDoneRef.current + done));
      setRateEta(rate > 0 && remaining > 0 ? { rate, eta: remaining / rate } : null);
    };
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [scanning, rescanningMissing]);

  const runScan = async (
    files: ScannedFile[],
    mode: ScanMode,
    folderPath: string | null,
    total = files.length,
    baseDone = 0,
  ) => {
    setScanning(true);
    setInterruptedScan(null);
    pausedRef.current = false;
    setPaused(false);
    await ensureLocalLibraryLoaded();
    totalRef.current = total;
    baseDoneRef.current = baseDone;
    sessionDoneRef.current = 0;
    scanStartRef.current = Date.now();
    setScanProgress({ current: baseDone, total });
    setRateEta(null);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const { signal } = controller;
    const parsed = files.map((f) => ({ file: f, info: parseFilename(f.filename) }));

    // Persist progress so a restart can resume this scan (entries completed so
    // far are already persisted row-by-row; only the counters were lost).
    let lastPersist = Date.now();
    const persistTick = (done: number) => {
      if (!folderPath) return;
      const now = Date.now();
      if (done % 100 === 0 || now - lastPersist > 2000) {
        lastPersist = now;
        writeScanState({ folderPath, current: baseDone + done, total, status: 'scanning', updatedAt: now });
      }
    };
    if (folderPath) {
      writeScanState({ folderPath, current: baseDone, total, status: 'scanning', updatedAt: Date.now() });
      // Per-file checkpoint: the full path list, persisted once. A resume uses
      // this to compute remaining files without re-walking the whole folder.
      writeScanFiles(files.map((f) => f.path));
    }

    const built: LocalEntry[] = new Array(parsed.length);
    let done = 0;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(SCAN_CONCURRENCY, parsed.length) },
      async () => {
        for (;;) {
          if (signal.aborted) return;
          await waitWhilePaused(pausedRef, signal);
          if (signal.aborted) return;
          const idx = next++;
          if (idx >= parsed.length) return;
          const { file, info } = parsed[idx];
          try {
            const entry =
              mode === 'nfo'
                ? await buildNfoEntry(file, info, tmdbToken, signal)
                : await buildTmdbEntry(file, info, tmdbToken, signal);
            if (signal.aborted) return;
            built[idx] = entry;
            // Crash-safe checkpoint: persist each completed entry to SQLite as
            // it finishes so a mid-scan restart only re-scans in-flight files.
            persistLocalEntryIncremental(entry);
          } catch (e: unknown) {
            // Aborting mid-scan: drop the in-flight file so only fully
            // scanned entries are kept.
            if (e instanceof DOMException && e.name === 'AbortError') return;
            built[idx] = {
              id: file.path,
              path: file.path,
              filename: file.filename,
              title: info.title,
              year: info.year,
              type: info.type,
              resolution: info.resolution,
              addedAt: Date.now(),
              needsReview: true,
            };
          }
          done += 1;
          sessionDoneRef.current = done;
          setScanProgress({ current: baseDone + done, total });
          persistTick(done);
        }
      },
    );
    await Promise.all(workers);
    if (scanAbortRef.current === controller) scanAbortRef.current = null;
    pausedRef.current = false;
    setPaused(false);

    // Keep whatever finished before the cancel — already-scanned entries stay.
    addLocalEntries(built.filter((e): e is LocalEntry => !!e));
    if (signal.aborted) {
      if (folderPath) {
        writeScanState({ folderPath, current: baseDone + done, total, status: 'cancelled', updatedAt: Date.now() });
        setInterruptedScan({ folderPath, current: baseDone + done, total });
      }
    } else {
      clearScanState();
      clearScanFiles();
    }
    setScanning(false);
    setScanProgress(null);
    setRateEta(null);
    setPendingScanFiles(null);
    setPendingFolderPath(null);
    showToast(
      signal.aborted
        ? t('scanCancelled', 'Scan cancelled. Already scanned items were kept.')
        : t('addedItemsToLibrary', { count: built.length }),
    );
  };

  const executeScan = (
    files: ScannedFile[],
    mode: ScanMode,
    opts?: { folderPath?: string | null; total?: number; baseDone?: number },
  ): Promise<void> =>
    enqueueScan(() =>
      runScan(files, mode, opts?.folderPath ?? null, opts?.total ?? files.length, opts?.baseDone ?? 0),
    );

  // Re-run TMDB matching only for entries that are still ambiguous/unmatched,
  // without re-scanning the disk or re-touching already-matched titles.
  const runRescanMissing = async (missing: LocalEntry[]) => {
    setRescanningMissing(true);
    setInterruptedScan(null);
    pausedRef.current = false;
    setPaused(false);
    const total = missing.length;
    totalRef.current = total;
    baseDoneRef.current = 0;
    sessionDoneRef.current = 0;
    scanStartRef.current = Date.now();
    setScanProgress({ current: 0, total });
    setRateEta(null);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    const { signal } = controller;

    const freshById = new Map<string, LocalEntry>();
    let done = 0;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(SCAN_CONCURRENCY, missing.length) },
      async () => {
        for (;;) {
          if (signal.aborted) return;
          await waitWhilePaused(pausedRef, signal);
          if (signal.aborted) return;
          const idx = next++;
          if (idx >= missing.length) return;
          const e = missing[idx];
          const info = parseFilename(e.filename);
          try {
            const fresh = await buildTmdbEntry(
              { path: e.path, filename: e.filename, size: 0 },
              info,
              tmdbToken,
              signal,
            );
            if (signal.aborted) return;
            freshById.set(e.id, { ...e, ...fresh, id: e.id, path: e.path, addedAt: e.addedAt });
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            freshById.set(e.id, e);
          }
          done += 1;
          sessionDoneRef.current = done;
          setScanProgress({ current: done, total });
        }
      },
    );
    await Promise.all(workers);
    if (scanAbortRef.current === controller) scanAbortRef.current = null;
    pausedRef.current = false;
    setPaused(false);

    // Apply whatever completed before the cancel.
    updateLocalEntries(Array.from(freshById.keys()), (entry) => freshById.get(entry.id) ?? {});
    setRescanningMissing(false);
    setScanProgress(null);
    setRateEta(null);
    showToast(
      signal.aborted
        ? t('scanCancelled', 'Scan cancelled. Already scanned items were kept.')
        : t('rescannedMetadata', 'Rescanned metadata for {{count}} titles.', { count: freshById.size }),
    );
  };

  const handleRescanMissing = useCallback(() => {
    const missing = items.filter((e) => e.needsReview || (!e.tmdbId && !e.imdbId));
    if (missing.length === 0) {
      showToast(t('noMissingMetadata', 'All titles already have metadata.'));
      return;
    }
    if (!tmdbToken) {
      showToast(
        t('rescanNeedsTmdb', 'Rescanning missing metadata requires a TMDB API key (Settings → TMDB).'),
      );
      return;
    }
    void enqueueScan(() => runRescanMissing(missing));
  }, [items, tmdbToken, showToast, t, enqueueScan]);

  const handleCancelScan = useCallback(() => {
    scanAbortRef.current?.abort();
  }, []);

  // Pause / resume the active scan. Pausing only gates the worker loops (no
  // new TMDB requests); in-flight lookups finish first.
  const handleTogglePause = useCallback(() => {
    if (!scanAbortRef.current) return;
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }, []);

  // Resume an interrupted/cancelled scan: use the persisted per-file checkpoint
  // when available (no folder re-walk), skip every file already in the library
  // (entries were persisted incrementally), and continue the progress counters
  // from where the previous run stopped. Falls back to re-walking the folder
  // only for legacy state that predates the checkpoint.
  const handleResumeScan = useCallback(async () => {
    const target = interruptedScan;
    if (!target) return;
    setInterruptedScan(null);
    try {
      clearSidecarCache();
      await ensureLocalLibraryLoaded();
      const existing = new Set(readLocalLibrary().map((e) => e.path.toLowerCase()));
      const persistedPaths = await loadScanFiles();

      let files: ScannedFile[] | null = null;
      let total = target.total;
      if (persistedPaths && persistedPaths.length > 0) {
        // Checkpoint from the interrupted run: no folder re-walk needed. The
        // filename is derivable from the path (parseFilename needs the basename).
        files = persistedPaths
          .filter((p) => !existing.has(p.toLowerCase()))
          .map((p) => ({ path: p, filename: p.split(/[\\/]/).pop() || p, size: 0 }));
      } else {
        const walked = await invoke<ScannedFile[]>('scan_local_folder', { folder: target.folderPath });
        if (Array.isArray(walked) && walked.length > 0) {
          files = walked.filter((f) => !existing.has(f.path.toLowerCase()));
          total = walked.length;
        }
      }

      if (!files || files.length === 0) {
        clearScanState();
        clearScanFiles();
        return;
      }
      addScannedFolder(target.folderPath);
      await executeScan(files, 'tmdb', {
        folderPath: target.folderPath,
        total,
        baseDone: total - files.length,
      });
    } catch (err: any) {
      console.error('[LocalTab] Resume scan failed:', err);
      showToast(err?.message || t('folderScanFailed'));
    }
  }, [interruptedScan, showToast, t]);

  const handleDismissInterrupted = useCallback(() => {
    clearScanState();
    setInterruptedScan(null);
  }, []);

  const handleScanModePick = (mode: ScanMode) => {
    setScanModalOpen(false);
    if (pendingScanFiles) {
      void executeScan(pendingScanFiles, mode, { folderPath: pendingFolderPath });
    }
  };

  // Identify resolution
  const handleIdentifyResolved = useCallback((ids: string[], resolution: IdentifyResolution) => {
    updateLocalEntries(ids, (entry) => {
      const epInfo = extractEpisodeNumber(entry.filename);
      const epNum = entry.episode ?? epInfo?.episode ?? null;
      const seasonNum = entry.season ?? epInfo?.season ?? 1;

      return {
        tmdbId: resolution.tmdbId,
        imdbId: resolution.imdbId,
        poster: resolution.poster,
        backdrop: resolution.backdrop,
        title: resolution.title,
        year: resolution.year,
        type: resolution.type,
        overview: resolution.overview ?? null,
        rating: resolution.rating ?? null,
        runtime: resolution.runtime ?? null,
        season: resolution.type === 'show' ? seasonNum : null,
        episode: resolution.type === 'show' ? epNum : null,
        needsReview: false,
      };
    });
    setSelectedIds(new Set());
    setSelectMode(false);
    showToast(
      ids.length > 1
        ? t('matchedFilesAs', { count: ids.length, title: resolution.title })
        : t('matchUpdated')
    );
  }, [showToast, t]);

  // Selection handlers
  const handleToggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleSelectGroup = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(items.map((i) => i.id)));
  }, [items]);

  const handleInvertSelect = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const it of items) {
        if (!prev.has(it.id)) next.add(it.id);
      }
      return next;
    });
  }, [items]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    removeLocalEntries(Array.from(selectedIds));
    setSelectedIds(new Set());
    setSelectMode(false);
    showToast(t('removedSelectedItems'));
  }, [selectedIds, showToast, t]);

  const handleBulkMarkWatched = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const selectedItems = items.filter((i) => selectedIds.has(i.id));
    for (const item of selectedItems) {
      if (item.type === 'movie') {
        await markLocalMovieWatched(item, true);
      } else {
        await markLocalEpisodeWatched(item, item.title, true);
      }
    }
    showToast(t('markedItemsWatched', { count: selectedItems.length }));
  }, [selectedIds, items, showToast, t]);

  // Memoized context for the virtualized grid — only the visible items
  // re-render when this changes (selection, handlers), not the whole list.
  const gridContext = useMemo<LocalGridContext>(
    () => ({
      selectMode,
      selectedIds,
      handleToggleSelectId,
      handleToggleSelectGroup,
      handlePlayEntry,
      handleOpenDetail,
      openIdentify: setIdentifyTarget,
      openEpisodes: setEpisodesModalTarget,
    }),
    [selectMode, selectedIds, handleToggleSelectId, handleToggleSelectGroup, handlePlayEntry, handleOpenDetail],
  );

  return (
    <div className="local-tab-container">
      {/* Top Toolbar */}
      <div className="local-toolbar">
        <div className="local-toolbar__left">
          {!lockFilter && (
            <div className="local-type-pills">
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                {t('all', 'All')}
                <span className="local-type-pill__count">{items.length}</span>
              </button>
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'movies' ? 'active' : ''}`}
                onClick={() => setActiveFilter('movies')}
              >
                {t('movies', 'Movies')}
                <span className="local-type-pill__count">{movieCount}</span>
              </button>
              <button
                type="button"
                className={`local-type-pill ${activeFilter === 'series' ? 'active' : ''}`}
                onClick={() => setActiveFilter('series')}
              >
                {t('series', 'Series')}
                <span className="local-type-pill__count">{seriesCount}</span>
              </button>
            </div>
          )}

          {/* Search Box */}
          <div className="local-toolbar__search-wrap">
            <span className="local-toolbar__search-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('searchPlaceholder', 'Search local media...')}
              className="local-toolbar__search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="local-toolbar__search-clear"
                onClick={() => handleSearchChange('')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="local-toolbar__right">
          {/* Sort Dropdown */}
          <select
            className="local-select-dropdown"
            value={`${sortKey}_${sortDir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split('_') as [LocalSortKey, SortDir];
              setSortKey(key);
              setSortDir(dir);
            }}
          >
            <option value="added_desc">{t('recentlyAdded', 'Recently Added')}</option>
            <option value="name_asc">{t('nameAZ', 'Name (A-Z)')}</option>
            <option value="name_desc">{t('nameZA', 'Name (Z-A)')}</option>
            <option value="rating_desc">{t('highestRated', 'Highest Rated')}</option>
            <option value="year_desc">{t('newestFirst', 'Release Year (Newest)')}</option>
            <option value="year_asc">{t('oldestFirst', 'Release Year (Oldest)')}</option>
          </select>

          {/* Poster Size Slider */}
          <PosterSizeSlider value={posterSize} onChange={handlePosterSizeChange} />

          {/* Manage Folders Button */}
          <button
            type="button"
            className="local-btn local-btn--secondary"
            onClick={() => setFoldersModalOpen(true)}
            title={t('manageFolders', 'Manage Folders')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {t('folders', 'Folders')}
          </button>

          {/* Select Mode Toggle */}
          {items.length > 0 && (
            <button
              type="button"
              className={`local-btn ${selectMode ? 'local-btn--active' : 'local-btn--secondary'}`}
              onClick={() => {
                setSelectMode(!selectMode);
                setSelectedIds(new Set());
              }}
            >
              {selectMode ? t('done', 'Done') : t('select', 'Select')}
            </button>
          )}

          {/* Rescan Missing Metadata Button */}
          {items.length > 0 && (
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={() => void handleRescanMissing()}
              disabled={rescanningMissing || scanning}
              title={t('rescanMissingTitle', 'Re-run TMDB matching for titles with missing or ambiguous metadata')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
              {rescanningMissing ? t('scanning', 'Scanning...') : t('rescanMissing', 'Rescan Missing')}
            </button>
          )}

          {/* Add Folder Button */}
          <button
            type="button"
            className="local-btn local-btn--primary"
            onClick={handleAddFolder}
            disabled={walking}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
            {scanning || walking ? t('scanning', 'Scanning...') : t('addFolder', 'Add folder')}
          </button>
        </div>
      </div>

      {/* Needs Review Alert Banner */}
      {needsReviewList.length > 0 && !selectMode && (
        <div className="local-review-banner">
          <div
            className="local-review-banner__left"
            onClick={() => {
              const first = needsReviewList[0];
              const matchingEpisodes = items.filter(
                (i) => i.type === 'show' && i.title === first.title,
              );
              setIdentifyTarget(matchingEpisodes.length > 0 ? matchingEpisodes : [first]);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="local-review-banner__text">
              {t('needsReviewBanner', '{{count}} titles need review — help us identify them.', {
                count: needsReviewList.length,
              })}
            </span>
          </div>

          <div className="local-review-banner__actions">
            {needsReviewList.length > 1 && (
              <button
                type="button"
                className="local-review-banner__btn local-review-banner__btn--batch"
                onClick={(e) => {
                  e.stopPropagation();
                  // Open a checkbox selection first so the user picks exactly
                  // which unmatched files to match into one series, instead of
                  // batching the entire needs-review list.
                  setBatchMatchTargets(needsReviewList);
                }}
                title={t('batchReviewAll', 'Choose which files to batch match into one series')}
              >
                {t('batchReview', 'Batch Match Series')}
              </button>
            )}
            <button
              type="button"
              className="local-review-banner__btn"
              onClick={(e) => {
                e.stopPropagation();
                const first = needsReviewList[0];
                const matchingEpisodes = items.filter(
                  (i) => i.type === 'show' && i.title === first.title,
                );
                setIdentifyTarget(matchingEpisodes.length > 0 ? matchingEpisodes : [first]);
              }}
            >
              {t('review', 'Review')}
            </button>
          </div>
        </div>
      )}

      {/* Bulk Action Bar during Select Mode */}
      {selectMode && (
        <div className="local-bulk-bar">
          <span className="local-bulk-bar__count">
            {selectedIds.size} {t('selected', 'selected')}
          </span>
          <div className="local-bulk-bar__actions">
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={handleSelectAll}
            >
              {t('selectAll', 'Select all')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={handleInvertSelect}
            >
              {t('invertSelection', 'Invert')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--primary"
              disabled={selectedIds.size === 0}
              onClick={() => {
                const selectedItems = items.filter((i) => selectedIds.has(i.id));
                if (selectedItems.length > 0) {
                  setIdentifyTarget(selectedItems);
                }
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: '5px' }}>
                <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
              </svg>
              {selectedIds.size > 1 ? t('matchAsSeries', 'Match as Series') : t('identify', 'Identify')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={handleBulkMarkWatched}
              disabled={selectedIds.size === 0}
            >
              {t('markWatched', 'Mark as watched')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              style={{ color: '#ef4444' }}
              onClick={handleBulkDelete}
              disabled={selectedIds.size === 0}
            >
              {t('remove', 'Remove')}
            </button>
            <button
              type="button"
              className="local-btn local-btn--secondary"
              onClick={() => {
                setSelectMode(false);
                setSelectedIds(new Set());
              }}
            >
              {t('done', 'Done')}
            </button>
          </div>
        </div>
      )}

      {/* Interrupted-scan resume banner */}
      {interruptedScan && (
        <div className="local-resume-banner">
          <span className="local-resume-banner__text">
            {t('scanInterruptedBanner', 'Scan interrupted — {{current}} of {{total}} items scanned.', {
              current: interruptedScan.current,
              total: interruptedScan.total,
            })}
          </span>
          <div className="local-resume-banner__actions">
            <button type="button" className="local-btn local-btn--primary" onClick={() => void handleResumeScan()}>
              {t('resumeScan', 'Resume scan')}
            </button>
            <button type="button" className="local-btn local-btn--secondary" onClick={handleDismissInterrupted}>
              {t('dismissScan', 'Dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Scan Progress Alert (folder scan or rescan-missing) */}
      {(scanning || rescanningMissing) && scanProgress && (
        <div className="local-scan-progress">
          <div style={{ flex: 1 }}>
            <div className="local-scan-progress__row">
              <span>
                {paused
                  ? t('scanPaused', 'Scan paused')
                  : rescanningMissing
                    ? t('rescanningMetadataFiles', 'Refreshing metadata...')
                    : t('scanningMediaFiles', 'Scanning media files...')}
              </span>
              <span className="local-scan-progress__stats">
                {scanProgress.current} / {scanProgress.total}
                {!paused && rateEta && (
                  <span className="local-scan-progress__eta">
                    {t('scanEtaRate', '{{rate}} items/s · {{eta}} left', {
                      rate: rateEta.rate.toFixed(1),
                      eta: formatEta(rateEta.eta),
                    })}
                  </span>
                )}
                {queuedCount > 0 && (
                  <span className="local-scan-progress__queued">
                    {t('scanQueuedCount', '{{count}} queued', { count: queuedCount })}
                  </span>
                )}
              </span>
            </div>
            <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(scanProgress.current / scanProgress.total) * 100}%`, background: 'var(--accent-primary, #00d4ff)', transition: 'width 0.2s' }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button
              type="button"
              className="local-btn"
              onClick={handleTogglePause}
              disabled={!scanAbortRef.current}
              style={{ height: '32px', padding: '0 14px', fontSize: '12.5px' }}
            >
              {paused ? t('resumeScan', 'Resume scan') : t('pauseScan', 'Pause')}
            </button>
            <button
              type="button"
              className="local-btn"
              onClick={handleCancelScan}
              disabled={!scanAbortRef.current}
              style={{ height: '32px', padding: '0 14px', fontSize: '12.5px' }}
            >
              {t('stopScan', 'Stop')}
            </button>
          </div>
        </div>
      )}

      {/* Waiting for a queued scan (added a folder while another scan runs) */}
      {queuedCount > 0 && !scanning && !rescanningMissing && (
        <div className="local-scan-waiting">
          <span className="local-scan-waiting__spinner" />
          <span>
            {t('scanWaiting', 'Waiting for the current scan to finish… ({{count}} queued)', { count: queuedCount })}
          </span>
          <button
            type="button"
            className="local-btn local-scan-waiting__cancel"
            onClick={cancelQueuedScans}
            style={{ flexShrink: 0, height: '32px', padding: '0 14px', fontSize: '12.5px' }}
          >
            {t('cancelQueuedScans', 'Cancel queued scans')}
          </button>
        </div>
      )}

      {/* Main Content: Grid or Empty State */}
      {items.length === 0 && !scanning && !walking ? (
        <div className="local-empty-state">
          <div className="local-empty-state__icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </div>
          <h3 className="local-empty-state__title">
            {t('emptyLocalTitle', 'Add files from your computer')}
          </h3>
          <p className="local-empty-state__desc">
            {t('emptyLocalDesc', 'Point ynoTV at a folder. We scan it for movies and shows, parse titles from filenames, and enrich them with TMDB so they look the same as everything else here. We just remember the path; nothing is copied or moved.')}
          </p>
          <button
            type="button"
            className="local-btn local-btn--primary"
            style={{ padding: '0 24px', height: '42px', fontSize: '13.5px' }}
            onClick={handleAddFolder}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {t('chooseFolder', 'Choose folder')}
          </button>
        </div>
      ) : (
        <VirtuosoGrid
          className="local-grid"
          style={
            {
              '--local-poster-size': `${posterSize}px`,
              '--local-item-height': `${itemHeight}px`,
            } as React.CSSProperties
          }
          data={filteredGroups}
          context={gridContext}
          computeItemKey={(_, g) => (g.kind === 'movie' ? g.entry.id : g.key)}
          itemContent={LocalGridItem}
          overscan={150}
          listClassName="local-grid-list"
          itemClassName="local-grid-item"
        />
      )}

      {/* Episodes Picker Modal */}
      {episodesModalTarget && (
        <LocalEpisodesModal
          head={episodesModalTarget.head}
          episodes={episodesModalTarget.episodes}
          onClose={() => setEpisodesModalTarget(null)}
          onPlayEpisode={(ep) => {
            handlePlayEntry(ep, { key: episodesModalTarget.head.title, head: episodesModalTarget.head });
            setEpisodesModalTarget(null);
          }}
        />
      )}

      {/* Batch match file selection modal */}
      {batchMatchTargets && (
        <BatchMatchModal
          items={batchMatchTargets}
          onClose={() => setBatchMatchTargets(null)}
          onConfirm={(selected) => {
            setBatchMatchTargets(null);
            setIdentifyTarget(selected);
          }}
        />
      )}

      {/* Identify / Match Fix Modal */}
      {identifyTarget && (
        <IdentifyModal
          target={identifyTarget}
          onClose={() => setIdentifyTarget(null)}
          onResolved={handleIdentifyResolved}
        />
      )}

      {/* Scan Mode Modal */}
      <ScanModeModal
        isOpen={scanModalOpen}
        nfoCount={pendingNfoCount}
        onPick={handleScanModePick}
        onClose={() => {
          setScanModalOpen(false);
          setPendingScanFiles(null);
          setPendingFolderPath(null);
        }}
      />

      {/* Folders Management Modal */}
      <LocalFoldersModal
        isOpen={foldersModalOpen}
        onClose={() => setFoldersModalOpen(false)}
        onRescanFolder={handleRescanSpecificFolder}
        onAddNewFolder={async () => {
          setFoldersModalOpen(false);
          await handleAddFolder();
        }}
      />

      {/* Full Page Detail View for Selected Item */}
      {currentDetailGroup && (
        <LocalDetail
          group={currentDetailGroup}
          onClose={() => setSelectedDetailGroup(null)}
          onPlay={(entry, seriesGroup) => handlePlayEntry(entry, seriesGroup)}
          onFixMatch={(target) => setIdentifyTarget(target)}
          onRemove={(ids) => {
            removeLocalEntries(ids);
            setSelectedDetailGroup(null);
            showToast(t('itemRemoved'));
          }}
        />
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="local-toast">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
