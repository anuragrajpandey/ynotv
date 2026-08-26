import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  PHONE_REMOTE_SKINS,
  ALL_PHONE_REMOTE_TABS,
  PHONE_REMOTE_AVAILABLE_ACTIONS,
  DEFAULT_PHONE_REMOTE_CONFIG,
  type PhoneRemoteSkin,
  type PhoneRemoteTabId,
} from '../../types/phoneRemote';
import './PhoneRemoteCustomizer.css';

interface PhoneRemoteCustomizerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PhoneRemoteCustomizer({ isOpen, onClose }: PhoneRemoteCustomizerProps) {
  const { i18n } = useTranslation();
  const phoneRemoteConfig = useSettingsStore((s) => s.phoneRemoteConfig);
  const setPhoneRemoteConfig = useSettingsStore((s) => s.setPhoneRemoteConfig);
  const resetPhoneRemoteConfig = useSettingsStore((s) => s.resetPhoneRemoteConfig);

  // Start the quick-action add-select on the first real action, not a placeholder
  // id that isn't in the catalog ('aspect_ratio' would render a dead button on
  // the phone that does nothing).
  const [newActionToAdd, setNewActionToAdd] = useState<string>(PHONE_REMOTE_AVAILABLE_ACTIONS[0]?.id || '');
  const [showResetModal, setShowResetModal] = useState<boolean>(false);

  if (!isOpen) return null;

  const currentConfig = phoneRemoteConfig || DEFAULT_PHONE_REMOTE_CONFIG;
  const currentSkin = currentConfig.skin || 'modern';
  const enabledTabs = currentConfig.enabledTabs || DEFAULT_PHONE_REMOTE_CONFIG.enabledTabs;
  const cornerButtons = currentConfig.cornerButtons || DEFAULT_PHONE_REMOTE_CONFIG.cornerButtons;
  const centerButtons = currentConfig.centerButtons || DEFAULT_PHONE_REMOTE_CONFIG.centerButtons;
  const quickActions = currentConfig.quickActions || DEFAULT_PHONE_REMOTE_CONFIG.quickActions;
  const layout = currentConfig.layout || DEFAULT_PHONE_REMOTE_CONFIG.layout;

  const handleSkinSelect = (skin: PhoneRemoteSkin) => {
    setPhoneRemoteConfig({ skin });
  };

  const handleToggleTab = (tabId: PhoneRemoteTabId) => {
    if (tabId === 'remote') return; // Remote tab is required
    let nextTabs: PhoneRemoteTabId[];
    if (enabledTabs.includes(tabId)) {
      nextTabs = enabledTabs.filter((t) => t !== tabId);
    } else {
      nextTabs = [...enabledTabs, tabId];
    }
    // If disabled tab was default, fallback default to 'remote'
    let nextDefault = layout.defaultTab;
    if (!nextTabs.includes(nextDefault)) {
      nextDefault = 'remote';
    }
    setPhoneRemoteConfig({
      enabledTabs: nextTabs,
      layout: { ...layout, defaultTab: nextDefault },
    });
  };

  const handleCornerButtonActionChange = (
    corner: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
    action: string
  ) => {
    const actionMeta = PHONE_REMOTE_AVAILABLE_ACTIONS.find((a) => a.id === action);
    setPhoneRemoteConfig({
      cornerButtons: {
        ...cornerButtons,
        [corner]: {
          ...cornerButtons[corner],
          action,
          customLabel: actionMeta ? actionMeta.shortLabel : 'Btn',
        },
      },
    });
  };

  const handleToggleCornerButton = (
    corner: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
    enabled: boolean
  ) => {
    setPhoneRemoteConfig({
      cornerButtons: {
        ...cornerButtons,
        [corner]: {
          ...cornerButtons[corner],
          enabled,
        },
      },
    });
  };

  const handleCenterButtonActionChange = (pos: 'top' | 'bottom', action: string) => {
    const actionMeta = PHONE_REMOTE_AVAILABLE_ACTIONS.find((a) => a.id === action);
    setPhoneRemoteConfig({
      centerButtons: {
        ...centerButtons,
        [pos]: {
          ...centerButtons[pos],
          action,
          customLabel: actionMeta ? actionMeta.shortLabel : pos === 'top' ? 'Back' : 'Play',
        },
      },
    });
  };

