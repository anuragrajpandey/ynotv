import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useChannelSyncing,
  useVodSyncing,
  useSyncStatusMessage,
  useSyncProgress,
  useTmdbMatching,
} from '../stores/uiStore';
import i18n from '../i18n';
import './Toast.css';

/**
 * Bottom-right toast that mirrors the sync status shown on the hero screen,
 * so users who boot straight into LiveTV (or any view) still see when a
 * channel / VOD / auto-sync is running. Blue accent to distinguish it from
 * the success/error toasts, a quiet note explaining that performance may be
 * slower while it runs, a progress bar for batch syncs, and a dismiss button
 * that only hides it for the current sync session.
 */
export function SyncStatusToast() {
  const channelSyncing = useChannelSyncing();
  const vodSyncing = useVodSyncing();
  const syncStatusMessage = useSyncStatusMessage();
  const syncProgress = useSyncProgress();
  const tmdbMatching = useTmdbMatching();

  const syncing = channelSyncing || vodSyncing || tmdbMatching;

  const [dismissed, setDismissed] = useState(false);

  // Reset the dismissal each time a new sync session begins (transitioned from
  // idle → syncing) and when syncing stops, so the toast reappears next sync.
  const wasSyncingRef = useRef(false);
  useEffect(() => {
    if (!syncing && wasSyncingRef.current) {
      setDismissed(false);
    }
    wasSyncingRef.current = syncing;
  }, [syncing]);

  if (!syncing || dismissed) return null;

  const message =
    syncStatusMessage ||
    (channelSyncing && vodSyncing
      ? i18n.t('common:syncingChannelsAndVod')
      : channelSyncing
        ? i18n.t('common:syncingChannels')
        : vodSyncing
          ? i18n.t('common:syncingVod')
          : i18n.t('common:matchingTmdb'));

  // Only show the bar when there is more than one batch. With concurrency=0
  // (all sources at once) there is a single batch, so a bar would just sit at
  // 100% and add noise. total > 1 means we have incremental progress to show.
  const pct = syncProgress && syncProgress.total > 1
    ? Math.min(100, Math.max(0, Math.round((syncProgress.done / syncProgress.total) * 100)))
    : null;

  return createPortal(
    <div className="sync-toast">
      <span className="sync-toast__spinner" />
      <span className="sync-toast__body">
        <span className="sync-toast__message">{message}</span>
        <span className="sync-toast__note">{i18n.t('common:syncPerformanceNote')}</span>
        {pct !== null && (
          <span className="sync-toast__progress">
            <span className="sync-toast__progress-track">
              <span className="sync-toast__progress-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="sync-toast__progress-label">{pct}%</span>
          </span>
        )}
      </span>
      <button className="sync-toast__close" onClick={() => setDismissed(true)} title={i18n.t('common:close')} aria-label={i18n.t('common:close')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>,
    document.body,
  );
}