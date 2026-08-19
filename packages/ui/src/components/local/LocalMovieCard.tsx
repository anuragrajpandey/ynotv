import { useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalEntry } from '../../services/local-library/types';
import { removeLocalEntry } from '../../services/local-library/local-library';
import { useLocalMovieWatchStatus, markLocalMovieWatched } from '../../services/local-library/local-watch';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';

interface LocalMovieCardProps {
  entry: LocalEntry;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onPlay: (entry: LocalEntry) => void;
  onOpenDetail?: (entry: LocalEntry) => void;
  onFixMatch: (entry: LocalEntry) => void;
  onAddToPlaylist: (entry: LocalEntry) => void;
}

export const LocalMovieCard = memo(function LocalMovieCard({
  entry,
  selectMode,
  isSelected,
  onToggleSelect,
  onPlay,
  onOpenDetail,
  onFixMatch,
  onAddToPlaylist,
}: LocalMovieCardProps) {
  const { t } = useTranslation('vod');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const watchStatus = useLocalMovieWatchStatus(entry);
  const favoriteId = `local_${entry.id}`;
  const isFavorite = useVodFavoritesStore((s) =>
    s.favorites.some((f) => f.id === favoriteId && f.type === 'movie'),
  );

  const posterRaw = entry.poster || entry.localArt?.poster;
  const posterSrc = posterRaw
    ? (posterRaw.startsWith('http://') || posterRaw.startsWith('https://') || posterRaw.startsWith('data:') || posterRaw.startsWith('asset:')
      ? posterRaw
      : convertFileSrc(posterRaw))
    : null;

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const rating = entry.rating != null && entry.rating > 0 ? entry.rating : null;

  const handleCardClick = useCallback(() => {
    if (selectMode) {
      onToggleSelect(entry.id);
    } else if (onOpenDetail) {
      onOpenDetail(entry);
    } else {
      onPlay(entry);
    }
  }, [selectMode, entry, onToggleSelect, onOpenDetail, onPlay]);

  const handlePlayClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onPlay(entry);
  }, [entry, onPlay]);

  const handleToggleWatched = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await markLocalMovieWatched(entry, !watchStatus.completed);
  }, [entry, watchStatus.completed]);

  const handleToggleFavorite = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const favStore = useVodFavoritesStore.getState();
    if (isFavorite) {
      favStore.removeFavorite(favoriteId, 'movie');
    } else {
      favStore.addFavorite({
        id: favoriteId,
        type: 'movie',
        title: entry.title || entry.filename,
        poster: entry.poster || entry.localArt?.poster || undefined,
        year: entry.year != null ? String(entry.year) : undefined,
      });
    }
  }, [isFavorite, favoriteId, entry.title, entry.filename, entry.poster, entry.localArt, entry.year]);

  const handleAddToPlaylist = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAddToPlaylist(entry);
  }, [entry, onAddToPlaylist]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      removeLocalEntry(entry.id);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
    }
  }, [confirmDelete, entry.id]);

  return (
    <div
      className="local-card"
      onMouseLeave={() => setConfirmDelete(false)}
    >
      <div
        className={`local-card__poster-wrap ${isSelected ? 'selected' : ''}`}
        onClick={handleCardClick}
      >
        {posterSrc ? (
          <img
            src={posterSrc}
            alt={entry.title}
            className="local-card__poster-img"
            loading="lazy"
          />
        ) : (
          <div className="local-card__poster-fallback">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
          </div>
        )}

        {/* Resolution / Local Badge */}
        <span className="local-badge">
          {entry.resolution || 'Local'}
        </span>

        {/* Watched Badge */}
        {watchStatus.completed && !selectMode && (
          <span
            className={`local-watched-badge${rating ? ' local-watched-badge--below-rating' : ''}`}
            title={t('watched', 'Watched')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
        )}

        {/* Rating Badge */}
        {rating && !selectMode && (
          <span className="local-rating-badge" title={t('rating', 'Rating')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            {rating.toFixed(1)}
          </span>
        )}

        {/* Needs Review Badge */}
        {entry.needsReview && !selectMode && (
          <span className="local-review-badge">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Review
          </span>
        )}

        {/* Progress Bar */}
        {watchStatus.progressPercent > 0 && !watchStatus.completed && (
          <div className="local-card__progress-track">
            <div
              className="local-card__progress-fill"
              style={{ width: `${watchStatus.progressPercent}%` }}
            />
          </div>
        )}

        {/* Select Mode Checkbox */}
        {selectMode ? (
          <div
            className={`local-card__select-checkbox ${isSelected ? 'checked' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(entry.id);
            }}
          >
            {isSelected && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </div>
        ) : (
          <>
            {/* Play Button Hover Overlay */}
            <div className="local-card__hover-overlay">
              <div
                className="local-card__play-btn"
                onClick={handlePlayClick}
                role="button"
                title={t('play', 'Play')}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
            </div>

            {/* Quick Action Buttons */}
            <div className="local-card__action-btns">
              {onOpenDetail && (
                <button
                  type="button"
                  className="local-card__action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDetail(entry);
                  }}
                  title={t('moreInfo', 'More info')}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </button>
              )}

              <button
                type="button"
                className="local-card__action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onFixMatch(entry);
                }}
                title={t('fixMatch', 'Fix match')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
                </svg>
              </button>

              <button
                type="button"
                className="local-card__action-btn"
                onClick={handleToggleWatched}
                title={watchStatus.completed ? t('markUnwatched', 'Mark as unwatched') : t('markWatched', 'Mark as watched')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>

              <button
                type="button"
                className={`local-card__action-btn ${isFavorite ? 'favorited' : ''}`}
                onClick={handleToggleFavorite}
                title={isFavorite ? t('removeFavorite', 'Remove from favorites') : t('addFavorite', 'Add to favorites')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              <button
                type="button"
                className="local-card__action-btn"
                onClick={handleAddToPlaylist}
                title={t('addToPlaylist', 'Add to playlist')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>

              <button
                type="button"
                className={`local-card__action-btn ${confirmDelete ? 'danger' : ''}`}
                onClick={handleDelete}
                title={confirmDelete ? t('confirmRemove', 'Click again to remove') : t('remove', 'Remove')}
              >
                {confirmDelete ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="local-card__info" onClick={handleCardClick} style={{ cursor: 'pointer' }}>
        <h4 className="local-card__title" title={entry.title}>
          {entry.title}
        </h4>
        <p className="local-card__subtitle">
          {entry.year || entry.resolution || 'Local'}
        </p>
      </div>
    </div>
  );
});
