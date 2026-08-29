import { useSetChannelSortOrder, useSetCategorySortOrder, useSetIncludeAllChannelsToPlaylist, useSidebarDragHotkey, useSetSidebarDragHotkey } from '../../stores/uiStore';
import { MAX_SEARCH_RESULTS_LIMIT, useSettingsStore } from '../../stores/settingsStore';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { useCategoriesBySource } from '../../hooks/useChannels';
import { db, type CustomGroup } from '../../db';
import { DefaultCategoryModal, defaultCategoryDisplayLabel, DEFAULT_CATEGORY_LAST } from './DefaultCategoryModal';
import { useEffect, useMemo, useState } from 'react';
import type { Source } from '@ynotv/core';
import './PlaybackTab.css'; // Reuse existing tab styles for toggle
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface ChannelsTabProps {
  channelSortOrder: 'alphabetical' | 'number' | 'provider';
  onChannelSortOrderChange: (order: 'alphabetical' | 'number' | 'provider') => void;
  categorySortOrder: 'default' | 'alphabetical';
  onCategorySortOrderChange: (order: 'default' | 'alphabetical') => void;
  includeSourceInSearch: boolean;
  onIncludeSourceInSearchChange: (enabled: boolean) => void;
  includeSourceInVodSearch: boolean;
  onIncludeSourceInVodSearchChange: (enabled: boolean) => void;
  maxSearchResults: number;
  onMaxSearchResultsChange: (limit: number) => void;
  searchResultsOrder: 'default' | 'alphabetical';
  onSearchResultsOrderChange: (order: 'default' | 'alphabetical') => void;
  includeAllChannelsToPlaylist: boolean;
  onIncludeAllChannelsToPlaylistChange: (enabled: boolean) => void;
  onOpenChannelProbe?: () => void;
  showMode?: 'sort-order' | 'search' | 'all';
}

async function saveIncludeSourceInSearch(enabled: boolean) {
  if (!window.storage) return;
  await window.storage.updateSettings({ includeSourceInSearch: enabled });
}

async function saveIncludeSourceInVodSearch(enabled: boolean) {
  if (!window.storage) return;
  await window.storage.updateSettings({ includeSourceInVodSearch: enabled });
}

async function saveMaxSearchResults(limit: number) {
  if (!window.storage) return;
  await window.storage.updateSettings({ maxSearchResults: limit });
}

async function saveSearchResultsOrder(order: 'default' | 'alphabetical') {
  if (!window.storage) return;
  await window.storage.updateSettings({ searchResultsOrder: order });
}

async function saveIncludeAllChannelsToPlaylist(enabled: boolean) {
  if (!window.storage) return;
  await window.storage.updateSettings({ includeAllChannelsToPlaylist: enabled });
}