  const handleToggleCenterButton = (pos: 'top' | 'bottom', enabled: boolean) => {
    setPhoneRemoteConfig({
      centerButtons: {
        ...centerButtons,
        [pos]: {
          ...centerButtons[pos],
          enabled,
        },
      },
    });
  };

  const handleCenterButtonsSizeChange = (size: 'compact' | 'normal' | 'large' | 'expanded') => {
    setPhoneRemoteConfig({
      centerButtons: {
        ...centerButtons,
        size,
      },
    });
  };

  const handleAddQuickAction = () => {
    // Guard against stale/dead ids: only add actions that exist in the catalog.
    if (!newActionToAdd) return;
    if (!PHONE_REMOTE_AVAILABLE_ACTIONS.some((a) => a.id === newActionToAdd)) return;
    if (quickActions.includes(newActionToAdd)) return;
    setPhoneRemoteConfig({
      quickActions: [...quickActions, newActionToAdd],
    });
  };

  const handleRemoveQuickAction = (actionId: string) => {
    setPhoneRemoteConfig({
      quickActions: quickActions.filter((a) => a !== actionId),
    });
  };

  const handleToggleLayoutOption = (key: keyof typeof layout, value: any) => {
    setPhoneRemoteConfig({
      layout: {
        ...layout,
        [key]: value,
      },
    });
  };

  const handleOpenResetModal = () => {
    setShowResetModal(true);
  };

  const handleConfirmReset = () => {
    resetPhoneRemoteConfig();
    setShowResetModal(false);
  };

  const handleCancelReset = () => {
    setShowResetModal(false);
  };

  // Find action meta for labels
  const getActionShortLabel = (actionId: string, fallback: string) => {
    const found = PHONE_REMOTE_AVAILABLE_ACTIONS.find((a) => a.id === actionId);
    return found ? found.shortLabel : fallback;
  };

