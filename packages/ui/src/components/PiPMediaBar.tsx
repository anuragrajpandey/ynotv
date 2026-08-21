import { type ChangeEvent, useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AspectRatioMode } from '../services/tauri-bridge';
import { getAspectRatioLabel } from '../services/tauri-bridge';
import { useSettingsStore } from '../stores/settingsStore';
import './PiPMediaBar.css';

interface TimeshiftState {
  cacheStart: number;
  cacheEnd: number;
  timePos: number;
  behindLive: number;
  cachedDuration: number;
}

interface PiPMediaBarProps {
  visible: boolean;
  playing: boolean;
  muted: boolean;
  volume: number;
  position: number;
  duration: number;
  isVod?: boolean;
  timeshiftState?: TimeshiftState | null;
  aspectRatio?: AspectRatioMode;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onSeek?: (seconds: number) => void;
  onExitPip: () => void;
  onSetAspectRatio?: (mode: AspectRatioMode) => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const ASPECT_MODES: AspectRatioMode[] = ['fit', 'fill', 'stretch', '4:3', '16:9'];

export function PiPMediaBar({
  visible,
  playing,
  muted,
  volume,
  position,
  duration,
  isVod,
  timeshiftState,
  aspectRatio = 'fit',
  onTogglePlay,
  onToggleMute,
  onVolumeChange,
  onSeek,
  onExitPip,
  onSetAspectRatio,
}: PiPMediaBarProps) {
  const { t } = useTranslation('player');
  const maxVolume = useSettingsStore((s) => s.subtitleSettings?.audioMaxVolume || 100);
  const [seekHover, setSeekHover] = useState(false);
  const [seekDrag, setSeekDrag] = useState(false);
  const [hoverPos, setHoverPos] = useState(0);
  const [showAr, setShowAr] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const arRef = useRef<HTMLDivElement>(null);

  const hasTimeshift = timeshiftState && timeshiftState.cachedDuration > 1;
  const showSeek = ((isVod && duration > 0) || !!hasTimeshift) && !!onSeek;

  const getRatio = useCallback((clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const vodProgress = duration > 0 ? (position / duration) * 100 : 0;
  const ts = hasTimeshift ? timeshiftState! : null;
  const tsPlayheadPct = ts ? ((ts.timePos - ts.cacheStart) / ts.cachedDuration) * 100 : 0;
  const seekFillPct = ts ? tsPlayheadPct : vodProgress;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!showSeek || !onSeek) return;
    const ratio = getRatio(e.clientX);
    if (ts) {
      onSeek(ts.cacheStart + ratio * ts.cachedDuration);
    } else {
      onSeek(ratio * duration);
    }
  }, [showSeek, onSeek, getRatio, ts, duration]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (!showSeek || !onSeek) return;
    e.preventDefault();
    setSeekDrag(true);
    const ratio = getRatio(e.clientX);
    setHoverPos(ts ? ts.cacheStart + ratio * ts.cachedDuration : ratio * duration);
  }, [showSeek, onSeek, getRatio, ts, duration]);

  useEffect(() => {
    if (!seekDrag) return;
    const onMove = (e: MouseEvent) => {
      const ratio = getRatio(e.clientX);
      setHoverPos(ts ? ts.cacheStart + ratio * ts.cachedDuration : ratio * duration);
    };
    const onUp = (e: MouseEvent) => {
      setSeekDrag(false);
      if (onSeek) {
        const ratio = getRatio(e.clientX);
        onSeek(ts ? ts.cacheStart + ratio * ts.cachedDuration : ratio * duration);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [seekDrag, duration, onSeek, getRatio, ts]);

  // Close aspect menu on outside click
  useEffect(() => {
    if (!showAr) return;
    const handler = (e: MouseEvent) => {
      if (arRef.current && !arRef.current.contains(e.target as Node)) setShowAr(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAr]);

  return (
    <div className={`pip-media-bar ${visible ? 'visible' : 'hidden'}`}>
      <div className="pip-media-bar-inner">
        <button className="pip-exit-btn" onClick={onExitPip} title={t('exitPip')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="18" rx="2" />
            <rect x="10" y="10" width="10" height="8" rx="1" fill="currentColor" fillOpacity="0.3" />
            <line x1="22" y1="2" x2="2" y2="22" />
          </svg>
        </button>

        <button className="pip-play-btn" onClick={onTogglePlay} title={playing ? t('pause') : t('play')}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {showSeek && (
          <>
            <span className="pip-time">{formatTime(ts ? ts.timePos - ts.cacheStart : position)}</span>
            <div
              ref={barRef}
              className={`pip-seek-bar ${seekHover || seekDrag ? 'active' : ''}`}
              onClick={handleClick}
              onMouseEnter={() => setSeekHover(true)}
              onMouseLeave={() => setSeekHover(false)}
              onMouseDown={handleDragStart}
            >
              <div className="pip-seek-fill" style={{ width: `${seekFillPct}%` }} />
              <div className={`pip-scrubber ${seekDrag ? 'dragging' : ''}`} style={{ left: `${seekFillPct}%` }} />
              {seekHover && !seekDrag && (
                <div className="pip-time-tip" style={{ left: `${ts ? ((hoverPos - ts.cacheStart) / ts.cachedDuration) * 100 : (hoverPos / duration) * 100}%` }}>
                  {formatTime(hoverPos)}
                </div>
              )}
            </div>
            <span className="pip-time">{formatTime(ts ? ts.behindLive : Math.max(0, duration - position))}</span>
          </>
        )}

        {/* Aspect Ratio */}
        {onSetAspectRatio && (
          <div className="pip-ar-wrap" ref={arRef}>
            <button
              className="pip-ar-btn"
              onClick={() => setShowAr(v => !v)}
              title={t('aspectRatioLabel', { mode: getAspectRatioLabel(aspectRatio) })}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M7 9h2M7 15h2M15 9h2M15 15h2" />
              </svg>
            </button>
            {showAr && (
              <div className="pip-ar-menu">
                {ASPECT_MODES.map(m => (
                  <button
                    key={m}
                    className={`pip-ar-item ${aspectRatio === m ? 'active' : ''}`}
                    onClick={() => { onSetAspectRatio(m); setShowAr(false); }}
                  >
                    {getAspectRatioLabel(m)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button className="pip-mute-btn" onClick={onToggleMute} title={muted ? t('unmute') : t('mute')}>
          {muted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            </svg>
          )}
        </button>

        <input
          type="range"
          className="pip-volume-slider"
          min="0"
          max={maxVolume}
          value={volume}
          onChange={onVolumeChange}
          title={t('volume')}
        />
      </div>
    </div>
  );
}
