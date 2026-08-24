import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstalledAddon } from '../../types/stremio';
import { useStremioAuthStore } from '../../stores/stremioAuthStore';
import {
  useStremioSearchQuery,
  useSetStremioSearchQuery,
  useStremioSelectedAddonId,
  useSetStremioSelectedAddonId,
  useStremioSelectedCatalogId,
  useSetStremioSelectedCatalogId,
  useStremioSelectedCatalogType,
  useSetStremioSelectedCatalogType,
  useStremioSelectedCloudCatalogKey,
  useSetStremioSelectedCloudCatalogKey,
  useStremioView,
  useSetStremioView,
  useUIStore,
} from '../../stores/uiStore';
import { useSearchHistory } from '../../hooks/useSearchHistory';
import { PosterSizeSlider } from '../PosterSizeSlider';
import { KeyboardSearchInput } from '../KeyboardSearchInput';
import './StremioTopbar.css';

interface StremioTopbarProps {
  addons: InstalledAddon[];
  onOpenAddonManager: () => void;
  onOpenAccount: () => void;
}

export function StremioTopbar({ addons, onOpenAddonManager, onOpenAccount }: StremioTopbarProps) {
  const { t } = useTranslation('stremio');
  const { authKey, user } = useStremioAuthStore();
  const selectedAddonId = useStremioSelectedAddonId();
  const setSelectedAddonId = useSetStremioSelectedAddonId();
  const selectedCatalogId = useStremioSelectedCatalogId();
  const setSelectedCatalogId = useSetStremioSelectedCatalogId();
  const selectedCatalogType = useStremioSelectedCatalogType();
  const setSelectedCatalogType = useSetStremioSelectedCatalogType();
  const selectedCloudCatalogKey = useStremioSelectedCloudCatalogKey();
  const setSelectedCloudCatalogKey = useSetStremioSelectedCloudCatalogKey();
  const setView = useSetStremioView();
  const view = useStremioView();
  const searchQuery = useStremioSearchQuery();
  const setSearchQuery = useSetStremioSearchQuery();
  const [inputValue, setInputValue] = useState(searchQuery);
  const stremioSearchHistory = useSearchHistory('stremio');
  const [showStremioHistory, setShowStremioHistory] = useState(false);
  const stremioHistoryRef = useRef<HTMLDivElement | null>(null);

  const stremioPosterSize = useUIStore((s) => s.stremioPosterSize);
  const setStremioPosterSize = useUIStore((s) => s.setStremioPosterSize);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (stremioHistoryRef.current && !stremioHistoryRef.current.contains(e.target as Node)) {
        setShowStremioHistory(false);
      }
    };
    if (showStremioHistory) {
      document.addEventListener('mousedown', handleClick);
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showStremioHistory]);

  const isHomeActive = view === 'home' && !selectedAddonId && !selectedCatalogId && !selectedCloudCatalogKey;
  const isDiscoverActive = view === 'home' && (!!selectedCloudCatalogKey || (!!selectedAddonId && !!selectedCatalogId));
  const isLibraryActive = view === 'library';
  const isCalendarActive = view === 'calendar';
  const isSettingsActive = view === 'settings';

  const handleHomeClick = () => {
    setSelectedAddonId(null);
    setSelectedCatalogId(null);
    setSelectedCatalogType(null);
    setSelectedCloudCatalogKey(null);
    setView('home');
  };

  const handleDiscoverClick = () => {
    setView('home');
    const hasAddonSelection = selectedAddonId && selectedCatalogId && selectedCatalogType;
    const hasCloudSelection = selectedCloudCatalogKey;
    if (!hasAddonSelection && !hasCloudSelection) {
      // Prefer addon catalog first
      const firstAddon = addons.find((a) => (a.manifest.catalogs?.length ?? 0) > 0);
      const firstCat = firstAddon?.manifest.catalogs?.[0];
      if (firstAddon && firstCat) {
        setSelectedAddonId(firstAddon.id);
        setSelectedCatalogId(firstCat.id);
        setSelectedCatalogType(firstCat.type);
        setSelectedCloudCatalogKey(null);
      }
      // If no addon catalogs, cloud catalogs are discoverable via CloudCatalogDetailView's dropdown
    }
  };

  const handleLibraryClick = () => {
    setView('library');
  };

  const handleCalendarClick = () => {
    setView('calendar');
  };

  const handleSettingsClick = () => {
    setView('settings');
  };

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = inputValue.trim();
      if (val) {
        stremioSearchHistory.addToHistory(val);
      }
      setSearchQuery(val);
      setShowStremioHistory(false);
      if (val.length >= 2) {
        setView('search');
      } else {
        setView('home');
      }
    }
  }, [inputValue, setSearchQuery, setView, stremioSearchHistory]);

  const handleSearchClear = useCallback(() => {
    setInputValue('');
    setSearchQuery('');
    setView('home');
  }, [setSearchQuery, setView]);

  return (
    <div className="stremio-topbar">
      {/* Brand logo & name */}
      <div className="stremio-topbar-left">
        <div className="stremio-brand">
          <svg className="stremio-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="2" y="7" width="20" height="14" rx="3" />
            <path d="M17 2l-5 5-5-5" />
          </svg>
          <span className="stremio-brand-name">Strem</span>
        </div>
        <PosterSizeSlider value={stremioPosterSize} onChange={setStremioPosterSize} />
      </div>

      {/* Centered navigation items */}
      <div className="stremio-topbar-center">
        <button
          className={`stremio-topbar-item ${isHomeActive ? 'active' : ''}`}
          onClick={handleHomeClick}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="stremio-topbar-icon">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span>{t('home')}</span>
        </button>

        <button
          className={`stremio-topbar-item ${isDiscoverActive ? 'active' : ''}`}
          onClick={handleDiscoverClick}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="stremio-topbar-icon">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>{t('discover')}</span>
        </button>

        <button
          className={`stremio-topbar-item ${isLibraryActive ? 'active' : ''}`}
          onClick={handleLibraryClick}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="stremio-topbar-icon">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>{t('library')}</span>
        </button>

        <button
          className={`stremio-topbar-item ${isCalendarActive ? 'active' : ''}`}
          onClick={handleCalendarClick}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="stremio-topbar-icon">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>{t('calendar')}</span>
        </button>

        <button className="stremio-topbar-item stremio-topbar-addons-btn" onClick={onOpenAddonManager}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="stremio-topbar-icon">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{t('manageAddons')}</span>
        </button>

        <button
          className={`stremio-topbar-item ${isSettingsActive ? 'active' : ''}`}
          onClick={handleSettingsClick}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="stremio-topbar-icon">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{t('settings')}</span>
        </button>

        {authKey ? (
          <button className="stremio-topbar-item stremio-topbar-account-btn logged-in" onClick={onOpenAccount}>
            <div className="stremio-topbar-avatar">
              {user?.fullname ? user.fullname.charAt(0).toUpperCase() : user?.email.charAt(0).toUpperCase() || 'U'}
            </div>
            <span>{t('account')}</span>
          </button>
        ) : (
          <button className="stremio-topbar-item stremio-topbar-account-btn" onClick={onOpenAccount}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="stremio-topbar-icon">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>{t('logIn')}</span>
          </button>
        )}
      </div>

      {/* Right aligned search bar */}
      <div className="stremio-topbar-right">
        <div className="stremio-topbar-search">
          <div className="stremio-topbar-search-input-wrap">
            <svg className="stremio-topbar-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <KeyboardSearchInput
              className="stremio-topbar-search-input"
              placeholder={t('search')}
              value={inputValue}
              onValueChange={setInputValue}
              onFocus={() => setShowStremioHistory(true)}
              onKeyDown={handleSearchKeyDown}
              onSubmit={(v) => {
                const val = v.trim();
                if (val) {
                  stremioSearchHistory.addToHistory(val);
                }
                setSearchQuery(val);
                setShowStremioHistory(false);
                if (val.length >= 2) {
                  setView('search');
                } else {
                  setView('home');
                }
              }}
            />
            {inputValue && (
              <button className="stremio-topbar-search-clear" onClick={handleSearchClear}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          {showStremioHistory && stremioSearchHistory.history.length > 0 && (
            <div className="stremio-topbar-search-history" ref={stremioHistoryRef}>
              {stremioSearchHistory.history.map((item) => (
                <div
                  key={item}
                  className="stremio-topbar-search-history-item"
                  onMouseDown={() => {
                    setInputValue(item);
                    setSearchQuery(item);
                    setShowStremioHistory(false);
                    if (item.length >= 2) {
                      setView('search');
                    } else {
                      setView('home');
                    }
                  }}
                >
                  <svg className="stremio-topbar-search-history-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span className="stremio-topbar-search-history-text">{item}</span>
                  <button
                    className="stremio-topbar-search-history-remove"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      stremioSearchHistory.removeFromHistory(item);
                    }}
                    title={t('remove')}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              <div
                className="stremio-topbar-search-history-clear-all"
                onMouseDown={() => {
                  stremioSearchHistory.clearHistory();
                  setShowStremioHistory(false);
                }}
              >
                {t('clearSearchHistory')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