export function ChannelsTab({
  channelSortOrder,
  onChannelSortOrderChange,
  categorySortOrder,
  onCategorySortOrderChange,
  includeSourceInSearch,
  onIncludeSourceInSearchChange,
  includeSourceInVodSearch,
  onIncludeSourceInVodSearchChange,
  maxSearchResults,
  onMaxSearchResultsChange,
  searchResultsOrder,
  onSearchResultsOrderChange,
  includeAllChannelsToPlaylist,
  onIncludeAllChannelsToPlaylistChange,
  onOpenChannelProbe,
  showMode = 'all',
}: ChannelsTabProps) {
  useTranslation();
  const setChannelSortOrder = useSetChannelSortOrder();
  const setCategorySortOrder = useSetCategorySortOrder();
  const setIncludeAllChannelsToPlaylist = useSetIncludeAllChannelsToPlaylist();
  const sidebarDragHotkey = useSidebarDragHotkey();
  const setSidebarDragHotkey = useSetSidebarDragHotkey();

  // Default category picker — mirrors the LiveTV sidebar list/order.
  const groupedCategories = useCategoriesBySource();
  const customGroups = useLiveQuery<CustomGroup[]>(
    () => db.customGroups.orderBy('display_order').toArray(),
    []
  ) ?? [];
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    (async () => {
      if (!window.storage) return;
      const result = await window.storage.getSources();
      if (!disposed && result.data) {
        const map: Record<string, string> = {};
        result.data.forEach((s: Source) => { map[s.id] = s.name; });
        setSourceNames(map);
      }
    })();
    return () => { disposed = true; };
  }, []);
  const [showDefaultCategoryModal, setShowDefaultCategoryModal] = useState(false);
  const defaultCategory = useSettingsStore((s) => s.defaultCategory);
  const setDefaultCategory = useSettingsStore((s) => s.setDefaultCategory);
  const defaultCategoryLabel = useMemo(
    () => defaultCategoryDisplayLabel(defaultCategory, {
      grouped: groupedCategories,
      customGroups,
      sourceNames,
    }),
    [defaultCategory, groupedCategories, customGroups, sourceNames]
  );

  async function handleSortOrderChange(order: 'alphabetical' | 'number' | 'provider') {
    onChannelSortOrderChange(order);
    setChannelSortOrder(order); // Update global store immediately
    if (!window.storage) return;
    await window.storage.updateSettings({ channelSortOrder: order });
  }

  async function handleCategorySortOrderChange(order: 'default' | 'alphabetical') {
    onCategorySortOrderChange(order);
    setCategorySortOrder(order); // Update global store immediately
    if (!window.storage) return;
    await window.storage.updateSettings({ categorySortOrder: order });
  }

  const showSortOrder = showMode === 'all' || showMode === 'sort-order';
  const showSearch = showMode === 'all' || showMode === 'search';

  return (
    <div>
      {showSortOrder && (
        <>
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:livetv.channels.probeSection')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:livetv.channels.probeSectionSub')}
            </p>
            <div style={{ marginTop: '12px' }}>
              <button
                type="button"
                className="save-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '9px 18px', cursor: 'pointer' }}
                onClick={() => {
                  if (onOpenChannelProbe) {
                    onOpenChannelProbe();
                  } else if (typeof (window as any).openChannelProbe === 'function') {
                    (window as any).openChannelProbe();
                  }
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <circle cx="12" cy="12" r="2" />
                  <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
                </svg>
                {i18n.t('settings:livetv.channels.launchProbe')}
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:livetv.channels.channelDisplay')}</h3>
            </div>

            <p className="section-description">
              {i18n.t('settings:livetv.channels.channelDisplaySub')}
            </p>

            <div className="refresh-settings">
              <div className="form-group inline">
                <label>{i18n.t('settings:livetv.channels.sortOrder')}</label>
                <select
                  value={channelSortOrder}
                  onChange={(e) => handleSortOrderChange(e.target.value as 'alphabetical' | 'number' | 'provider')}
                >
                  <option value="provider">{i18n.t('settings:livetv.channels.providerOption')}</option>
                  <option value="alphabetical">{i18n.t('settings:livetv.channels.alphabeticalOption')}</option>
                  <option value="number">{i18n.t('settings:livetv.channels.channelNumberOption')}</option>
                </select>
              </div>
            </div>

            <p className="form-hint" style={{ marginTop: '0.75rem' }}>
              {i18n.t('settings:livetv.channels.providerHint')}
              <br />
              {i18n.t('settings:livetv.channels.alphabeticalHint')}
              <br />
              {i18n.t('settings:livetv.channels.channelNumberHint')}
              {i18n.t('settings:livetv.channels.noNumberHint')}
            </p>
          </div>

          <div className="settings-section" style={{ marginTop: '24px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:livetv.channels.categoryDisplay')}</h3>
            </div>

            <p className="section-description">
              {i18n.t('settings:livetv.channels.categoryDisplaySub')}
            </p>

            <div className="refresh-settings">
              <div className="form-group inline">
                <label>{i18n.t('settings:livetv.channels.sortOrder')}</label>
                <select
                  value={categorySortOrder}
                  onChange={(e) => handleCategorySortOrderChange(e.target.value as 'default' | 'alphabetical')}
                >
                  <option value="default">{i18n.t('common:default')}</option>
                  <option value="alphabetical">{i18n.t('settings:livetv.channels.alphabeticalOption')}</option>
                </select>
              </div>
            </div>

            <p className="form-hint" style={{ marginTop: '0.75rem' }}>
              {i18n.t('settings:livetv.channels.defaultHint')}
              {i18n.t('settings:livetv.channels.alphabeticalCategoryHint')}
            </p>

            {/* Default Category */}
            <div className="refresh-settings" style={{ marginTop: '20px' }}>
              <div className="form-group inline">
                <label>{i18n.t('settings:livetv.channels.defaultCategory')}</label>
                <button
                  type="button"
                  className="save-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '9px 18px', cursor: 'pointer', fontWeight: 500 }}
                  onClick={() => setShowDefaultCategoryModal(true)}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '260px' }}>
                    {defaultCategoryLabel}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ flexShrink: 0 }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                {i18n.t('settings:livetv.channels.defaultCategorySub')}
              </p>
            </div>

            <div className="refresh-settings" style={{ marginTop: '16px' }}>
              <div className="form-group inline">
                <label>{i18n.t('settings:livetv.channels.sidebarDragHotkey')}</label>
                <select
                  value={sidebarDragHotkey}
                  onChange={(e) => setSidebarDragHotkey(e.target.value as any)}
                >
                  <option value="Control">{i18n.t('settings:livetv.channels.ctrlDefault')}</option>
                  <option value="Alt">{i18n.t('settings:livetv.channels.altOption')}</option>
                  <option value="Shift">{i18n.t('settings:livetv.channels.shiftOption')}</option>
                  <option value="Meta">{i18n.t('settings:livetv.channels.metaOption')}</option>
                  <option value="None">{i18n.t('settings:livetv.channels.noneOption')}</option>
                </select>
              </div>
            </div>

            <p className="form-hint" style={{ marginTop: '0.75rem' }}>
              {i18n.t('settings:livetv.channels.dragHint')}
            </p>

            <div className="timeshift-settings" style={{ marginTop: '20px' }}>
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:livetv.channels.includeAllChannels')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:livetv.channels.includeAllChannelsSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={includeAllChannelsToPlaylist}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      onIncludeAllChannelsToPlaylistChange(enabled);
                      setIncludeAllChannelsToPlaylist(enabled);
                      saveIncludeAllChannelsToPlaylist(enabled);
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          </div>
        </>
      )}

      <DefaultCategoryModal
        isOpen={showDefaultCategoryModal}
        current={defaultCategory || DEFAULT_CATEGORY_LAST}
        grouped={groupedCategories}
        customGroups={customGroups}
        sourceNames={sourceNames}
        onClose={() => setShowDefaultCategoryModal(false)}
        onSelect={(mode) => setDefaultCategory(mode)}
      />

      {showSearch && (
        <div className="settings-section" style={{ marginTop: showSortOrder ? '24px' : '0' }}>
          <div className="section-header">
            <h3>{i18n.t('settings:livetv.channels.searchTitle')}</h3>
          </div>

          <p className="section-description">
            {i18n.t('settings:livetv.channels.searchSub')}
          </p>

          <div className="timeshift-settings">
            <div className="timeshift-toggle-row">
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:livetv.channels.includeSourceName')}</span>
                <span className="timeshift-toggle-sub">
                  {i18n.t('settings:livetv.channels.includeSourceNameSub')}
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={includeSourceInSearch}
                  onChange={(e) => {
                  onIncludeSourceInSearchChange(e.target.checked);
                  saveIncludeSourceInSearch(e.target.checked);
                }}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="timeshift-settings" style={{ marginTop: '16px' }}>
            <div className="timeshift-toggle-row">
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:livetv.channels.includeSourceVod')}</span>
                <span className="timeshift-toggle-sub">
                  {i18n.t('settings:livetv.channels.includeSourceVodSub')}
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={includeSourceInVodSearch}
                  onChange={(e) => {
                    onIncludeSourceInVodSearchChange(e.target.checked);
                    saveIncludeSourceInVodSearch(e.target.checked);
                  }}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="refresh-settings" style={{ marginTop: '20px' }}>
            <div className="form-group inline">
              <label>{i18n.t('settings:livetv.channels.maxSearchResults')}</label>
              <select
                value={maxSearchResults}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10);
                  onMaxSearchResultsChange(value);
                  saveMaxSearchResults(value);
                }}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
                <option value={1000}>{i18n.t('settings:livetv.channels.default1000')}</option>
                <option value={2000}>2000</option>
                <option value={MAX_SEARCH_RESULTS_LIMIT}>{MAX_SEARCH_RESULTS_LIMIT}</option>
              </select>
            </div>
            <p className="form-hint" style={{ marginTop: '0.5rem' }}>
              {i18n.t('settings:livetv.channels.maxSearchResultsSub')}
            </p>
          </div>

          <div className="refresh-settings" style={{ marginTop: '20px' }}>
            <div className="form-group inline">
              <label>{i18n.t('settings:livetv.channels.searchResultsOrder')}</label>
              <select
                value={searchResultsOrder}
                onChange={(e) => {
                  const value = e.target.value as 'default' | 'alphabetical';
                  onSearchResultsOrderChange(value);
                  saveSearchResultsOrder(value);
                }}
              >
                <option value="default">{i18n.t('common:default')}</option>
                <option value="alphabetical">{i18n.t('settings:livetv.channels.alphabetical')}</option>
              </select>
            </div>
            <p className="form-hint" style={{ marginTop: '0.5rem' }}>
              {i18n.t('settings:livetv.channels.searchResultsOrderSub')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
