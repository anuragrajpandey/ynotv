import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StoredChannel } from '../db';
import type { LayoutMode, ViewerSlot } from '../hooks/useMultiview';
import { applyTvFocus } from '../services/spatialNavigation';
import './MultiviewPlayTargetPicker.css';

interface MultiviewPlayTargetPickerProps {
  /** Channel to send to a screen. null hides the picker. */
  channel: StoredChannel | null;
  /** Current multiview layout — decides which slots exist as targets. */
  layout: LayoutMode;
  /** Live slot state — lets each button show what's playing there now. */
  slots?: ViewerSlot[];
  /** Currently playing main channel name (for the Main Player button). */
  mainChannelName?: string | null;
  onPlayMain: (channel: StoredChannel) => void;
  onSendToSlot: (slotId: 2 | 3 | 4, channel: StoredChannel) => void;
  onClose: () => void;
}

/**
 * "Send to screen" picker. When live-sports play actions happen while a
 * multiview layout is active, the stream could go to the main player or to
 * any secondary slot — this modal lets the user choose before playing.
 *
 * Classed `multiview-target-modal` (recognized by the spatial-nav modal
 * system) with a `.game-detail-close` close button, so controller/remote
 * users can navigate it and Back closes it.
 */
export function MultiviewPlayTargetPicker({
  channel,
  layout,
  slots,
  mainChannelName,
  onPlayMain,
  onSendToSlot,
  onClose,
}: MultiviewPlayTargetPickerProps) {
  const { t } = useTranslation(['sports', 'player']);

  // The slots available in the current layout. pip and sbs only have one
  // secondary slot; 2x2 and bigbottom have three.
  const slotTargets = useMemo(() => {
    if (layout === 'pip' || layout === 'sbs') return [2] as (2 | 3 | 4)[];
    if (layout === '2x2' || layout === 'bigbottom') return [2, 3, 4] as (2 | 3 | 4)[];
    return [] as (2 | 3 | 4)[];
  }, [layout]);

  // Escape closes (matches the other sports modals).
  useEffect(() => {
    if (!channel) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [channel, onClose]);

  // Drop the D-pad highlight on the first target when opened (controller
  // flows), so users can press OK / Down without a dead first press.
  useEffect(() => {
    if (!channel) return;
    if (!document.body.classList.contains('tv-nav-active')) return;
    const first = document.querySelector<HTMLElement>('.mvtp-target');
    if (first) applyTvFocus(first);
  }, [channel]);

  if (!channel) return null;

  const channelName = channel.alias || channel.name;

  // "Screen 2 — ESPN" style label: the channel name is appended outside the
  // translation so no locale placeholders are involved.
  const slotLabel = (slotId: 2 | 3 | 4) => {
    const base = t('sports:screenNum', { num: slotId, defaultValue: `Screen ${slotId}` });
    const slot = slots?.find((s) => s.id === slotId);
    const playing = slot?.active ? slot.channelName : null;
    return playing ? `${base} — ${playing}` : base;
  };

  const mainLabel = mainChannelName ? `${t('player:mainPlayer', 'Main Player')} — ${mainChannelName}` : t('player:mainPlayer', 'Main Player');

  return createPortal(
    <div
      className="mvtp-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="mvtp-modal multiview-target-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('sports:sendToScreen', 'Send to screen')}
      >
        <div className="mvtp-header">
          <div className="mvtp-title-row">
            <span className="mvtp-title">{t('sports:sendToScreen', 'Send to screen')}</span>
          </div>
          <button
            className="game-detail-close mvtp-close"
            onClick={onClose}
            title={t('sports:close', 'Close')}
            aria-label={t('sports:close', 'Close')}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="mvtp-channel" title={channelName}>
          {channelName}
        </div>

        <div className="mvtp-targets">
          <button className="mvtp-target mvtp-main" onClick={() => onPlayMain(channel)}>
            <span className="mvtp-target-slot">1</span>
            <span className="mvtp-target-label">{mainLabel}</span>
          </button>
          {slotTargets.map((slotId) => (
            <button
              key={slotId}
              className="mvtp-target"
              onClick={() => onSendToSlot(slotId, channel)}
            >
              <span className="mvtp-target-slot">{slotId}</span>
              <span className="mvtp-target-label">{slotLabel(slotId)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
