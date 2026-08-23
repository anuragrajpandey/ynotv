import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { StremioMeta, StremioVideo } from '../types/stremio';
import type { VodPlayInfo } from '../types/media';
import { useLazyStremioCast, type StremioCastMember } from '../hooks/useLazyStremioCast';
import { useLazyStremioRecommendations, type RecommendationItem } from '../hooks/useLazyStremioRecommendations';
import { useActiveTmdbToken } from '../hooks/useTmdbLists';
import { useMovie, useSeriesById, useSeriesDetails } from '../hooks/useVod';
import { useLazySeriesExtras } from '../hooks/useLazySeriesExtras';
import { useLazyBackdrop } from '../hooks/useLazyBackdrop';
import './PlaybackDetailsModal.css';

export interface PlaybackDetailsModalProps {
  open: boolean;
  onClose: () => void;
  playbackSourceView?: 'movies' | 'series' | 'dvr' | 'stremio' | 'nuvio' | null;
  stremioMeta?: StremioMeta | null;
  vodInfo?: VodPlayInfo | null;
  currentEpisode?: StremioVideo | null;
  onOpenAppDetails?: () => void;
  onPlayEpisode?: (video: StremioVideo) => void;
  onPlayVodInfo?: (info: VodPlayInfo) => void;
  onSelectRecommendation?: (item: RecommendationItem) => void;
}

