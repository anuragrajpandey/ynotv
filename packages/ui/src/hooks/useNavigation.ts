import { useState, useEffect, useCallback, useRef } from 'react';
import type { SettingsTabId } from '../components/settings/SettingsSidebar';
import { Bridge } from '../services/tauri-bridge';

export type View = 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'settings' | 'stremio' | 'nuvio';

// Auto-hide controls after this many milliseconds of inactivity
const CONTROLS_AUTO_HIDE_MS = 3000;

export interface NavigationState {
  // View state
  activeView: View;
  settingsTab: SettingsTabId;
  editSourceId: string | null;
  showSettingsPopup: boolean;
  pendingSettingsSubTab: string | null;
  setPendingSettingsSubTab: (subTab: string | null | ((prev: string | null) => string | null)) => void;

  // Categories state
  categoriesOpen: boolean;

  // Search state
  searchQuery: string;
  debouncedSearchQuery: string;
  isSearchMode: boolean;

  // Watchlist mode
  isWatchlistMode: boolean;

  // Controls visibility
  showControls: boolean;
  controlsHoveredRef: React.MutableRefObject<boolean>;

  // Refs
  titleBarSearchRef: React.RefObject<HTMLInputElement | null>;
  activeViewRef: React.MutableRefObject<View>;
  categoriesOpenRef: React.MutableRefObject<boolean>;

  // Actions
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

  // View state
  const [activeView, setActiveView] = useState<View>('none');
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>('sources');
  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [showSettingsPopup, setShowSettingsPopup] = useState(false);
  const [pendingSettingsSubTab, setPendingSettingsSubTab] = useState<string | null>(null);

  // Categories state
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);

  // Watchlist mode
  const [isWatchlistMode, setIsWatchlistMode] = useState(categoryId === '__watchlist__');

  // Keep watchlist mode in sync when categoryId changes externally (e.g. initial load or defaultCategory)
  useEffect(() => {
    setIsWatchlistMode(categoryId === '__watchlist__');
  }, [categoryId]);

  // Controls visibility
  const [showControls, setShowControls] = useState(true);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const controlsHoveredRef = useRef(false);

  // Refs for title bar search input
  const titleBarSearchRef = useRef<HTMLInputElement | null>(null);

  // Refs for keyboard shortcuts
  const activeViewRef = useRef(activeView);
  const categoriesOpenRef = useRef(categoriesOpen);

  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => { categoriesOpenRef.current = categoriesOpen; }, [categoriesOpen]);

  // Debounce search query for performance
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
      setIsSearchMode(searchQuery.length >= 2);
    }, 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Listen for open-settings custom event (from TV Calendar, etc.)
  useEffect(() => {
    const handleOpenSettings = (e: Event) => {
      const customEvent = e as CustomEvent<{ tab?: SettingsTabId; subTab?: string }>;
      console.log('[useNavigation] Received open-settings event:', customEvent.detail);
      if (customEvent.detail?.tab) {
        setSettingsTab(customEvent.detail.tab);
      }
      if (customEvent.detail?.subTab) {
        setPendingSettingsSubTab(customEvent.detail.subTab);
      }
      setShowSettingsPopup(true);
    };
    window.addEventListener('open-settings', handleOpenSettings);
    return () => window.removeEventListener('open-settings', handleOpenSettings);
  }, []);

  const multiviewLayoutRef = useRef(multiviewLayout);
  useEffect(() => { multiviewLayoutRef.current = multiviewLayout; }, [multiviewLayout]);

  // Ensure video software scaling is reset when completely exiting tab views
  useEffect(() => {
    if (activeView === 'none') {
      Bridge.setProperty('video-zoom', 0).catch(() => { });
      Bridge.setProperty('video-align-x', 0).catch(() => { });
      Bridge.setProperty('video-align-y', 0).catch(() => { });
    }
  }, [activeView]);

  // Auto-hide controls after inactivity
  useEffect(() => {
    if (overlayOnClickOnly) return;
    if (!playing || activeView !== 'none' || categoriesOpen) return;

    const timer = setTimeout(() => {
      if (!controlsHoveredRef.current) {
        setShowControls(false);
      }
    }, (overlayAutohideTimer ?? 3) * 1000);

    return () => clearTimeout(timer);
  }, [lastActivity, playing, activeView, categoriesOpen, overlayAutohideTimer, overlayOnClickOnly]);

  // Show controls on mouse move and reset hide timer
  const handleMouseMove = useCallback(() => {
    if (overlayOnClickOnly && playing && activeView === 'none') {
      return;
    }
    setShowControls(true);
    setLastActivity(Date.now());
  }, [overlayOnClickOnly, playing, activeView]);

  // Handle category selection - opens guide if closed
  const handleSelectCategory = useCallback((catId: string | null) => {
    setCategoryId(catId);

    if (catId === '__watchlist__') {
      setIsWatchlistMode(true);
      setIsSearchMode(false);
      setSearchQuery('');
    } else {
      setIsWatchlistMode(false);
    }

    if (activeView !== 'guide') {
      setActiveView('guide');
    }
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
