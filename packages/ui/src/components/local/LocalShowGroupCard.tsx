import { useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalEntry } from '../../services/local-library/types';
import { removeLocalEntries } from '../../services/local-library/local-library';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { usePosterRetry } from './usePosterRetry';

interface LocalShowGroupCardProps {
  head: LocalEntry;
  episodes: LocalEntry[];
  seriesKey: string;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (ids: string[]) => void;
  onOpenEpisodes: (head: LocalEntry, episodes: LocalEntry[]) => void;
  onOpenDetail?: (head: LocalEntry) => void;
  onFixMatch: (episodes: LocalEntry[]) => void;
  onRefreshMetadata: (episodes: LocalEntry[]) => void;
  onPosterError?: () => void;
  onPosterLoad?: () => void;
  onAddToPlaylist: (head: LocalEntry, episodes: LocalEntry[]) => void;
}

export const LocalShowGroupCard = memo(function LocalShowGroupCard({
  head,
  episodes,
  seriesKey,
  selectMode,
  isSelected,
  onToggleSelect,
  onOpenEpisodes,
  onOpenDetail,
  onFixMatch,
  onRefreshMetadata,
  onPosterError,
  onPosterLoad,
  onAddToPlaylist,
}: LocalShowGroupCardProps) {
  const { t } = useTranslation('vod');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const favoriteId = `local_${seriesKey}`;
  const isFavorite = useVodFavoritesStore((s) =>
    s.favorites.some((f) => f.id === favoriteId && f.type === 'series'),
  );

  const posterRaw = head.poster || head.localArt?.poster;
  const posterSrc = posterRaw
    ? (posterRaw.startsWith('http://') || posterRaw.startsWith('https://') || posterRaw.startsWith('data:') || posterRaw.startsWith('asset:')
      ? posterRaw
      : convertFileSrc(posterRaw))
    : null;
  const { retryKey, handleError, handleLoad } = usePosterRetry(onPosterError, onPosterLoad, posterSrc);

  const episodeIds = episodes.map((e) => e.id);
  const needsReview = episodes.some((e) => e.needsReview);

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const rating = head.rating != null && head.rating > 0 ? head.rating : null;

  const handleCardClick = useCallback(() => {
    if (selectMode) {
      onToggleSelect(episodeIds);
    } else if (onOpenDetail) {
      onOpenDetail(head);
    } else {
      onOpenEpisodes(head, episodes);
    }
  }, [selectMode, head, episodes, episodeIds, onToggleSelect, onOpenDetail, onOpenEpisodes]);

  const handleEpisodesClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenEpisodes(head, episodes);
  }, [head, episodes, onOpenEpisodes]);

  const handleToggleFavorite = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const favStore = useVodFavoritesStore.getState();
    if (isFavorite) {
      favStore.removeFavorite(favoriteId, 'series');
    } else {
      favStore.addFavorite({
        id: favoriteId,
        type: 'series',
        title: head.title || head.filename,
        poster: head.poster || head.localArt?.poster || undefined,
        year: head.year != null ? String(head.year) : undefined,
      });
    }
  }, [isFavorite, favoriteId, head.title, head.filename, head.poster, head.localArt, head.year]);

  const handleAddToPlaylist = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onAddToPlaylist(head, episodes);
  }, [head, episodes, onAddToPlaylist]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      removeLocalEntries(episodeIds);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);
    }
  }, [confirmDelete, episodeIds]);

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
            key={retryKey}
            src={posterSrc}
            alt={head.title}
            className="local-card__poster-img"
            loading="lazy"
            onError={handleError}
            onLoad={handleLoad}
          />
        ) : (
          <div className="local-card__poster-fallback">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
              <polyline points="17 2 12 7 7 2" />
            </svg>
          </div>
        )}

        {/* Local Badge */}
        <span className="local-badge">
          Local
        </span>

        {/* Rating Badge */}
        {rating && !selectMode && (
          <span className="local-rating-badge" title={t('rating', 'Rating')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            {rating.toFixed(1)}
          </span>
        )}

        {/* Episode count badge */}
        <span className="local-ep-count-badge">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          {episodes.length} {episodes.length === 1 ? t('episode', 'ep') : t('episodes', 'eps')}
        </span>

        {/* Needs Review Badge */}
        {needsReview && !selectMode && (
          <span className="local-review-badge">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Review
          </span>
        )}

        {/* Select Mode Checkbox */}
        {selectMode ? (
          <div
            className={`local-card__select-checkbox ${isSelected ? 'checked' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(episodeIds);
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
            {/* Hover Overlay */}
            <div className="local-card__hover-overlay">
              <div
                className="local-card__play-btn"
                onClick={handleEpisodesClick}
                role="button"
                title={t('episodes', 'Episodes')}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </div>
            </div>

            {/* Action buttons on hover */}
            <div className="local-card__action-btns">
              <button
                type="button"
                className="local-card__action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRefreshMetadata(episodes);
                }}
                title={t('refreshMetadata', 'Refresh metadata')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>

              <button
                type="button"
                className="local-card__action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onFixMatch(episodes);
                }}
                title={t('fixMatch', 'Fix match')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
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
        <h4 className="local-card__title" title={head.title}>
          {head.title}
        </h4>
        <p className="local-card__subtitle">
          {episodes.length} {episodes.length === 1 ? t('episode', 'episode') : t('episodes', 'episodes')}
        </p>
      </div>
    </div>
  );
});