function RailWithControls({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation('player');
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleScroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const distance = 360;
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  };

  return (
    <div className="playback-details-rail-section">
      <div className="playback-details-rail-header">
        <h3 className="playback-details-rail-title">{title}</h3>
      </div>
      <div className="playback-details-rail-wrapper">
        <button
          type="button"
          className="playback-details-rail-btn floating left"
          onClick={() => handleScroll('left')}
          title={t('scrollLeft')}
          aria-label={t('scrollLeft')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div ref={scrollRef} className="playback-details-rail-scroll">
          {children}
        </div>
        <button
          type="button"
          className="playback-details-rail-btn floating right"
          onClick={() => handleScroll('right')}
          title={t('scrollRight')}
          aria-label={t('scrollRight')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function VodEpisodesSection({
  seriesId,
  currentSeasonNum,
  currentEpisodeNum,
  vodInfo,
  onPlayVodInfo,
  onClose,
}: {
  seriesId: string;
  currentSeasonNum?: number;
  currentEpisodeNum?: number;
  vodInfo?: VodPlayInfo | null;
  onPlayVodInfo?: (info: VodPlayInfo) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('player');
  const tmdbToken = useActiveTmdbToken();
  const { series } = useSeriesById(seriesId);
  const { episodeExtras } = useLazySeriesExtras(series, tmdbToken);
  const { seasons, loading, error, refetch } = useSeriesDetails(seriesId);

  const seasonNumbers = useMemo(() => {
    return Object.keys(seasons)
      .map(Number)
      .sort((a, b) => a - b);
  }, [seasons]);

  const [selectedSeason, setSelectedSeason] = useState<number>(
    currentSeasonNum && seasonNumbers.includes(currentSeasonNum)
      ? currentSeasonNum
      : seasonNumbers[0] ?? 1
  );

  useEffect(() => {
    if (seasonNumbers.length > 0 && !seasonNumbers.includes(selectedSeason)) {
      setSelectedSeason(seasonNumbers[0]);
    }
  }, [seasonNumbers, selectedSeason]);

  const episodes = seasons[selectedSeason] ?? [];

  if (loading) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: 'rgba(255,255,255,0.6)' }}>
        {t('loadingEpisodes')}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: '#ff6b6b' }}>
        <p>{error}</p>
        <button
          type="button"
          onClick={refetch}
          style={{
            marginTop: '8px',
            padding: '6px 16px',
            borderRadius: '8px',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: '#ffffff',
            cursor: 'pointer',
          }}
        >
          {t('tryAgain')}
        </button>
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
        {t('noEpisodesSeason', { season: selectedSeason })}.
      </div>
    );
  }

  return (
    <div className="playback-details-episodes-panel">
      {/* Season Pill Buttons Row */}
      {seasonNumbers.length > 1 && (
        <div className="playback-details-season-pills">
          {seasonNumbers.map((s) => (
            <button
              key={s}
              type="button"
              className={`playback-details-season-pill ${selectedSeason === s ? 'active' : ''}`}
              onClick={() => setSelectedSeason(s)}
            >
              {t('season', { number: s })}
            </button>
          ))}
        </div>
      )}

      {/* Episode Cards Grid */}
      <div className="playback-details-episode-grid">
        {episodes.map((ep) => {
          const isCurrent = ep.episode_num === currentEpisodeNum && ep.season_num === currentSeasonNum;
          const extra = episodeExtras.get(`${ep.season_num}_${ep.episode_num}`);
          const rawThumb = extra?.image || ep.info?.movie_image || ep.info?.cover_big || vodInfo?.backdropUrl || vodInfo?.posterUrl;
          const thumbnail = typeof rawThumb === 'string' && rawThumb.trim() ? rawThumb : null;
          const rawAirDate = extra?.airDate || ep.info?.release_date || ep.info?.releasedate;
          const airDate = (typeof rawAirDate === 'string' || typeof rawAirDate === 'number') ? String(rawAirDate) : null;
          const rating = extra?.rating ?? (ep.info?.rating ? parseFloat(String(ep.info.rating)) : null);
          const rawPlot = extra?.summary || ep.info?.plot || ep.plot;
          const plot = typeof rawPlot === 'string' ? rawPlot : null;
          const epTitle = typeof ep.title === 'string' && ep.title.trim() ? ep.title : t('episode', { number: ep.episode_num });

          return (
            <div
              key={ep.id}
              className={`playback-details-ep-card ${isCurrent ? 'active' : ''}`}
              onClick={() => {
                if (onPlayVodInfo) {
                  const playInfo: VodPlayInfo = {
                    url: ep.direct_url || ep.id,
                    title: vodInfo?.title || 'Series',
                    type: 'series',
                    episodeInfo: `S${ep.season_num} E${ep.episode_num}${epTitle ? ` · ${epTitle}` : ''}`,
                    source_id: vodInfo?.source_id,
                    mediaId: `${seriesId}_ep_${ep.id}`,
                    seriesId: seriesId,
                    seasonNum: ep.season_num,
                    episodeNum: ep.episode_num,
                    episodeId: ep.id,
                    posterUrl: vodInfo?.posterUrl,
                    backdropUrl: vodInfo?.backdropUrl,
                    logoUrl: vodInfo?.logoUrl,
                    tmdbId: vodInfo?.tmdbId,
                    imdbId: vodInfo?.imdbId,
                  };
                  onClose();
                  onPlayVodInfo(playInfo);
                }
              }}
            >
              <div className="playback-details-ep-thumb-wrap">
                {thumbnail ? (
                  <img src={thumbnail} alt={epTitle} className="playback-details-ep-thumb" loading="lazy" />
                ) : (
                  <div className="playback-details-ep-thumb-placeholder">
                    <span>E{ep.episode_num}</span>
                  </div>
                )}
                <div className="playback-details-ep-play-overlay">
                  <div className="playback-details-ep-play-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                </div>
              </div>

              <div className="playback-details-ep-meta">
                <div className="playback-details-ep-title-row">
                  <span className="playback-details-ep-num">{ep.episode_num}</span>
                  <span className="playback-details-ep-name">{epTitle}</span>
                </div>
                <div className="playback-details-ep-submeta">
                  {airDate && <span>{airDate}</span>}
                  {rating !== null && !isNaN(rating) && rating > 0 && <span>★ {rating.toFixed(1)}</span>}
                </div>
                {plot && <p className="playback-details-ep-plot">{plot}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StremioEpisodesSection({
  videos,
  currentEpisode,
  stremioMeta,
  onPlayEpisode,
  onClose,
}: {
  videos: StremioVideo[];
  currentEpisode?: StremioVideo | null;
  stremioMeta?: StremioMeta | null;
  onPlayEpisode?: (video: StremioVideo) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('player');
  const seasonsMap = useMemo(() => {
    const map = new Map<number, StremioVideo[]>();
    for (const v of videos) {
      const s = v.season ?? 1;
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(v);
    }
    return map;
  }, [videos]);

  const seasonNumbers = useMemo(() => {
    return Array.from(seasonsMap.keys()).sort((a, b) => a - b);
  }, [seasonsMap]);

  const [selectedSeason, setSelectedSeason] = useState<number>(
    currentEpisode?.season && seasonNumbers.includes(currentEpisode.season)
      ? currentEpisode.season
      : seasonNumbers[0] ?? 1
  );

  useEffect(() => {
    if (seasonNumbers.length > 0 && !seasonNumbers.includes(selectedSeason)) {
      setSelectedSeason(seasonNumbers[0]);
    }
  }, [seasonNumbers, selectedSeason]);

  const seasonEpisodes = useMemo(() => {
    return (seasonsMap.get(selectedSeason) || []).sort(
      (a, b) => (a.episode ?? 0) - (b.episode ?? 0)
    );
  }, [seasonsMap, selectedSeason]);

  return (
    <div className="playback-details-episodes-panel">
      {/* Season Pill Buttons Row */}
      {seasonNumbers.length > 1 && (
        <div className="playback-details-season-pills">
          {seasonNumbers.map((s) => (
            <button
              key={s}
              type="button"
              className={`playback-details-season-pill ${selectedSeason === s ? 'active' : ''}`}
              onClick={() => setSelectedSeason(s)}
            >
              {t('season', { number: s })}
            </button>
          ))}
        </div>
      )}

      {/* Episode Cards Grid */}
      <div className="playback-details-episode-grid">
        {seasonEpisodes.map((ep) => {
          const isCurrent = currentEpisode?.id === ep.id;
          const thumbnail = ep.thumbnail || stremioMeta?.background || stremioMeta?.poster;
          const airDate = ep.released;
          const plot = ep.overview || ep.description;

          return (
            <div
              key={ep.id}
              className={`playback-details-ep-card ${isCurrent ? 'active' : ''}`}
              onClick={() => {
                if (onPlayEpisode) {
                  onPlayEpisode(ep);
                  onClose();
                }
              }}
            >
              <div className="playback-details-ep-thumb-wrap">
                {thumbnail ? (
                  <img src={thumbnail} alt={ep.title || t('episode', { number: ep.episode })} className="playback-details-ep-thumb" loading="lazy" />
                ) : (
                  <div className="playback-details-ep-thumb-placeholder">
                    <span>E{ep.episode ?? ''}</span>
                  </div>
                )}
                <div className="playback-details-ep-play-overlay">
                  <div className="playback-details-ep-play-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </div>
                </div>
              </div>

              <div className="playback-details-ep-meta">
                <div className="playback-details-ep-title-row">
                  <span className="playback-details-ep-num">{ep.episode ?? ''}</span>
                  <span className="playback-details-ep-name">{ep.title || `Episode ${ep.episode ?? ''}`}</span>
                </div>
                {airDate && (
                  <div className="playback-details-ep-submeta">
                    <span>{airDate}</span>
                  </div>
                )}
                {plot && <p className="playback-details-ep-plot">{plot}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PlaybackDetailsModal({
  open,
  onClose,
  playbackSourceView,
  stremioMeta,
  vodInfo,
  currentEpisode,
  onOpenAppDetails,
  onPlayEpisode,
  onPlayVodInfo,
  onSelectRecommendation,
}: PlaybackDetailsModalProps) {
  const { t } = useTranslation('player');
  const [view, setView] = useState<'title' | 'episodes'>('title');
  const [expandedOverview, setExpandedOverview] = useState(false);
  const tmdbToken = useActiveTmdbToken();

  // If the caller didn't provide a usable backdrop (some playback entry points
  // only carry a raw provider path), look the item up and lazy-fetch a real
  // backdrop from TMDB/TVMaze so the banner always has a chance to load.
  const explicitBackdrop = vodInfo?.backdropUrl;
  const needsLazyBackdrop =
    !stremioMeta?.background &&
    !(explicitBackdrop && /^https?:\/\//i.test(explicitBackdrop));
  const { series: vodSeriesForBackdrop } = useSeriesById(
    needsLazyBackdrop && vodInfo?.type === 'series' && vodInfo?.seriesId ? vodInfo.seriesId : null
  );
  const { movie: vodMovieForBackdrop } = useMovie(
    needsLazyBackdrop && vodInfo?.type === 'movie' && vodInfo?.mediaId ? vodInfo.mediaId : null
  );
  const lazyBackdropUrl = useLazyBackdrop(
    vodSeriesForBackdrop ?? vodMovieForBackdrop,
    tmdbToken
  );

  useEffect(() => {
    if (open) {
      setView('title');
      setExpandedOverview(false);
    }
  }, [open]);

  // Keyboard Escape listener
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (view === 'episodes') {
          setView('title');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, view, onClose]);

  // Derived metadata from StremioMeta or VodPlayInfo
  const title = stremioMeta?.name || vodInfo?.title || t('unknownTitle');
  const poster = stremioMeta?.poster || vodInfo?.posterUrl || null;
  // A raw relative path (e.g. a provider backdrop_path passed without an
  // absolute base) would render as a broken image — prefer the lazy-fetched
  // URL in that case. Last resort: the poster/cover so the banner isn't empty.
  const backdrop =
    stremioMeta?.background ||
    (explicitBackdrop && /^https?:\/\//i.test(explicitBackdrop) ? explicitBackdrop : null) ||
    lazyBackdropUrl ||
    vodSeriesForBackdrop?.cover ||
    vodMovieForBackdrop?.stream_icon ||
    explicitBackdrop ||
    null;
  const overview =
    stremioMeta?.description ||
    vodInfo?.plot ||
    '';
  const year = stremioMeta?.year || vodInfo?.year || '';
  const imdbRating = stremioMeta?.imdbRating || null;
  const genres = stremioMeta?.genres || [];
  const isSeries =
    stremioMeta?.type === 'series' ||
    vodInfo?.type === 'series' ||
    Boolean(vodInfo?.seriesId && vodInfo.seriesId.length > 0);

  const isStremioOrNuvio =
    playbackSourceView === 'stremio' ||
    playbackSourceView === 'nuvio' ||
    Boolean(stremioMeta && stremioMeta.videos && stremioMeta.videos.length > 0);

  // Construct StremioMeta object for cast/rec hooks if using VodPlayInfo
  const metaForHooks: StremioMeta | null = useMemo(() => {
    if (stremioMeta) return stremioMeta;
    if (vodInfo) {
      return {
        id: vodInfo.imdbId || vodInfo.mediaId || vodInfo.title,
        type: vodInfo.type === 'series' ? 'series' : 'movie',
        name: vodInfo.title,
        poster: vodInfo.posterUrl,
        background: vodInfo.backdropUrl,
        description: vodInfo.plot,
        year: vodInfo.year ? parseInt(vodInfo.year, 10) : undefined,
      };
    }
    return null;
  }, [stremioMeta, vodInfo]);

  const { cast } = useLazyStremioCast(metaForHooks, tmdbToken);
  const { items: recommendations } = useLazyStremioRecommendations(metaForHooks, tmdbToken);

  if (!open) return null;

  return (
    <div
      className="playback-details-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="playback-details-card">
        {/* Background Banner */}
        {backdrop && (
          <div className="playback-details-banner">
            <img
              src={backdrop}
              alt=""
              className="playback-details-banner__img"
            />
            <div className="playback-details-banner__gradient" />
          </div>
        )}

        {/* Modal Header */}
        <header className="playback-details-header">
          {view === 'episodes' ? (
            <button
              type="button"
              className="playback-details-header__back-btn"
              onClick={() => setView('title')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              {t('backToOverview')}
            </button>
          ) : (
            <span className="playback-details-header__title">
              {t('aboutThisTitle')}
            </span>
          )}

          <div className="playback-details-header__actions">
            <button
              type="button"
              className="playback-details-header__close-btn"
              onClick={onClose}
              title={t('close')}
              aria-label={t('close')}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* Modal Body */}
        <div className="playback-details-content">
          {view === 'title' ? (
            <>
              {/* Hero Header */}
              <div className="playback-details-hero">
                {poster && (
                  <div className="playback-details-poster-wrap">
                    <img
                      src={poster}
                      alt={title}
                      className="playback-details-poster"
                    />
                  </div>
                )}
                <div className="playback-details-hero__main">
                  <h2 className="playback-details-hero__title">{title}</h2>

                  <div className="playback-details-hero__meta-row">
                    {year && <span>{year}</span>}
                    {imdbRating && (
                      <div className="playback-details-ratings">
                        <span className="playback-details-rating-badge">
                          ★ {imdbRating}
                        </span>
                      </div>
                    )}
                  </div>

                  {genres.length > 0 && (
                    <div className="playback-details-genres">
                      {genres.slice(0, 5).map((g) => (
                        <span key={g} className="playback-details-genre-pill">
                          {g}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="playback-details-actions">
                    {isSeries && (
                      <button
                        type="button"
                        className="playback-details-btn--primary"
                        onClick={() => setView('episodes')}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        {t('episodes')}
                      </button>
                    )}

                    {!isSeries && (
                      <button
                        type="button"
                        className="playback-details-btn--primary"
                        onClick={onClose}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        {t('play')}
                      </button>
                    )}

                    {onOpenAppDetails && (
                      <button
                        type="button"
                        className="playback-details-btn--secondary"
                        onClick={onOpenAppDetails}
                      >
                        {isSeries ? t('allEpisodesDetails') : t('fullDetails')}
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Synopsis / Description */}
              {overview && (
                <div className="playback-details-synopsis">
                  <p
                    className={`playback-details-synopsis__text ${
                      expandedOverview ? 'expanded' : ''
                    }`}
                  >
                    {overview}
                  </p>
                  {overview.length > 220 && (
                    <button
                      type="button"
                      className="playback-details-synopsis__toggle"
                      onClick={() => setExpandedOverview(!expandedOverview)}
                    >
                      {expandedOverview ? t('showLess') : t('readMore')}
                    </button>
                  )}
                </div>
              )}

              {/* Cast Section */}
              {cast && cast.length > 0 && (
                <RailWithControls title={t('cast')}>
                  {cast.slice(0, 24).map((c: StremioCastMember) => (
                    <div key={c.id} className="playback-details-cast-card">
                      <div className="playback-details-cast-photo-wrap">
                        {c.photo ? (
                          <img
                            src={c.photo}
                            alt={c.name}
                            className="playback-details-cast-photo"
                          />
                        ) : (
                          <div className="playback-details-cast-photo-placeholder">
                            👤
                          </div>
                        )}
                      </div>
                      <div className="playback-details-cast-name">
                        {c.name}
                      </div>
                      {c.character && (
                        <div className="playback-details-cast-role">
                          {c.character}
                        </div>
                      )}
                    </div>
                  ))}
                </RailWithControls>
              )}

              {/* More Like This Section */}
              {recommendations && recommendations.length > 0 && (
                <RailWithControls title={t('moreLikeThis')}>
                  {recommendations
                    .slice(0, 16)
                    .map((item: RecommendationItem) => (
                      <div
                        key={item.id}
                        className="playback-details-rec-card"
                        onClick={() => {
                          if (onSelectRecommendation) {
                            onSelectRecommendation(item);
                          }
                        }}
                      >
                        <div className="playback-details-rec-poster-wrap">
                          {item.posterUrl ? (
                            <img
                              src={item.posterUrl}
                              alt={item.title}
                              className="playback-details-rec-poster"
                            />
                          ) : null}
                          {item.rating ? (
                            <span className="playback-details-rec-rating">
                              ★ {item.rating.toFixed(1)}
                            </span>
                          ) : null}
                        </div>
                        <div className="playback-details-rec-title">
                          {item.title}
                        </div>
                        {item.year && (
                          <div className="playback-details-rec-year">
                            {item.year}
                          </div>
                        )}
                      </div>
                    ))}
                </RailWithControls>
              )}
            </>
          ) : (
            /* Episodes Panel View */
            !isStremioOrNuvio && vodInfo?.seriesId ? (
              <VodEpisodesSection
                seriesId={vodInfo.seriesId}
                currentSeasonNum={vodInfo.seasonNum}
                currentEpisodeNum={vodInfo.episodeNum}
                vodInfo={vodInfo}
                onPlayVodInfo={onPlayVodInfo}
                onClose={onClose}
              />
            ) : (
              <StremioEpisodesSection
                videos={stremioMeta?.videos || []}
                currentEpisode={currentEpisode}
                stremioMeta={stremioMeta}
                onPlayEpisode={onPlayEpisode}
                onClose={onClose}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