  return (
    <div className="phone-remote-customizer-modal-overlay" onClick={onClose}>
      <div className="phone-remote-customizer-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="prc-header">
          <div className="prc-header-title-box">
            <h2 className="prc-title">{i18n.t('settings:controllers.remoteCustomizer.title')}</h2>
            <p className="prc-subtitle">{i18n.t('settings:controllers.remoteCustomizer.subtitle')}</p>
          </div>
          <button className="prc-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body: Left Mockup, Right Options */}
        <div className="prc-body">
          {/* Left: Interactive Phone Mockup Preview */}
          <div className="prc-preview-pane">
            <span className="prc-preview-badge">
              {i18n.t('settings:controllers.remoteCustomizer.previewBadge')}
            </span>

            <div className="prc-phone-frame">
              <div className="prc-phone-notch" />

              <div className={`prc-phone-screen skin-${currentSkin}`}>
                {/* Header */}
                <div className="prc-screen-header">
                  <span className="prc-screen-logo">YNOTV</span>
                  <span className="prc-screen-status">● Live</span>
                </div>

                {/* Now Playing Banner (if enabled) */}
                {layout.showNowPlaying && (
                  <div className="prc-screen-np">
                    <div className="prc-screen-np-thumb">TV</div>
                    <div className="prc-screen-np-text">
                      <span className="prc-screen-np-title">HBO HD East</span>
                      <span className="prc-screen-np-sub">House of the Dragon • 45m left</span>
                    </div>
                  </div>
                )}

                {/* Main Remote Tab Area */}
                <div className="prc-screen-content">
                  {/* D-Pad with Satellite Corners */}
                  <div className="prc-mock-dpad-wrap">
                    {/* Top-Left */}
                    <div
                      className={`prc-mock-corner-btn top-left ${
                        !cornerButtons.topLeft.enabled ? 'disabled' : ''
                      }`}
                      title={cornerButtons.topLeft.action}
                    >
                      {cornerButtons.topLeft.enabled
                        ? cornerButtons.topLeft.customLabel ||
                          getActionShortLabel(cornerButtons.topLeft.action, 'Open')
                        : '—'}
                    </div>

                    {/* Top-Right */}
                    <div
                      className={`prc-mock-corner-btn top-right ${
                        !cornerButtons.topRight.enabled ? 'disabled' : ''
                      }`}
                      title={cornerButtons.topRight.action}
                    >
                      {cornerButtons.topRight.enabled
                        ? cornerButtons.topRight.customLabel ||
                          getActionShortLabel(cornerButtons.topRight.action, 'Screen')
                        : '—'}
                    </div>

                    {/* Bottom-Left */}
                    <div
                      className={`prc-mock-corner-btn bottom-left ${
                        !cornerButtons.bottomLeft.enabled ? 'disabled' : ''
                      }`}
                      title={cornerButtons.bottomLeft.action}
                    >
                      {cornerButtons.bottomLeft.enabled
                        ? cornerButtons.bottomLeft.customLabel ||
                          getActionShortLabel(cornerButtons.bottomLeft.action, '-10s')
                        : '—'}
                    </div>

                    {/* Bottom-Right */}
                    <div
                      className={`prc-mock-corner-btn bottom-right ${
                        !cornerButtons.bottomRight.enabled ? 'disabled' : ''
                      }`}
                      title={cornerButtons.bottomRight.action}
                    >
                      {cornerButtons.bottomRight.enabled
                        ? cornerButtons.bottomRight.customLabel ||
                          getActionShortLabel(cornerButtons.bottomRight.action, '+10s')
                        : '—'}
                    </div>

                    {/* Center D-Pad */}
                    <div className="prc-mock-dpad">
                      <div className="prc-mock-dpad-center">OK</div>
                    </div>
                  </div>

                  {/* Middle Cluster (Vol / Stack / CH) */}
                  <div className="prc-mock-middle-cluster">
                    {layout.showVolumeRocker && (
                      <div className="prc-mock-pillar">
                        <div className="prc-mock-pillar-btn">+</div>
                        <div className="prc-mock-pillar-btn">🔇</div>
                        <div className="prc-mock-pillar-btn">-</div>
                      </div>
                    )}

                    {layout.showCenterStack && (
                      <div className={`prc-mock-center-stack size-${centerButtons.size || 'normal'}`}>
                        {centerButtons.top.enabled ? (
                          <div className="prc-mock-center-btn">
                            {centerButtons.top.customLabel ||
                              getActionShortLabel(centerButtons.top.action, 'Back')}
                          </div>
                        ) : (
                          <div className="prc-mock-center-btn disabled">—</div>
                        )}
                        {centerButtons.bottom.enabled ? (
                          <div className="prc-mock-center-btn">
                            {centerButtons.bottom.customLabel ||
                              getActionShortLabel(centerButtons.bottom.action, 'Play')}
                          </div>
                        ) : (
                          <div className="prc-mock-center-btn disabled">—</div>
                        )}
                      </div>
                    )}

                    {layout.showChannelRocker && (
                      <div className="prc-mock-pillar">
                        <div className="prc-mock-pillar-btn">▲</div>
                        <div style={{ fontSize: '7px', fontWeight: 800 }}>CH</div>
                        <div className="prc-mock-pillar-btn">▼</div>
                      </div>
                    )}
                  </div>

                  {/* Quick Action Buttons Grid */}
                  {layout.showQuickActions && quickActions.length > 0 && (
                    <div className="prc-mock-qa-row">
                      {quickActions.map((actId) => {
                        const act = PHONE_REMOTE_AVAILABLE_ACTIONS.find((a) => a.id === actId);
                        return (
                          <div key={actId} className="prc-mock-qa-pill">
                            {act ? act.shortLabel : actId}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Bottom Navigation Bar */}
                <div className="prc-mock-nav-bar">
                  {ALL_PHONE_REMOTE_TABS.map((tab) => {
                    const isTabEnabled = enabledTabs.includes(tab.id);
                    if (!isTabEnabled) return null;
                    const isActive = layout.defaultTab === tab.id;
                    return (
                      <div
                        key={tab.id}
                        className={`prc-mock-nav-item ${isActive ? 'active' : ''}`}
                      >
                        <span>{tab.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Customization Controls */}
          <div className="prc-controls-pane">
            {/* 1. Skins & Themes */}
            <div className="prc-section">
              <div className="prc-section-header">
                <h3 className="prc-section-title">
                  {i18n.t('settings:controllers.remoteCustomizer.skinsTitle')}
                </h3>
                <p className="prc-section-desc">
                  {i18n.t('settings:controllers.remoteCustomizer.skinsDesc')}
                </p>
              </div>

              <div className="prc-skins-grid">
                {PHONE_REMOTE_SKINS.map((skin) => (
                  <button
                    key={skin.id}
                    className={`prc-skin-card ${currentSkin === skin.id ? 'selected' : ''}`}
                    onClick={() => handleSkinSelect(skin.id)}
                  >
                    <div className="prc-skin-swatch" style={{ background: skin.previewBg }}>
                      <div
                        className="prc-skin-accent-dot"
                        style={{
                          background: skin.previewAccent,
                          color: skin.previewAccent,
                        }}
                      />
                    </div>
                    <span className="prc-skin-name">{skin.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 2. Navigation Tabs */}
            <div className="prc-section">
              <div className="prc-section-header">
                <h3 className="prc-section-title">
                  {i18n.t('settings:controllers.remoteCustomizer.tabsTitle')}
                </h3>
                <p className="prc-section-desc">
                  {i18n.t('settings:controllers.remoteCustomizer.tabsDesc')}
                </p>
              </div>

              <div className="prc-tabs-grid">
                {ALL_PHONE_REMOTE_TABS.map((tab) => {
                  const isChecked = enabledTabs.includes(tab.id);
                  const isLocked = tab.id === 'remote';
                  return (
                    <div key={tab.id} className="prc-tab-pill-card">
                      <div className="prc-tab-info">
                        <span className="prc-tab-name">{tab.label}</span>
                        <span className="prc-tab-sub">{tab.description}</span>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isLocked}
                          onChange={() => handleToggleTab(tab.id)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '6px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                  {i18n.t('settings:controllers.remoteCustomizer.defaultTabLabel')}
                </span>
                <select
                  className="prc-select"
                  value={layout.defaultTab}
                  onChange={(e) => handleToggleLayoutOption('defaultTab', e.target.value)}
                >
                  {enabledTabs.map((tabId) => {
                    const tabMeta = ALL_PHONE_REMOTE_TABS.find((t) => t.id === tabId);
                    return (
                      <option key={tabId} value={tabId}>
                        {tabMeta ? tabMeta.label : tabId}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            {/* 3. D-Pad Corner Satellite Buttons */}
            <div className="prc-section">
              <div className="prc-section-header">
                <h3 className="prc-section-title">
                  {i18n.t('settings:controllers.remoteCustomizer.cornersTitle')}
                </h3>
                <p className="prc-section-desc">
                  {i18n.t('settings:controllers.remoteCustomizer.cornersDesc')}
                </p>
              </div>

              <div className="prc-corners-grid">
                {/* Top-Left */}
                <div className="prc-corner-card">
                  <div className="prc-corner-header">
                    <span className="prc-corner-title">
                      {i18n.t('settings:controllers.remoteCustomizer.cornerTopLeft')}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={cornerButtons.topLeft.enabled}
                        onChange={(e) => handleToggleCornerButton('topLeft', e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <select
                    className="prc-select"
                    value={cornerButtons.topLeft.action}
                    disabled={!cornerButtons.topLeft.enabled}
                    onChange={(e) => handleCornerButtonActionChange('topLeft', e.target.value)}
                  >
                    {PHONE_REMOTE_AVAILABLE_ACTIONS.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Top-Right */}
                <div className="prc-corner-card">
                  <div className="prc-corner-header">
                    <span className="prc-corner-title">
                      {i18n.t('settings:controllers.remoteCustomizer.cornerTopRight')}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={cornerButtons.topRight.enabled}
                        onChange={(e) => handleToggleCornerButton('topRight', e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <select
                    className="prc-select"
                    value={cornerButtons.topRight.action}
                    disabled={!cornerButtons.topRight.enabled}
                    onChange={(e) => handleCornerButtonActionChange('topRight', e.target.value)}
                  >
                    {PHONE_REMOTE_AVAILABLE_ACTIONS.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Bottom-Left */}
                <div className="prc-corner-card">
                  <div className="prc-corner-header">
                    <span className="prc-corner-title">
                      {i18n.t('settings:controllers.remoteCustomizer.cornerBottomLeft')}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={cornerButtons.bottomLeft.enabled}
                        onChange={(e) => handleToggleCornerButton('bottomLeft', e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <select
                    className="prc-select"
                    value={cornerButtons.bottomLeft.action}
                    disabled={!cornerButtons.bottomLeft.enabled}
                    onChange={(e) => handleCornerButtonActionChange('bottomLeft', e.target.value)}
                  >
                    {PHONE_REMOTE_AVAILABLE_ACTIONS.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Bottom-Right */}
                <div className="prc-corner-card">
                  <div className="prc-corner-header">
                    <span className="prc-corner-title">
                      {i18n.t('settings:controllers.remoteCustomizer.cornerBottomRight')}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={cornerButtons.bottomRight.enabled}
                        onChange={(e) => handleToggleCornerButton('bottomRight', e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <select
                    className="prc-select"
                    value={cornerButtons.bottomRight.action}
                    disabled={!cornerButtons.bottomRight.enabled}
                    onChange={(e) => handleCornerButtonActionChange('bottomRight', e.target.value)}
                  >
                    {PHONE_REMOTE_AVAILABLE_ACTIONS.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* 4. Middle Action Buttons (Back & Play/Pause) */}
            <div className="prc-section">
              <div className="prc-section-header">
                <h3 className="prc-section-title">
                  {i18n.t('settings:controllers.remoteCustomizer.centerButtonsTitle')}
                </h3>
                <p className="prc-section-desc">
                  {i18n.t('settings:controllers.remoteCustomizer.centerButtonsDesc')}
                </p>
              </div>

              {/* Sizing selection */}
              <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>
                  {i18n.t('settings:controllers.remoteCustomizer.centerSizeLabel')}
                </span>
                <select
                  className="prc-select"
                  style={{ width: 'auto', padding: '6px 12px' }}
                  value={centerButtons.size || 'normal'}
                  onChange={(e) => handleCenterButtonsSizeChange(e.target.value as any)}
                >
                  <option value="compact">{i18n.t('settings:controllers.remoteCustomizer.centerSizeCompact')}</option>
                  <option value="normal">{i18n.t('settings:controllers.remoteCustomizer.centerSizeNormal')}</option>
                  <option value="large">{i18n.t('settings:controllers.remoteCustomizer.centerSizeLarge')}</option>
                  <option value="expanded">{i18n.t('settings:controllers.remoteCustomizer.centerSizeExpanded')}</option>
                </select>
              </div>

              <div className="prc-corners-grid">
                {/* Top Button */}
                <div className="prc-corner-card">
                  <div className="prc-corner-header">
                    <span className="prc-corner-title">
                      {i18n.t('settings:controllers.remoteCustomizer.centerTopBtn')}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={centerButtons.top.enabled}
                        onChange={(e) => handleToggleCenterButton('top', e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <select
                    className="prc-select"
                    value={centerButtons.top.action}
                    disabled={!centerButtons.top.enabled}
                    onChange={(e) => handleCenterButtonActionChange('top', e.target.value)}
                  >
                    {PHONE_REMOTE_AVAILABLE_ACTIONS.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Bottom Button */}
                <div className="prc-corner-card">
                  <div className="prc-corner-header">
                    <span className="prc-corner-title">
                      {i18n.t('settings:controllers.remoteCustomizer.centerBottomBtn')}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={centerButtons.bottom.enabled}
                        onChange={(e) => handleToggleCenterButton('bottom', e.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <select
                    className="prc-select"
                    value={centerButtons.bottom.action}
                    disabled={!centerButtons.bottom.enabled}
                    onChange={(e) => handleCenterButtonActionChange('bottom', e.target.value)}
                  >
                    {PHONE_REMOTE_AVAILABLE_ACTIONS.map((act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* 5. Quick Action Buttons Row */}
            <div className="prc-section">
              <div className="prc-section-header">
                <h3 className="prc-section-title">
                  {i18n.t('settings:controllers.remoteCustomizer.quickActionsTitle')}
                </h3>
                <p className="prc-section-desc">
                  {i18n.t('settings:controllers.remoteCustomizer.quickActionsDesc')}
                </p>
              </div>

              <div className="prc-qa-list">
                {quickActions.map((actId) => {
                  const act = PHONE_REMOTE_AVAILABLE_ACTIONS.find((a) => a.id === actId);
                  return (
                    <div key={actId} className="prc-qa-pill">
                      <span>{act ? act.label : actId}</span>
                      <button
                        className="prc-qa-remove-btn"
                        onClick={() => handleRemoveQuickAction(actId)}
                        title={i18n.t('settings:controllers.remoteCustomizer.removeAction')}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="prc-add-qa-select-row">
                <select
                  className="prc-select"
                  value={newActionToAdd}
                  onChange={(e) => setNewActionToAdd(e.target.value)}
                >
                  {PHONE_REMOTE_AVAILABLE_ACTIONS.filter((a) => !quickActions.includes(a.id)).map(
                    (act) => (
                      <option key={act.id} value={act.id}>
                        {act.label}
                      </option>
                    )
                  )}
                </select>
                <button
                  className="prc-select"
                  style={{ fontWeight: 600, background: 'var(--surface-hover, rgba(255,255,255,0.1))' }}
                  onClick={handleAddQuickAction}
                >
                  {i18n.t('settings:controllers.remoteCustomizer.addAction')}
                </button>
              </div>
            </div>

            {/* 5. Display & Behavior Toggles */}
            <div className="prc-section">
              <div className="prc-section-header">
                <h3 className="prc-section-title">
                  {i18n.t('settings:controllers.remoteCustomizer.layoutTitle')}
                </h3>
              </div>

              <div className="prc-toggles-grid">
                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.showNowPlaying')}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={layout.showNowPlaying}
                      onChange={(e) => handleToggleLayoutOption('showNowPlaying', e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.showSearch')}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={layout.showSearch}
                      onChange={(e) => handleToggleLayoutOption('showSearch', e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.showVolumeRocker')}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={layout.showVolumeRocker}
                      onChange={(e) =>
                        handleToggleLayoutOption('showVolumeRocker', e.target.checked)
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.showChannelRocker')}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={layout.showChannelRocker}
                      onChange={(e) =>
                        handleToggleLayoutOption('showChannelRocker', e.target.checked)
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.showCenterStack')}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={layout.showCenterStack}
                      onChange={(e) =>
                        handleToggleLayoutOption('showCenterStack', e.target.checked)
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.showQuickActions')}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={layout.showQuickActions}
                      onChange={(e) =>
                        handleToggleLayoutOption('showQuickActions', e.target.checked)
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="prc-toggle-row">
                  <span className="prc-toggle-label">
                    {i18n.t('settings:controllers.remoteCustomizer.buttonSize')}
                  </span>
                  <select
                    className="prc-select"
                    value={layout.buttonSize}
                    onChange={(e) => handleToggleLayoutOption('buttonSize', e.target.value)}
                  >
                    <option value="compact">
                      {i18n.t('settings:controllers.remoteCustomizer.buttonSizeCompact')}
                    </option>
                    <option value="normal">
                      {i18n.t('settings:controllers.remoteCustomizer.buttonSizeNormal')}
                    </option>
                    <option value="large">
                      {i18n.t('settings:controllers.remoteCustomizer.buttonSizeLarge')}
                    </option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="prc-footer">
          <div className="prc-live-notice">
            <span>●</span>
            <span>{i18n.t('settings:controllers.remoteCustomizer.liveSyncNotice')}</span>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="prc-reset-btn" onClick={handleOpenResetModal}>
              {i18n.t('settings:controllers.remoteCustomizer.resetDefaults')}
            </button>
            <button className="prc-done-btn" onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        {/* In-App Reset Confirmation Modal Dialog */}
        {showResetModal && (
          <div className="prc-confirm-overlay" onClick={handleCancelReset}>
            <div className="prc-confirm-modal" onClick={(e) => e.stopPropagation()}>
              <div className="prc-confirm-header">
                <div className="prc-confirm-icon">⚠️</div>
                <h3 className="prc-confirm-title">
                  {i18n.t('settings:controllers.remoteCustomizer.resetDefaults')}
                </h3>
              </div>
              <p className="prc-confirm-message">
                {i18n.t('settings:controllers.remoteCustomizer.resetConfirm')}
              </p>
              <div className="prc-confirm-actions">
                <button className="prc-confirm-btn cancel" onClick={handleCancelReset}>
                  Cancel
                </button>
                <button className="prc-confirm-btn confirm" onClick={handleConfirmReset}>
                  Reset to Defaults
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
