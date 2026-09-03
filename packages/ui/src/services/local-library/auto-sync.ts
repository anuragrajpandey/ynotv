import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { LibraryFolder, LocalEntry, ScannedFile } from './types';
import {
  readScannedFolders,
  readLocalLibrary,
  addLocalEntries,
  removeLocalEntries,
  ensureLocalLibraryLoaded,
  parseFilename,
} from './local-library';
import { buildTmdbEntryForFolder } from './scan';

const LAST_SYNC_KEY = 'ynotv.local.last_sync_time';
const SYNC_THROTTLE_MS = 3 * 60 * 1000; // 3 minutes throttle between automatic background scans
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000; // auto sync every 15 minutes while app is open

let isSyncing = false;

export async function syncLocalFolders(
  tmdbToken?: string | null,
  force = false,
): Promise<{ added: number; removed: number }> {
  if (isSyncing) return { added: 0, removed: 0 };

  const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
  if (!force && Date.now() - lastSync < SYNC_THROTTLE_MS) {
    return { added: 0, removed: 0 };
  }

  // Ensure the authoritative library/folders are loaded from SQLite before
  // diffing against them, so a boot-time scan never races the migration.
  await ensureLocalLibraryLoaded();

  const folders = readScannedFolders();
  if (folders.length === 0) return { added: 0, removed: 0 };

  isSyncing = true;
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));

  try {
    const currentLibrary = readLocalLibrary();
    const existingPathMap = new Map(currentLibrary.map((e) => [e.path.toLowerCase(), e]));

    // Track which scan root each file came from so series folders can derive
    // the series title from the folder path (one cached TMDB lookup per series).
    const allScanned: Array<{ file: ScannedFile; folder: LibraryFolder }> = [];
    const successfullyScannedFolders = new Set<string>();

    for (const folder of folders) {
      try {
        const files = await invoke<ScannedFile[]>('scan_local_folder', { folder: folder.path });
        if (Array.isArray(files)) {
          for (const file of files) allScanned.push({ file, folder });
          successfullyScannedFolders.add(folder.path.replace(/\\/g, '/').toLowerCase());
        }
      } catch (err) {
        console.warn(`[AutoSync] Could not scan folder ${folder.path}:`, err);
      }
    }

    const scannedPathSet = new Set(
      allScanned.map(({ file }) => file.path.replace(/\\/g, '/').toLowerCase()),
    );

    // 1. Identify newly added files
    const newFiles = allScanned.filter(
      ({ file }) => !existingPathMap.has(file.path.toLowerCase()),
    );

    const addedEntries: LocalEntry[] = [];
    for (const { file, folder } of newFiles) {
      const info = parseFilename(file.filename);
      try {
        const entry = await buildTmdbEntryForFolder(
          file,
          folder.type,
          folder.path,
          tmdbToken ?? null,
        );
        addedEntries.push(entry);
      } catch {
        addedEntries.push({
          id: file.path,
          path: file.path,
          filename: file.filename,
          title: info.title,
          year: info.year,
          type: info.type,
          resolution: info.resolution,
          addedAt: Date.now(),
          needsReview: true,
        });
      }
    }

    if (addedEntries.length > 0) {
      addLocalEntries(addedEntries);
    }

    // 2. Identify removed files from folders that were successfully scanned
    const removedIds: string[] = [];
    for (const entry of currentLibrary) {
      const normEntryPath = entry.path.replace(/\\/g, '/').toLowerCase();
      // Check if entry belongs to any of the successfully scanned folders
      const isUnderScannedFolder = Array.from(successfullyScannedFolders).some((f) =>
        normEntryPath.startsWith(f.endsWith('/') ? f : `${f}/`),
      );

      if (isUnderScannedFolder && !scannedPathSet.has(normEntryPath)) {
        removedIds.push(entry.id);
      }
    }

    if (removedIds.length > 0) {
      // noUndo: background auto-cleanup of deleted files isn't a user action.
      removeLocalEntries(removedIds, { noUndo: true });
    }

    return { added: addedEntries.length, removed: removedIds.length };
  } finally {
    isSyncing = false;
  }
}

/**
 * Hook to automatically sync local folders when LocalTab mounts and periodically in the background.
 */
export function useAutoLocalSync(
  tmdbToken?: string | null,
  onSyncResult?: (result: { added: number; removed: number }) => void,
) {
  const onSyncResultRef = useRef(onSyncResult);
  onSyncResultRef.current = onSyncResult;

  useEffect(() => {
    let alive = true;

    // Run initial sync on mount (throttled)
    syncLocalFolders(tmdbToken).then((res) => {
      if (alive && (res.added > 0 || res.removed > 0)) {
        onSyncResultRef.current?.(res);
      }
    });

    // Periodic sync interval
    const timer = setInterval(() => {
      syncLocalFolders(tmdbToken).then((res) => {
        if (alive && (res.added > 0 || res.removed > 0)) {
          onSyncResultRef.current?.(res);
        }
      });
    }, AUTO_SYNC_INTERVAL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tmdbToken]);
}
