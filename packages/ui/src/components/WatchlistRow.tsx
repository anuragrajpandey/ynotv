import { useState, useRef } from 'react';
import type { WatchlistItem, StoredChannel, StoredProgram } from '../db';
import { removeFromWatchlist, updateWatchlistOptions } from '../db';
import { WatchlistOptionsModal } from './WatchlistOptionsModal';
import { FavoriteButton } from './FavoriteButton';
import { ChannelLogo } from './ChannelLogo';
import { useSettingsStore } from '../stores/settingsStore';
import { useEpgClockFormat } from '../stores/uiStore';
import { formatTime, formatDate } from '../utils/dateTime';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './ChannelPanel.css';

// Channel column width is controlled via CSS custom property for resizability

interface WatchlistRowProps {
  item: WatchlistItem;
  channel?: StoredChannel;
  programs: StoredProgram[];
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  onPlay: () => void;
  onRefresh: () => void;
  showPlaylistName?: boolean;
  sourceNames?: Map<string, string>;
}

export function WatchlistRow({
  item,
  channel,
  programs,
  onPlay,
  onRefresh,
  showPlaylistName,
  sourceNames,
}: WatchlistRowProps) {
  const [showEditModal, setShowEditModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useTranslation();

  // Per-source logo overrides are read straight from the store so changes
  // apply live without re-running the channel query. Must be before the early
  // return below (hooks are unconditional).
  const sourceLogoDisplayOverrides = useSettingsStore((s) => s.sourceLogoDisplayOverrides);
  const sourceLogoBackgroundOverrides = useSettingsStore((s) => s.sourceLogoBackgroundOverrides);

  const now = new Date();

  // Early return if channel is not available
  if (!channel) {
    const handleDeleteUnavailable = async () => {
      if (!item.id) return;
      try {
        await removeFromWatchlist(item.id);
        onRefresh();
      } catch (error) {
        console.error('[Watchlist] Failed to delete:', error);
      }
    };

    return (
      <div className="guide-channel-row search-result-row" ref={rowRef}>
        <div
          className="guide-channel-info"
          style={{
            width: 'var(--epg-channel-column-width, 264px)',
            minWidth: 'var(--epg-channel-column-width, 264px)',
            maxWidth: 'var(--epg-channel-column-width, 264px)',
            opacity: 0.5,
          }}
        >
          <ChannelLogo
            src={null}
            name={item.channel_name}
            className="guide-channel-logo"
            placeholderClass="logo-placeholder"
          />
          <div className="guide-channel-name-container">
            <span className="guide-channel-name">{item.channel_name} (Unavailable)</span>
          </div>
        </div>
        <div className="search-programs-container" style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>{item.program_title}</span>
          <button
            className="watchlist-btn-delete"
            onClick={handleDeleteUnavailable}
            title={i18n.t('common:removeFromWatchlist')}
            style={{ marginLeft: 'auto' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  const isLive = item.start_time <= now.getTime() && item.end_time > now.getTime();

  const handleDelete = async () => {
    if (!item.id) return;
    setIsDeleting(true);
    try {
      await removeFromWatchlist(item.id);
      onRefresh();
    } catch (error) {
      console.error('[Watchlist] Failed to delete:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEdit = async (options: {
    reminder_enabled: boolean;
    reminder_minutes: number;
    autoswitch_enabled: boolean;
    autoswitch_seconds_before?: number;
  }) => {
    if (!item.id) return;
    try {
      await updateWatchlistOptions(item.id, options);
      onRefresh();
    } catch (error) {
      console.error('[Watchlist] Failed to update:', error);
    }
  };

  const epgClockFormat = useEpgClockFormat();

  // Format time
  const formatEpgTime = (timestamp: number | Date) => {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return formatTime(date, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
  };

  // Status indicators
  const hasReminder = item.reminder_enabled;
  const hasAutoswitch = item.autoswitch_enabled;

  return (
    <>
      <div className={`guide-channel-row search-result-row ${showPlaylistName ? 'has-playlist-name' : ''}`} ref={rowRef}>
        {/* Channel info column */}
        <div
          className={`guide-channel-info ${showPlaylistName ? 'has-playlist-name' : ''}`}
          style={{
            width: 'var(--epg-channel-column-width, 264px)',
            minWidth: 'var(--epg-channel-column-width, 264px)',
            maxWidth: 'var(--epg-channel-column-width, 264px)',
          }}
          onClick={onPlay}
        >
          <FavoriteButton
            streamId={channel.stream_id}
            isFavorite={!!channel.is_favorite}
            onToggle={() => { }}
          />
          <ChannelLogo
            src={channel.stream_icon}
            name={channel.alias || channel.name}
            className="guide-channel-logo"
            background={channel.logo_background as 'auto' | 'light' | 'dark' | undefined}
            defaultBackground={sourceLogoBackgroundOverrides[channel.source_id]}
            padding={channel.logo_padding as 'default' | 'none' | undefined}
            shape={sourceLogoDisplayOverrides[channel.source_id]}
          />
          <div className="guide-channel-name-container">
            <span className="guide-channel-name" title={channel.alias || channel.name}>
              {isLive && <span className="live-indicator">●</span>}
              {channel.alias || channel.name}
              {(Boolean(channel.tv_archive) || channel.tv_archive === 1) && (
                <span style={{ color: '#e5a00d', marginLeft: '4px', fontSize: '1.1em', verticalAlign: 'middle' }}>↺</span>
              )}
            </span>
            {showPlaylistName && (
              <span className="guide-channel-playlist-name" title={sourceNames?.get(channel.source_id) || channel.source_id}>
                {sourceNames?.get(channel.source_id) || channel.source_id}
              </span>
            )}
            {channel.channel_num && (
              <span className="guide-channel-number">Ch. {channel.channel_num}</span>
            )}
          </div>
        </div>

        {/* Program info */}
        <div className="search-programs-container" style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, color: 'white', marginBottom: 4 }}>
              {item.program_title}
            </div>
            <div style={{ fontSize: '0.85em', color: 'rgba(255,255,255,0.6)' }}>
              {formatDate(new Date(item.start_time))} {formatEpgTime(item.start_time)} - {formatEpgTime(item.end_time)}
              {hasReminder && (
                <span style={{ marginLeft: 8 }} title={i18n.t('common:reminderMinutesBefore', { minutes: item.reminder_minutes })}>🔔</span>
              )}
              {hasAutoswitch && (
                <span style={{ marginLeft: 8 }} title={item.autoswitch_seconds_before ? i18n.t('common:autoSwitchSecondsBefore', { seconds: item.autoswitch_seconds_before }) : i18n.t('common:autoSwitch')}>🔄</span>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="watchlist-actions" style={{ display: 'flex', gap: 8 }}>
            <button
              className="watchlist-btn-edit"
              onClick={(e) => {
                e.stopPropagation();
                setShowEditModal(true);
              }}
              title={i18n.t('common:editWatchlistSettings')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              className="watchlist-btn-delete"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              disabled={isDeleting}
              title={i18n.t('common:removeFromWatchlist')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      <WatchlistOptionsModal
        isOpen={showEditModal}
        program={{
          id: item.program_id,
          stream_id: item.channel_id,
          title: item.program_title,
          description: item.description || '',
          start: new Date(item.start_time),
          end: new Date(item.end_time),
          source_id: item.source_id,
        }}
        channel={channel}
        existingItem={item}
        onConfirm={(options) => {
          handleEdit(options);
          setShowEditModal(false);
        }}
        onCancel={() => setShowEditModal(false)}
      />
    </>
  );
}
