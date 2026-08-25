import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import { useStremioAddonStore } from '../../stores/stremioAddonStore';
import { useStremioAuthStore } from '../../stores/stremioAuthStore';
import type { InstalledAddon } from '../../types/stremio';
import { openAddonConfigureUrl } from '../../services/stremio-addon';
import './AddonManagerPanel.css';

interface AddonManagerPanelProps {
  onClose: () => void;
}

export function AddonManagerPanel({ onClose }: AddonManagerPanelProps) {
  useTranslation();
  const addons = useStremioAddonStore((s) => s.addons);
  const addAddon = useStremioAddonStore((s) => s.addAddon);
  const removeAddon = useStremioAddonStore((s) => s.removeAddon);
  const toggleAddon = useStremioAddonStore((s) => s.toggleAddon);
  const reorderAddons = useStremioAddonStore((s) => s.reorderAddons);
  const addonsReordered = useStremioAddonStore((s) => s.addonsReordered);
  const syncAddonPositions = useStremioAddonStore((s) => s.syncAddonPositions);

  const authKey = useStremioAuthStore((s) => s.authKey);
  const syncAddons = useStremioAuthStore((s) => s.syncAddons);

  const [manifestUrl, setManifestUrl] = useState('');
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState<string | boolean>(false);
  const [syncingPositions, setSyncingPositions] = useState(false);

  const handleInstall = async (url: string) => {
    if (!url.trim()) return;
    setInstalling(url);
    setError('');
    try {
      await addAddon(url.trim());
      if (url === manifestUrl) setManifestUrl('');
    } catch (e: any) {
      setError(translateNativeError(e.message) || i18n.t('stremio:failedInstallAddon'));
    } finally {
      setInstalling(false);
    }
  };

  const handleSyncPositions = async () => {
    setSyncingPositions(true);
    setError('');
    try {
      await syncAddonPositions();
    } catch (e: any) {
      setError(translateNativeError(e.message) || i18n.t('stremio:failedSyncPositions'));
    } finally {
      setSyncingPositions(false);
    }
  };

  return (
    <div className="stremio-addon-overlay" onClick={onClose}>
      <div className="stremio-addon-modal" onClick={(e) => e.stopPropagation()}>
        <div className="stremio-addon-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h3 className="stremio-addon-title">{i18n.t('stremio:addonManager', { count: addons.length })}</h3>
            {authKey && syncAddons && addonsReordered && (
              <button
                className="stremio-addon-sync-btn"
                onClick={handleSyncPositions}
                disabled={syncingPositions}
              >
                {syncingPositions ? i18n.t('stremio:syncing') : i18n.t('stremio:syncAddonPositions')}
              </button>
            )}
          </div>
          <button className="stremio-addon-close" onClick={onClose}>✕</button>
        </div>

        <div className="stremio-addon-body">
          {error && <div className="stremio-addon-error" style={{ marginBottom: '12px' }}>{error}</div>}

          <div className="stremio-addon-install-section">
            <h4 className="stremio-addon-section-title">{i18n.t('stremio:installCustomAddon')}</h4>
            <p className="stremio-addon-section-desc">
              {i18n.t('stremio:installCustomAddonHint')}
            </p>
            <div className="stremio-addon-input-row">
              <input
                className="stremio-addon-input"
                type="text"
                placeholder="https://example.com/manifest.json"
                value={manifestUrl}
                onChange={(e) => setManifestUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleInstall(manifestUrl); }}
              />
              <button
                className="stremio-addon-install-btn"
                onClick={() => void handleInstall(manifestUrl)}
                disabled={!!installing || !manifestUrl.trim()}
              >
                {installing === manifestUrl ? i18n.t('stremio:installing') : i18n.t('stremio:install')}
              </button>
            </div>
          </div>

          <div className="stremio-addon-list-section">
            <h4 className="stremio-addon-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{i18n.t('stremio:installedAddons')}</span>
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', fontWeight: 'normal' }}>
                {i18n.t('stremio:useArrowsHint')}
              </span>
            </h4>
            {addons.length === 0 ? (
              <div className="stremio-addon-empty">{i18n.t('stremio:noAddonsInstalled')}</div>
            ) : (
              <div className="stremio-addon-list">
                {addons.map((addon: InstalledAddon, index) => {
                  return (
                    <div key={addon.id} className={`stremio-addon-item${addon.enabled === false ? ' disabled' : ''}`}>
                      <div className="stremio-addon-reorder-btns">
                        <button
                          className="stremio-addon-reorder-btn"
                          disabled={index === 0}
                          onClick={() => reorderAddons(index, 'up')}
                          title={i18n.t('stremio:moveUpPriority')}
                        >
                          ▲
                        </button>
                        <button
                          className="stremio-addon-reorder-btn"
                          disabled={index === addons.length - 1}
                          onClick={() => reorderAddons(index, 'down')}
                          title={i18n.t('stremio:moveDownPriority')}
                        >
                          ▼
                        </button>
                      </div>

                      <div className="stremio-addon-item-info">
                        <div className="stremio-addon-item-name">
                          {addon.manifest.name}
                          {addon.isDefault && <span className="stremio-addon-item-badge">{i18n.t('stremio:default')}</span>}
                        </div>
                        <div className="stremio-addon-item-desc" style={{ whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                          {addon.manifest.description}
                        </div>
                        <div className="stremio-addon-item-url">{addon.baseUrl}</div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <button
                          className={`stremio-addon-toggle-btn ${addon.enabled === false ? 'disabled' : ''}`}
                          title={addon.enabled === false ? i18n.t('stremio:enableAddon') : i18n.t('stremio:disableAddon')}
                          onClick={() => toggleAddon(addon.id)}
                        >
                          {addon.enabled === false ? i18n.t('stremio:enable') : i18n.t('stremio:disable')}
                        </button>                          {!addon.isDefault && (
                          <button
                            className="stremio-addon-configure-btn"
                            title={i18n.t('stremio:configureAddon')}
                            onClick={() => openAddonConfigureUrl(addon.baseUrl)}
                          >
                            ⚙
                          </button>
                        )}
                        {!addon.isDefault && (
                          <button
                            className="stremio-addon-remove-btn"
                            onClick={() => removeAddon(addon.id)}
                          >
                            {i18n.t('stremio:uninstall')}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
