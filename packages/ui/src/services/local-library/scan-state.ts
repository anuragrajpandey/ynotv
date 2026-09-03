import { readAppKvSync, loadAppKv, writeAppKv } from '../appKv';

/**
 * Persisted folder-scan progress.
 *
 * A 20k-file scan can take a long time; if the app restarts mid-scan the
 * entries completed so far are already in `local_entries` (they're persisted
 * incrementally), but the overlay progress and the fact that a scan was
 * interrupted would be lost. This module records the current scan's folder +
 * counters to the SQLite app_kv store (survives restart, survives "Clear All
 * Cached Data") so the Local tab can offer to resume from where it left off —
 * a resume re-walks the folder and only processes files that aren't already
 * in the library, continuing the progress counters.
 */

export type ScanStatus = 'scanning' | 'cancelled' | 'completed';

export interface ScanState {
  folderPath: string;
  current: number;
  total: number;
  status: ScanStatus;
  updatedAt: number;
}

const SCAN_STATE_KEY = 'ynotv.library.local.scanState.v1';

// Per-file checkpoint: the full path list of the folder as first walked by the
// scan. Persisted once at scan start so a resume can compute the remaining
// files without re-walking the whole folder (the done-set is derived from the
// local_entries table, which the scan now populates incrementally).
const SCAN_FILES_KEY = 'ynotv.library.local.scanFiles.v1';

export function readScanStateSync(): ScanState | null {
  const raw = readAppKvSync(SCAN_STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.folderPath !== 'string') return null;
    return {
      folderPath: parsed.folderPath,
      current: Number(parsed.current) || 0,
      total: Number(parsed.total) || 0,
      status: parsed.status === 'cancelled' || parsed.status === 'completed' ? parsed.status : 'scanning',
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Load the authoritative scan state from SQLite (bootstrap from localStorage first). */
export async function loadScanState(): Promise<ScanState | null> {
  await loadAppKv(SCAN_STATE_KEY).catch(() => null);
  return readScanStateSync();
}

/** Persist the current scan state (async, errors logged). */
export function writeScanState(state: ScanState): void {
  void writeAppKv(SCAN_STATE_KEY, JSON.stringify(state));
}

/** Remove the persisted scan state (scan finished or user dismissed resume). */
export function clearScanState(): void {
  void writeAppKv(SCAN_STATE_KEY, '');
}

/** Synchronously read the persisted file checkpoint (paths from the first walk). */
export function readScanFilesSync(): string[] | null {
  const raw = readAppKvSync(SCAN_FILES_KEY);
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

/** Load the authoritative file checkpoint from SQLite (bootstrap from localStorage first). */
export async function loadScanFiles(): Promise<string[] | null> {
  await loadAppKv(SCAN_FILES_KEY).catch(() => null);
  return readScanFilesSync();
}

/** Persist the full file list of the current scan (one write at scan start). */
export function writeScanFiles(paths: string[]): void {
  void writeAppKv(SCAN_FILES_KEY, JSON.stringify(paths));
}

/** Remove the persisted file checkpoint (scan finished or user dismissed resume). */
export function clearScanFiles(): void {
  void writeAppKv(SCAN_FILES_KEY, '');
}
