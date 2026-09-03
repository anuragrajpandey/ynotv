import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { StremioMetaPreview } from '../../types/stremio';
import { fetchCatalog } from '../../services/stremio-addon';
import { useNuvioAddonStore } from '../../stores/nuvioAddonStore';
import { useNuvioCollectionStore } from '../../stores/nuvioCollectionStore';
import { useNuvioAuthStore } from '../../stores/nuvioAuthStore';
import { resolveCollectionsForHero } from '../../services/collectionSourceResolver';
import '../stremio/StremioHeroBanner.css';

interface NuvioHeroBannerProps {
  onItemClick: (item: StremioMetaPreview) => void;
  onAddToLibrary: (item: StremioMetaPreview) => void;
  libraryIds: Set<string>;
}

export function NuvioHeroBanner({ onItemClick, onAddToLibrary, libraryIds }: NuvioHeroBannerProps) {
  useTranslation();
  const [items, setItems] = useState<StremioMetaPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const autoCycleRef = useRef<any>(null);

  // Listen for hero catalog changes in settings
  useEffect(() => {
    const handler = () => setRefreshKey(k => k + 1);
    window.addEventListener('nuvioHeroCatalogsChanged', handler);
    return () => window.removeEventListener('nuvioHeroCatalogsChanged', handler);
  }, []);

  // Fetch items from selected hero catalogs or fallback to collections
  useEffect(() => {
    let active = true;
    setLoading(true);

    const loadHeroItems = async () => {
      try {
        const raw: any[] = JSON.parse(localStorage.getItem('nuvio_hero_catalogs') || '[]');
        const addons = useNuvioAddonStore.getState().enabledAddons;
        const allCollections = useNuvioCollectionStore.getState().collections || [];
        const homeCatalogSettings = useNuvioAuthStore.getState().homeCatalogSettings;

        let allItems: StremioMetaPreview[] = [];

        if (raw.length > 0) {
          // Process configured hero entries
          const entries: any[] = raw.map((e: any) =>
            typeof e === 'string' ? { key: e, baseUrl: '' } : e
          );

          const promises = entries.map(async (entry) => {
            const isCollection = entry.isCollection || entry.key?.startsWith('collection_');
            if (isCollection) {
              const collectionId = entry.collectionId || entry.key?.replace('collection_', '');
              const coll = allCollections.find(c => c.id === collectionId);
              if (!coll) return [] as StremioMetaPreview[];
              return resolveCollectionsForHero([coll], addons, 15);
            }

            if (!entry.baseUrl) return [] as StremioMetaPreview[];
            const parts = entry.key.split(':');
            const type = parts[parts.length - 2];
            const catalogId = parts[parts.length - 1];
            try {
              const resp = await fetchCatalog(entry.baseUrl, type, catalogId, { limit: '15' });
              return (resp?.metas || []).filter((m: StremioMetaPreview) => m.background || m.poster);
            } catch {
              return [] as StremioMetaPreview[];
            }
          });

          const results = await Promise.all(promises);
          const maxLen = Math.max(0, ...results.map((r) => r.length));
          for (let i = 0; i < maxLen; i++) {
            for (let j = 0; j < results.length; j++) {
              if (i < results[j].length) {
                allItems.push(results[j][i]);
              }
            }
          }
        }

        // If no items were produced from configured sources (or no sources configured)
        if (allItems.length === 0) {
          // If no sources configured, attempt auto-populating from addon catalogs if available
          if (raw.length === 0) {
            const autoSources: any[] = [];
            for (const addon of addons) {
              if (autoSources.length >= 2) break;
              for (const catalog of addon.manifest?.catalogs || []) {
                if (autoSources.length >= 2) break;
                if (catalog.extra?.some((e: any) => e.isRequired)) continue;
                const key = `${addon.manifest?.id || addon.id}:${catalog.type}:${catalog.id}`;
                autoSources.push({ key, baseUrl: addon.baseUrl });
              }
            }

            if (autoSources.length > 0) {
              const promises = autoSources.map(async (entry) => {
                const parts = entry.key.split(':');
                const type = parts[parts.length - 2];
                const catalogId = parts[parts.length - 1];
                try {
                  const resp = await fetchCatalog(entry.baseUrl, type, catalogId, { limit: '15' });
                  return (resp?.metas || []).filter((m: StremioMetaPreview) => m.background || m.poster);
                } catch {
                  return [] as StremioMetaPreview[];
                }
              });
              const results = await Promise.all(promises);
              const maxLen = Math.max(0, ...results.map((r) => r.length));
              for (let i = 0; i < maxLen; i++) {
                for (let j = 0; j < results.length; j++) {
                  if (i < results[j].length) {
                    allItems.push(results[j][i]);
                  }
                }
              }
            }
          }

          // Fallback to Collections (mirrors Nuvio Desktop ensureCollectionHeroFallback)
          if (allItems.length === 0 && allCollections.length > 0) {
            const settingsItems = homeCatalogSettings?.items || [];
            // Filter collections that are not explicitly disabled in settings
            const enabledCollections = allCollections.filter(coll => {
              if (!coll.folders || coll.folders.length === 0) return false;
              const pref = settingsItems.find(
                (s: any) => (s.is_collection || s.isCollection) && (s.collection_id === coll.id || s.collectionId === coll.id)
              );
              return pref ? pref.enabled !== false : true;
            });

            if (enabledCollections.length > 0) {
              allItems = await resolveCollectionsForHero(enabledCollections, addons, 15);
            }
          }
        }

        // Deduplicate by type:id
        const seen = new Set<string>();
        const unique = allItems.filter(item => {
          const key = `${item.type}:${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        if (active) {
          setItems(unique.slice(0, 15));
          setLoading(false);
        }
      } catch (err) {
        console.error('[NuvioHeroBanner] Error loading hero items:', err);
        if (active) setLoading(false);
      }
    };

    loadHeroItems();
    return () => { active = false; };
  }, [refreshKey]);

  // Reset activeIndex when items change
  useEffect(() => {
    setActiveIndex(0);
  }, [items]);

  // Reset logo error when changing active index
  useEffect(() => {
    setLogoError(false);
  }, [activeIndex]);

  // Handle slideshow auto-cycle
  useEffect(() => {
    if (loading || items.length <= 1 || isHovered) {
      if (autoCycleRef.current) clearInterval(autoCycleRef.current);
      return;
    }

    autoCycleRef.current = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % items.length);
    }, 10000);

    return () => {
      if (autoCycleRef.current) clearInterval(autoCycleRef.current);
    };
  }, [items, loading, isHovered]);

  const handlePrev = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveIndex((prev) => (prev - 1 + items.length) % items.length);
  }, [items.length]);

  const handleNext = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveIndex((prev) => (prev + 1) % items.length);
  }, [items.length]);

  const handleAddToLibrary = useCallback((e: React.MouseEvent, item: StremioMetaPreview) => {
    e.stopPropagation();
    onAddToLibrary(item);
  }, [onAddToLibrary]);

  if (loading) {
    return (
      <div className="stremio-hero-banner skeleton">
        <div className="stremio-hero-overlay-left" />
        <div className="stremio-hero-overlay-bottom" />
        <div className="stremio-hero-content">
          <div className="skeleton-logo" />
          <div className="skeleton-meta">
            <div className="skeleton-pill" style={{ width: '80px' }} />
            <div className="skeleton-pill" style={{ width: '50px' }} />
            <div className="skeleton-pill" style={{ width: '70px' }} />
          </div>
          <div className="skeleton-desc" />
          <div className="skeleton-desc" style={{ width: '60%' }} />
          <div className="skeleton-btn" />
        </div>
      </div>
    );
  }

  if (items.length === 0) return null;

  const activeItem = items[activeIndex];
  const backdropUrl = activeItem.background || activeItem.poster;
  const isAdded = libraryIds.has(activeItem.id);

  return (
    <div
      className="stremio-hero-banner"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {backdropUrl && (
        <img
          key={activeItem.id}
          src={backdropUrl}
          alt=""
          className="stremio-hero-backdrop"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      )}

      <div className="stremio-hero-overlay-left" />
      <div className="stremio-hero-overlay-bottom" />
      <div className="stremio-hero-overlay-vignette" />

      {items.length > 1 && (
        <>
          <button className="stremio-hero-nav-arrow left" onClick={handlePrev} aria-label={i18n.t('nuvio:prevSpotlight')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button className="stremio-hero-nav-arrow right" onClick={handleNext} aria-label={i18n.t('nuvio:nextSpotlight')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </>
      )}

      <div className="stremio-hero-content" key={`content-${activeItem.id}`}>
        {activeItem.logo && !logoError ? (
          <img
            src={activeItem.logo}
            alt={activeItem.name}
            className="stremio-hero-logo"
            decoding="async"
            onError={() => setLogoError(true)}
          />
        ) : (
          <h1 className="stremio-hero-title">{activeItem.name}</h1>
        )}

        <div className="stremio-hero-meta">
          {activeItem.imdbRating && (
            <div className="stremio-hero-meta-badge rating">
              <svg viewBox="0 0 24 24" fill="currentColor" className="star-icon">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
              <span>{activeItem.imdbRating}</span>
            </div>
          )}
          {activeItem.releaseInfo && (
            <span className="stremio-hero-meta-text">{activeItem.releaseInfo}</span>
          )}
          <span className="stremio-hero-meta-text type-badge">
            {activeItem.type === 'movie' ? i18n.t('nuvio:movie') : activeItem.type === 'series' ? i18n.t('nuvio:series') : activeItem.type}
          </span>
          {activeItem.runtime && (
            <span className="stremio-hero-meta-text">{activeItem.runtime}</span>
          )}
        </div>

        {activeItem.genres && activeItem.genres.length > 0 && (
          <div className="stremio-hero-genres">
            {activeItem.genres.slice(0, 4).map((genre) => (
              <span key={genre} className="stremio-hero-genre-tag">{genre}</span>
            ))}
          </div>
        )}

        {activeItem.description && (
          <p className="stremio-hero-description" title={activeItem.description}>
            {activeItem.description}
          </p>
        )}

        <div className="stremio-hero-actions">
          <button className="stremio-hero-btn-watch" onClick={() => onItemClick(activeItem)}>
            <svg viewBox="0 0 24 24" fill="currentColor" className="btn-icon">
              <path d="M8 5v14l11-7z" />
            </svg>
            {i18n.t('nuvio:watchNow')}
          </button>
          <button
            className={`stremio-hero-btn-watchlist ${isAdded ? 'in-watchlist' : ''}`}
            onClick={(e) => {
              if (!isAdded) handleAddToLibrary(e, activeItem);
            }}
          >
            {isAdded ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="btn-icon">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                {i18n.t('nuvio:inLibrary')}
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="btn-icon">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                {i18n.t('nuvio:addToLibrary')}
              </>
            )}
          </button>
        </div>
      </div>

      {items.length > 1 && (
        <div className="stremio-hero-indicators">
          {items.map((_, idx) => (
            <button
              key={idx}
              className={`stremio-hero-indicator-dot ${idx === activeIndex ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveIndex(idx);
              }}
              aria-label={i18n.t('nuvio:goToSlide', { index: idx + 1 })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
