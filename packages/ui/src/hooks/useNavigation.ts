import { useState, useEffect, useCallback, useRef } from 'react';
import type { SettingsTabId } from '../components/settings/SettingsSidebar';
import { Bridge } from '../services/tauri-bridge';

export type View = 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'settings' | 'stremio' | 'nuvio';

const CONTROLS_AUTO_HIDE_MS = 3000;

export interface NavigationState {
  activeView: View;
  settingsTab: SettingsTabId;
  editSourceId: string | null;
  showSettingsPopup: boolean;
  pendingSettingsSubTab: string | null;
  setPendingSettingsSubTab: (subTab: string | null | ((prev: string | null) => string | null)) => void;
  categoriesOpen: boolean;
  searchQuery: string;
  debouncedSearchQuery: string;
  isSearchMode: boolean;
  isWatchlistMode: boolean;
  showControls: boolean;
  controlsHoveredRef: React.MutableRefObject<boolean>;
  titleBarSearchRef: React.RefObject<HTMLInputElement | null>;
  activeViewRef: React.MutableRefObject<View>;
  categoriesOpenRef: React.MutableRefObject<boolean>;
  setActiveView: (view: View | ((prev: View) => View)) => void;
  setSettingsTab: (tab: SettingsTabId | ((prev: SettingsTabId) => SettingsTabId)) => void;
  setEditSourceId: (id: string | null | ((prev: string | null) => string | null)) => void;
  setShowSettingsPopup: (show: boolean | ((prev: boolean) => boolean)) => void;
  setCategoriesOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSearchQuery: (query: string | ((prev: string) => string)) => void;
  setIsWatchlistMode: (isWatchlist: boolean | ((prev: boolean) => boolean)) => void;
  setShowControls: (show: boolean | ((prev: boolean) => boolean)) => void;
  handleSelectCategory: (catId: string | null) => void;
  handleMouseMove: () => void;
}

interface UseNavigationOptions {
  playing: boolean;
  multiviewLayout: import('./useLayoutPersistence').LayoutMode;
  categoryId?: string | null;
  setCategoryId: (catId: string | null) => void;
  overlayAutohideTimer: number;
  overlayOnClickOnly: boolean;
}

export function useNavigation(options: UseNavigationOptions): NavigationState {
  const { playing, multiviewLayout, categoryId, setCategoryId, overlayAutohideTimer, overlayOnClickOnly } = options;

  // Start on Movies instead of the upstream blank/none view.
  const [activeView, setActiveView] = useState<View>('movies');
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('sources');
  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [showSettingsPopup, setShowSettingsPopup] = useState(false);
  const [pendingSettingsSubTab, setPendingSettingsSubTab] = useState<string | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [isWatchlistMode, setIsWatchlistMode] = useState(categoryId === '__watchlist__');

  useEffect(() => {
    setIsWatchlistMode(categoryId === '__watchlist__');
  }, [categoryId]);

  const [showControls, setShowControls] = useState(true);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const controlsHoveredRef = useRef(false);
  const titleBarSearchRef = useRef<HTMLInputElement | null>(null);
  const activeViewRef = useRef(activeView);
  const categoriesOpenRef = useRef(categoriesOpen);

  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => { categoriesOpenRef.current = categoriesOpen; }, [categoriesOpen]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
      setIsSearchMode(searchQuery.length >= 2);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const handleOpenSettings = (e: Event) => {
      const customEvent = e as CustomEvent<{ tab?: SettingsTabId; subTab?: string }>;
      console.log('[useNavigation] Received open-settings event:', customEvent.detail);
      if (customEvent.detail?.tab) setSettingsTab(customEvent.detail.tab);
      if (customEvent.detail?.subTab) setPendingSettingsSubTab(customEvent.detail.subTab);
      setShowSettingsPopup(true);
    };
    window.addEventListener('open-settings', handleOpenSettings);
    return () => window.removeEventListener('open-settings', handleOpenSettings);
  }, []);

  const multiviewLayoutRef = useRef(multiviewLayout);
  useEffect(() => { multiviewLayoutRef.current = multiviewLayout; }, [multiviewLayout]);

  useEffect(() => {
    if (activeView === 'none') {
      Bridge.setProperty('video-zoom', 0).catch(() => { });
      Bridge.setProperty('video-align-x', 0).catch(() => { });
      Bridge.setProperty('video-align-y', 0).catch(() => { });
    }
  }, [activeView]);

  useEffect(() => {
    if (overlayOnClickOnly) return;
    if (!playing || activeView !== 'none' || categoriesOpen) return;
    const timer = setTimeout(() => {
      if (!controlsHoveredRef.current) setShowControls(false);
    }, (overlayAutohideTimer ?? 3) * 1000);
    return () => clearTimeout(timer);
  }, [lastActivity, playing, activeView, categoriesOpen, overlayAutohideTimer, overlayOnClickOnly]);

  const handleMouseMove = useCallback(() => {
    if (overlayOnClickOnly && playing && activeView === 'none') return;
    setShowControls(true);
    setLastActivity(Date.now());
  }, [overlayOnClickOnly, playing, activeView]);

  const handleSelectCategory = useCallback((catId: string | null) => {
    setCategoryId(catId);
    if (catId === '__watchlist__') {
      setIsWatchlistMode(true);
      setIsSearchMode(false);
      setSearchQuery('');
    } else {
      setIsWatchlistMode(false);
    }
    if (activeView !== 'guide') setActiveView('guide');
  }, [activeView, setCategoryId]);

  return {
    activeView,
    settingsTab,
    editSourceId,
    showSettingsPopup,
    pendingSettingsSubTab,
    setPendingSettingsSubTab,
    categoriesOpen,
    searchQuery,
    debouncedSearchQuery,
    isSearchMode,
    isWatchlistMode,
    showControls,
    controlsHoveredRef,
    titleBarSearchRef,
    activeViewRef,
    categoriesOpenRef,
    setActiveView,
    setSettingsTab,
    setEditSourceId,
    setShowSettingsPopup,
    setCategoriesOpen,
    setSearchQuery,
    setIsWatchlistMode,
    setShowControls,
    handleSelectCategory,
    handleMouseMove,
  };
}
