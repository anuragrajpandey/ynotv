import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './PlaybackTab.css';

const CACHE_PRESETS = [
  { label: '256 MB', bytes: 268_435_456 },
  { label: '512 MB', bytes: 536_870_912 },
  { label: '1 GB', bytes: 1_073_741_824 },
  { label: '2 GB', bytes: 2_147_483_648 },
  { label: '4 GB', bytes: 4_294_967_296 },
];

function estimateMinutes(bytes: number, mbps: number): number {
  return Math.round((bytes * 8) / (mbps * 1_000_000) / 60);
}

interface CacheTabProps {
  timeshiftEnabled: boolean;
  timeshiftCacheBytes: number;
  liveBufferOffset?: number;
  onTimeshiftChange: (enabled: boolean, cacheBytes: number, bufferOffset?: number) => void;
}

export function CacheTab({ timeshiftEnabled, timeshiftCacheBytes, liveBufferOffset = 0, onTimeshiftChange }: CacheTabProps) {
  useTranslation();
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const [customMegabytes, setCustomMegabytes] = useState(() => String(Math.round(timeshiftCacheBytes / 1_048_576)));
  const [customError, setCustomError] = useState<string | null>(null);
  const [isCustomMode, setIsCustomMode] = useState(() => !CACHE_PRESETS.some((p) => p.bytes === timeshiftCacheBytes));

  useEffect(() => {
    setCustomMegabytes(String(Math.round(timeshiftCacheBytes / 1_048_576)));
    if (!CACHE_PRESETS.some((p) => p.bytes === timeshiftCacheBytes)) {
      setIsCustomMode(true);
    }
  }, [timeshiftCacheBytes]);

  const handleTimeshiftToggle = (enabled: boolean) => {
    onTimeshiftChange(enabled, timeshiftCacheBytes, liveBufferOffset);
  };

  const handlePreset = (bytes: number) => {
    setIsCustomMode(false);
    setCustomMegabytes(String(Math.round(bytes / 1_048_576)));
    setCustomError(null);
    onTimeshiftChange(timeshiftEnabled, bytes, liveBufferOffset);
  };

  const handleSelectCustom = () => {
    setIsCustomMode(true);
    setCustomError(null);
  };

  const handleApplyCustom = () => {
    const megabytes = Number(customMegabytes);
    if (!Number.isInteger(megabytes) || megabytes < 16 || megabytes > 16_384) {
      setCustomError(i18n.t('settings:cache.customSizeError'));
      return;
    }
    setCustomError(null);
    onTimeshiftChange(timeshiftEnabled, megabytes * 1_048_576, liveBufferOffset);
  };

  const handleBufferOffsetChange = (offset: number) => {
    onTimeshiftChange(timeshiftEnabled, timeshiftCacheBytes, offset);
  };

  const checkMpvCache = async () => {
    try {
      const result = await invoke('mpv_get_cache_debug') as Record<string, unknown>;
      setDebugInfo(JSON.stringify(result, null, 2));
    } catch (e) {
      setDebugInfo(`Error: ${e}`);
    }
  };

  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:cache.title')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:cache.description')}
        </p>

        <div className="timeshift-settings">
          {/* Enable toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:cache.enableTimeshift')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:cache.enableTimeshiftSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={timeshiftEnabled}
                onChange={(e) => handleTimeshiftToggle(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {timeshiftEnabled && (
            <>
              <div className="timeshift-presets-label">{i18n.t('settings:cache.cacheSize')}</div>
              <div className="timeshift-presets">
                {CACHE_PRESETS.map((preset) => (
                  <button
                    key={preset.bytes}
                    className={`timeshift-preset-btn ${!isCustomMode && timeshiftCacheBytes === preset.bytes ? 'active' : ''}`}
                    onClick={() => handlePreset(preset.bytes)}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  className={`timeshift-preset-btn ${isCustomMode ? 'active' : ''}`}
                  onClick={handleSelectCustom}
                >
                  {i18n.t('settings:cache.custom')}
                </button>
              </div>

              {isCustomMode && (
                <div style={{
                  marginTop: '12px',
                  padding: '12px 14px',
                  background: 'var(--surface-color, rgba(255, 255, 255, 0.03))',
                  border: '1px solid var(--surface-border, rgba(255, 255, 255, 0.08))',
                  borderRadius: '6px'
                }}>
                  <div className="timeshift-presets-label" style={{ marginBottom: '6px' }}>
                    {i18n.t('settings:cache.customSize')}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min="16"
                      max="16384"
                      step="1"
                      value={customMegabytes}
                      onChange={(e) => {
                        setCustomMegabytes(e.target.value);
                        setCustomError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleApplyCustom();
                        }
                      }}
                      style={{
                        width: '120px',
                        padding: '6px 10px',
                        background: 'var(--surface-color, rgba(255, 255, 255, 0.05))',
                        border: '1px solid var(--surface-border, rgba(255, 255, 255, 0.12))',
                        borderRadius: '4px',
                        color: 'var(--text-primary, white)',
                        fontSize: '0.875rem',
                      }}
                    />
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, rgba(255, 255, 255, 0.6))' }}>MB</span>
                    <button
                      type="button"
                      className="sync-btn"
                      onClick={handleApplyCustom}
                      style={{
                        padding: '6px 14px',
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                    >
                      {i18n.t('settings:cache.apply')}
                    </button>
                  </div>
                  {customError && (
                    <span style={{ display: 'block', color: 'var(--color-error, #ff5555)', fontSize: '0.8rem', marginTop: '6px' }}>
                      {customError}
                    </span>
                  )}
                </div>
              )}

              <table className="timeshift-estimate-table">
                <thead>
                  <tr>
                    <th>{i18n.t('settings:cache.streamQuality')}</th>
                    <th>{i18n.t('settings:cache.estimatedWindow')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>SD (~4 Mbps)</td>
                    <td>~{estimateMinutes(timeshiftCacheBytes, 4)} min</td>
                  </tr>
                  <tr>
                    <td>HD (~8 Mbps)</td>
                    <td>~{estimateMinutes(timeshiftCacheBytes, 8)} min</td>
                  </tr>
                  <tr>
                    <td>4K (~20 Mbps)</td>
                    <td>~{estimateMinutes(timeshiftCacheBytes, 20)} min</td>
                  </tr>
                </tbody>
              </table>

              <div className="timeshift-buffer-offset" style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--surface-border)' }}>
                <div className="timeshift-presets-label">{i18n.t('settings:cache.liveBufferOffset')}</div>
                <p className="section-description" style={{ marginTop: '4px', fontSize: '0.8125rem' }}>
                  {i18n.t('settings:cache.liveBufferOffsetHint')}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
                  <input
                    type="range"
                    min="0"
                    max="30"
                    step="1"
                    value={liveBufferOffset}
                    onChange={(e) => handleBufferOffsetChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '60px', textAlign: 'right', fontSize: '0.875rem' }}>
                    {liveBufferOffset}s
                  </span>
                </div>
              </div>

              <p className="timeshift-note">
                {i18n.t('settings:cache.timeshiftNote')}
              </p>

              {/* Debug section */}
              <div style={{ marginTop: '20px', borderTop: '1px solid var(--surface-border)', paddingTop: '16px' }}>
                <button
                  className="sync-btn"
                  onClick={checkMpvCache}
                  style={{ maxWidth: '200px' }}
                >
                  {i18n.t('settings:cache.checkMpvCache')}
                </button>
                {debugInfo && (
                  <pre style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    overflow: 'auto',
                    maxHeight: '300px',
                    color: 'var(--text-primary)'
                  }}>
                    {debugInfo}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
