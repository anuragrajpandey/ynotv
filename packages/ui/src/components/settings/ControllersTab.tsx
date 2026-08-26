import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore, DEFAULT_CONTROLLER_MAPPINGS, DEFAULT_CONTROLLER_CHORDS } from '../../stores/settingsStore';
import { subscribeGamepadButtonPress, type GamepadDeviceInfo, type LiveButtonEvent } from '../../hooks/useGamepad';
import { generateQrDataUrl } from '../../utils/qrCode';
import { ControllerVisualizer } from './ControllerVisualizer';
import { ControllerRemapModal } from './ControllerRemapModal';
import './ControllersTab.css';

// Each entry id doubles as the i18n key suffix under settings:controllers.mapping.
const AVAILABLE_ACTIONS: Array<{ id: string }> = [
  { id: 'select' },
  { id: 'back' },
  { id: 'nav_up' },
  { id: 'nav_down' },
  { id: 'nav_left' },
  { id: 'nav_right' },
  { id: 'play_pause' },
  { id: 'seek_forward' },
  { id: 'seek_backward' },
  { id: 'next_channel' },
  { id: 'prev_channel' },
  { id: 'epg_shift_forward' },
  { id: 'epg_shift_backward' },
  { id: 'toggle_fullscreen' },
  { id: 'toggle_mute' },
  { id: 'volume_up' },
  { id: 'volume_down' },
  { id: 'search' },
  { id: 'subtitles' },
  { id: 'toggle_livetv' },
  { id: 'toggle_nuvio' },
  { id: 'toggle_stremio' },
  { id: 'toggle_transparent_overlay' },
  { id: 'toggle_overlay' },
  { id: 'toggle_live_game_sidebar' },
  { id: 'open_movies' },
  { id: 'open_series' },
  { id: 'open_sports' },
  { id: 'open_settings' },
  { id: 'none' },
];

const BUTTON_CONFIG: Array<{ id: string; group: string }> = [
  { id: 'south', group: 'face' },
  { id: 'east', group: 'face' },
  { id: 'west', group: 'face' },
  { id: 'north', group: 'face' },
  { id: 'dpad_up', group: 'dpad' },
  { id: 'dpad_down', group: 'dpad' },
  { id: 'dpad_left', group: 'dpad' },
  { id: 'dpad_right', group: 'dpad' },
  { id: 'left_bumper', group: 'shoulders' },
  { id: 'right_bumper', group: 'shoulders' },
  { id: 'left_trigger', group: 'shoulders' },
  { id: 'right_trigger', group: 'shoulders' },
  { id: 'left_stick_click', group: 'thumbsticks' },
  { id: 'right_stick_click', group: 'thumbsticks' },
  { id: 'start', group: 'menu' },
  { id: 'select', group: 'menu' },
];

// Chord matrix: modifiers (columns) × base buttons (rows). Each combination
// maps to an app action (same vocabulary as AVAILABLE_ACTIONS).
const CHORD_MODIFIERS: Array<{ id: string }> = [
  { id: 'left_bumper' },
  { id: 'right_bumper' },
  { id: 'left_trigger' },
  { id: 'right_trigger' },
];

const CHORD_BASE_BUTTONS: Array<{ id: string }> = [
  { id: 'south' },
  { id: 'east' },
  { id: 'west' },
  { id: 'north' },
  { id: 'dpad_up' },
  { id: 'dpad_down' },
  { id: 'dpad_left' },
  { id: 'dpad_right' },
];

export function ControllersTab() {
  const { i18n } = useTranslation();
  const controllerEnabled = useSettingsStore((s) => s.controllerEnabled);
  const setControllerEnabled = useSettingsStore((s) => s.setControllerEnabled);
  const controllerBackgroundListening = useSettingsStore((s) => s.controllerBackgroundListening);
  const setControllerBackgroundListening = useSettingsStore((s) => s.setControllerBackgroundListening);
  const controllerDeadzone = useSettingsStore((s) => s.controllerDeadzone);
  const setControllerDeadzone = useSettingsStore((s) => s.setControllerDeadzone);
  const controllerRepeatDelayMs = useSettingsStore((s) => s.controllerRepeatDelayMs);
  const setControllerRepeatDelayMs = useSettingsStore((s) => s.setControllerRepeatDelayMs);
  const controllerRepeatIntervalMs = useSettingsStore((s) => s.controllerRepeatIntervalMs);
  const setControllerRepeatIntervalMs = useSettingsStore((s) => s.setControllerRepeatIntervalMs);
  const controllerMappings = useSettingsStore((s) => s.controllerMappings);
  const setControllerMappings = useSettingsStore((s) => s.setControllerMappings);
  const resetControllerMappings = useSettingsStore((s) => s.resetControllerMappings);
  const controllerChords = useSettingsStore((s) => s.controllerChords);
  const setControllerChords = useSettingsStore((s) => s.setControllerChords);
  const resetControllerChords = useSettingsStore((s) => s.resetControllerChords);
  const controllerVisualizerLayout = useSettingsStore((s) => s.controllerVisualizerLayout);
  const setControllerVisualizerLayout = useSettingsStore((s) => s.setControllerVisualizerLayout);
  const customGamepadProfiles = useSettingsStore((s) => s.customGamepadProfiles);

  const remoteControlEnabled = useSettingsStore((s) => s.remoteControlEnabled);
  const setRemoteControlEnabled = useSettingsStore((s) => s.setRemoteControlEnabled);
  const remoteControlPort = useSettingsStore((s) => s.remoteControlPort);
  // Latest desired state, so a slow in-flight retry loop bails out if the user
  // toggles again — a stale retry must never start the server after OFF.
  const remoteEnabledRef = useRef(remoteControlEnabled);
  useEffect(() => {
    remoteEnabledRef.current = remoteControlEnabled;
  }, [remoteControlEnabled]);

  const [connectedDevices, setConnectedDevices] = useState<GamepadDeviceInfo[]>([]);
  const [lastActiveBtn, setLastActiveBtn] = useState<string>('');
  const [isRemapModalOpen, setIsRemapModalOpen] = useState<boolean>(false);
  // Which modifier's combination matrix is shown in the chords section.
  const [chordTab, setChordTab] = useState<string>('left_bumper');
  const [lastActiveInfo, setLastActiveInfo] = useState<LiveButtonEvent | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<{
    running: boolean;
    remote_url: string;
    local_ip: string;
    all_urls?: string[];
  }>({
    running: false,
    remote_url: `http://127.0.0.1:${remoteControlPort}/remote`,
    local_ip: '127.0.0.1',
  });
  const [copied, setCopied] = useState(false);
  const [showRemotePrompt, setShowRemotePrompt] = useState(false);
  const [showRemoteSteps, setShowRemoteSteps] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // One-time opt-in prompt: show it the first time this tab is opened, and only
  // while the remote is still disabled. The localStorage flag is written as soon
  // as the prompt is shown, so it never nags again regardless of the choice.
  useEffect(() => {
    const KEY = 'ynotv:phoneRemotePromptSeen';
    try {
      if (localStorage.getItem(KEY)) return;
      localStorage.setItem(KEY, '1');
    } catch {
      return;
    }
    if (!remoteControlEnabled) {
      setShowRemotePrompt(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-time pairing guide: show the how-it-works steps while the server is
  // enabled, until the user dismisses them with "Got it". Returning users who
  // already dismissed the guide never see it again.
  useEffect(() => {
    if (!remoteControlEnabled) return;
    try {
      if (localStorage.getItem('ynotv:phoneRemoteStepsDismissed')) return;
      setShowRemoteSteps(true);
    } catch {}
  }, [remoteControlEnabled]);

  const dismissRemoteSteps = () => {
    setShowRemoteSteps(false);
    try {
      localStorage.setItem('ynotv:phoneRemoteStepsDismissed', '1');
    } catch {}
  };

  // Query server status and start if enabled. A just-stopped server releases
  // its port asynchronously, so a quick off→on can transiently fail to re-bind;
  // retry with short backoff, then surface the real error instead of leaving
  // the toggle on with a dead server.
  const refreshServer = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (remoteControlEnabled) {
        let lastErr: unknown = null;
        for (const delay of [0, 600, 1600]) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          // Bail out if the user toggled again while we were waiting — a stale
          // retry must never (re)start the server after they turned it off.
          if (!remoteEnabledRef.current) return;
          try {
            const res = await invoke<any>('web_serve_start', { port: remoteControlPort });
            if (res) {
              setRemoteStatus(res);
              setServerError(null);
            }
            return;
          } catch (e) {
            lastErr = e;
          }
        }
        console.warn('[ControllersTab] Server start failed:', lastErr);
        setServerError(typeof lastErr === 'string' ? lastErr : 'Failed to start server');
        try {
          const status = await invoke<any>('web_serve_status');
          if (status) setRemoteStatus(status);
        } catch {}
      } else {
        await invoke('web_serve_stop');
        setServerError(null);
        const status = await invoke<any>('web_serve_status');
        if (status) setRemoteStatus(status);
      }
    } catch (e) {
      console.warn('[ControllersTab] Server sync error:', e);
      // Keep the pill truthful: re-query the server instead of assuming.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await invoke<any>('web_serve_status');
        if (status) setRemoteStatus(status);
      } catch {}
    }
  };

  useEffect(() => {
    refreshServer();
  }, [remoteControlEnabled, remoteControlPort]);

  // Poll connected devices and subscribe to live button presses
  useEffect(() => {
    const queryGamepads = async () => {
      const detected: GamepadDeviceInfo[] = [];

      // Check browser gamepads (Standard and Bluetooth DualSense)
      if (typeof navigator !== 'undefined' && navigator.getGamepads) {
        const gps = navigator.getGamepads();
        for (let i = 0; i < gps.length; i++) {
          const gp = gps[i];
          if (gp && gp.connected) {
            detected.push({
              id: gp.index,
              name: gp.id || `Gamepad ${gp.index + 1}`,
              is_connected: true,
              uuid: gp.id,
            });
          }
        }
      }

      // Check Tauri Rust backend
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const list = await invoke<GamepadDeviceInfo[]>('get_connected_gamepads');
        if (Array.isArray(list)) {
          list.forEach((item) => {
            // Dedupe by exact name/id, and by normalized base name — the same
            // pad can be reported twice with different suffixes (Chromium's
            // "…(STANDARD GAMEPAD Vendor: 054c …)" vs the raw HID backend's
            // "…(HID 054c:0ce6)"), which would otherwise double-list it.
            const base = (n: string) => n.toLowerCase().split('(')[0].trim();
            if (
              !detected.some(
                (d) => d.name === item.name || d.id === item.id || base(d.name) === base(item.name)
              )
            ) {
              detected.push(item);
            }
          });
        }
      } catch {}

      setConnectedDevices(detected);
    };

    queryGamepads();
    const interval = setInterval(queryGamepads, 1500);

    const unsubscribe = subscribeGamepadButtonPress((event) => {
      setLastActiveBtn(event.action);
      setLastActiveInfo(event);
      setTimeout(() => setLastActiveBtn(''), 500);
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  const handleMappingChange = (buttonId: string, actionId: string) => {
    setControllerMappings({
      ...controllerMappings,
      [buttonId]: actionId,
    });
  };

  const handleChordChange = (modifierId: string, baseId: string, actionId: string) => {
    setControllerChords({
      ...controllerChords,
      [`${modifierId}+${baseId}`]: actionId,
    });
  };

  const copyUrl = (urlToCopy?: string) => {
    const target = urlToCopy || remoteStatus.remote_url;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(target);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const openInBrowser = async () => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(remoteStatus.remote_url);
    } catch {
      window.open(remoteStatus.remote_url, '_blank');
    }
  };

  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  useEffect(() => {
    if (!remoteStatus.remote_url) return;
    generateQrDataUrl(remoteStatus.remote_url, 240)
      .then(setQrDataUrl)
      .catch((e) => console.error('[ControllersTab] QR code generation error:', e));
  }, [remoteStatus.remote_url]);

  return (
    <div className="settings-tab-content controllers-tab">
      {/* Gamepad & Controller Section */}
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:controllers.title')}</h3>
        </div>
        <p className="section-description">{i18n.t('settings:controllers.description')}</p>

        <div className="timeshift-toggle-row">
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:controllers.enableNavigation')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:controllers.enableNavigationHint')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={controllerEnabled}
              onChange={(e) => setControllerEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="timeshift-toggle-row">
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:controllers.backgroundListening')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:controllers.backgroundListeningHint')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={controllerBackgroundListening}
              onChange={(e) => setControllerBackgroundListening(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* Live Detected Controllers Status & Interactive Visualizer */}
        <div className="device-status-card">
          <div className="device-status-header">
            <span className="device-icon">🎮</span>
            <div className="device-info-main">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="device-status-title">
                  {connectedDevices.length > 0
                    ? i18n.t('settings:controllers.connectedCount', { count: connectedDevices.length })
                    : i18n.t('settings:controllers.noGamepads')}
                </span>
                {connectedDevices.some((d) => customGamepadProfiles[d.name]) && (
                  <span className="custom-profile-badge">
                    {i18n.t('settings:controllers.customProfileActive', { defaultValue: 'Custom Profile Active' })}
                  </span>
                )}
              </div>
              <span className="device-status-sub">
                {connectedDevices.length > 0
                  ? connectedDevices.map((d) => d.name).join(', ')
                  : i18n.t('settings:controllers.connectHint')}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button
                type="button"
                className="remap-launch-btn"
                onClick={() => setIsRemapModalOpen(true)}
                title={i18n.t('settings:controllers.remapBtnTooltip', {
                  defaultValue: 'Calibrate and map buttons for any generic or 3rd-party gamepad',
                })}
              >
                ⚙️ {i18n.t('settings:controllers.remapBtn', { defaultValue: 'Calibrate / Configure Gamepad' })}
              </button>

              <span
                className={`device-pill ${
                  connectedDevices.length > 0 ? 'pill-connected' : 'pill-disconnected'
                }`}
              >
                {connectedDevices.length > 0
                  ? i18n.t('settings:controllers.ready')
                  : i18n.t('settings:controllers.scanning')}
              </span>
            </div>
          </div>

          {/* Interactive Controller SVG Live Preview */}
          <ControllerVisualizer
            connectedDevices={connectedDevices}
            activeLayout={controllerVisualizerLayout}
            onLayoutChange={setControllerVisualizerLayout}
          />
        </div>

        {/* Stick Sensitivity / Deadzone */}
        <div className="timeshift-toggle-row" style={{ borderBottom: 'none', marginTop: '12px' }}>
          <div className="timeshift-toggle-info" style={{ flex: 1, minWidth: 0, paddingRight: '16px' }}>
            <span className="timeshift-toggle-label">
              {i18n.t('settings:controllers.deadzoneLabel', {
                percent: Math.round(controllerDeadzone * 100),
              })}
            </span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:controllers.deadzoneHint')}</span>
          </div>
          <div className="deadzone-slider-control">
            <input
              type="range"
              min="0.10"
              max="0.80"
              step="0.05"
              value={controllerDeadzone}
              onChange={(e) => setControllerDeadzone(parseFloat(e.target.value))}
              className="deadzone-range-input"
            />
            <span className="deadzone-value-badge">
              {Math.round(controllerDeadzone * 100)}%
            </span>
          </div>
        </div>

        {/* D-Pad Hold-To-Repeat */}
        <div className="timeshift-toggle-row" style={{ borderBottom: 'none', marginTop: '12px' }}>
          <div className="timeshift-toggle-info" style={{ flex: 1, minWidth: 0, paddingRight: '16px' }}>
            <span className="timeshift-toggle-label">
              {i18n.t('settings:controllers.repeatDelayLabel', { ms: controllerRepeatDelayMs })}
            </span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:controllers.repeatDelayHint')}</span>
          </div>
          <div className="deadzone-slider-control">
            <input
              type="range"
              min="100"
              max="1000"
              step="25"
              value={controllerRepeatDelayMs}
              onChange={(e) => setControllerRepeatDelayMs(parseInt(e.target.value, 10))}
              className="deadzone-range-input"
            />
            <span className="deadzone-value-badge">{controllerRepeatDelayMs} ms</span>
          </div>
        </div>
        <div className="timeshift-toggle-row" style={{ borderBottom: 'none', marginTop: '12px' }}>
          <div className="timeshift-toggle-info" style={{ flex: 1, minWidth: 0, paddingRight: '16px' }}>
            <span className="timeshift-toggle-label">
              {i18n.t('settings:controllers.repeatSpeedLabel')}
            </span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:controllers.repeatSpeedHint')}</span>
          </div>
          <div className="deadzone-slider-control">
            <input
              type="range"
              min="40"
              max="500"
              step="10"
              value={controllerRepeatIntervalMs}
              onChange={(e) => setControllerRepeatIntervalMs(parseInt(e.target.value, 10))}
              className="deadzone-range-input"
            />
            <span className="deadzone-value-badge">{controllerRepeatIntervalMs} ms</span>
          </div>
        </div>
      </div>

      {/* Built-in Phone Remote Server */}
      <div className="settings-section phone-remote-section">
        {showRemotePrompt && (
          <div className="phone-remote-prompt">
            <div className="phone-remote-prompt-info">
              <strong className="phone-remote-prompt-title">
                {i18n.t('settings:controllers.remote.enablePromptTitle')}
              </strong>
              <span className="phone-remote-prompt-text">
                {i18n.t('settings:controllers.remote.enablePromptText')}
              </span>
            </div>
            <div className="phone-remote-prompt-actions">
              <button
                className="phone-remote-prompt-btn primary"
                onClick={() => {
                  setRemoteControlEnabled(true);
                  setShowRemotePrompt(false);
                }}
              >
                {i18n.t('settings:controllers.remote.enable')}
              </button>
              <button className="phone-remote-prompt-btn" onClick={() => setShowRemotePrompt(false)}>
                {i18n.t('settings:controllers.remote.notNow')}
              </button>
            </div>
          </div>
        )}

        <div className="section-header">
          <h3>{i18n.t('settings:controllers.remote.title')}</h3>
          <span
            className={`device-pill ${
              remoteStatus.running ? 'pill-connected' : 'pill-disconnected'
            }`}
          >
            {remoteStatus.running
              ? i18n.t('settings:controllers.remote.serverActive', { port: remoteControlPort })
              : i18n.t('settings:controllers.remote.serverStopped')}
          </span>
        </div>
        <p className="section-description">{i18n.t('settings:controllers.remote.description')}</p>

        <div className="timeshift-toggle-row">
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:controllers.remote.enableServer')}</span>
            <span className="timeshift-toggle-sub">
              {remoteControlEnabled
                ? i18n.t('settings:controllers.remote.enabledHint', {
                    url: `http://${remoteStatus.local_ip}:${remoteControlPort}/remote`,
                  })
                : i18n.t('settings:controllers.remote.disabledHint')}
            </span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteControlEnabled}
              onChange={(e) => setRemoteControlEnabled(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {serverError && (
          <div className="phone-remote-error">
            <strong>{i18n.t('settings:controllers.remote.serverFailed')}</strong>
            <span>{serverError}</span>
            <button className="phone-remote-steps-dismiss" onClick={refreshServer}>
              {i18n.t('settings:controllers.remote.retry')}
            </button>
          </div>
        )}

        {remoteControlEnabled && showRemoteSteps && (
          <div className="phone-remote-steps">
            <div className="phone-remote-steps-header">
              <span className="phone-remote-steps-title">{i18n.t('settings:controllers.remote.howItWorks')}</span>
              <button className="phone-remote-steps-dismiss" onClick={dismissRemoteSteps}>
                {i18n.t('settings:controllers.remote.gotIt')}
              </button>
            </div>
            <ol className="phone-remote-steps-list">
              <li>{i18n.t('settings:controllers.remote.step1')}</li>
              <li>{i18n.t('settings:controllers.remote.step2')}</li>
              <li>{i18n.t('settings:controllers.remote.step3')}</li>
              <li>{i18n.t('settings:controllers.remote.step4')}</li>
            </ol>
          </div>
        )}

        {remoteControlEnabled && (
          <div className="phone-remote-card">
            <div className="remote-qr-box">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={i18n.t('settings:controllers.remote.qrAlt')}
                  className="qr-img"
                  style={{
                    width: '160px',
                    height: '160px',
                    borderRadius: '10px',
                    background: '#ffffff',
                    padding: '8px',
                    boxShadow: '0 4px 14px rgba(0,0,0,0.3)',
                    display: 'block',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: '160px',
                    height: '160px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#ffffff',
                    borderRadius: '10px',
                    color: '#64748b',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  {i18n.t('settings:controllers.remote.generatingQr')}
                </div>
              )}
              <span className="qr-hint">{i18n.t('settings:controllers.remote.scanHint')}</span>
            </div>
            <div className="remote-details">
              <span className="remote-url-label">{i18n.t('settings:controllers.remote.openUrlLabel')}</span>
              <div className="remote-url-bar">
                <span className="remote-url-text">{remoteStatus.remote_url}</span>
                <button className="copy-btn" onClick={() => copyUrl(remoteStatus.remote_url)}>
                  {copied
                    ? i18n.t('settings:controllers.remote.copied')
                    : i18n.t('settings:controllers.remote.copy')}
                </button>
                <button
                  className="open-btn"
                  onClick={openInBrowser}
                  title={i18n.t('settings:controllers.remote.testInBrowser')}
                >
                  {i18n.t('settings:controllers.remote.open')}
                </button>
              </div>

              {remoteStatus.all_urls && remoteStatus.all_urls.length > 1 && (
                <div className="alt-urls-box">
                  <span className="alt-urls-title">{i18n.t('settings:controllers.remote.altUrlsTitle')}</span>
                  <div className="alt-urls-list">
                    {remoteStatus.all_urls.map((url) => (
                      <button
                        key={url}
                        className="alt-url-pill"
                        onClick={() => copyUrl(url)}
                        title={i18n.t('settings:controllers.remote.clickToCopy')}
                      >
                        {url}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="remote-instructions">{i18n.t('settings:controllers.remote.instructions')}</p>

              <div style={{ marginTop: '4px' }}>
                <button className="restart-server-btn" onClick={refreshServer}>
                  {i18n.t('settings:controllers.remote.restartServer', { port: remoteControlPort })}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Button Customization Matrix */}
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:controllers.mapping.title')}</h3>
          <button className="reset-btn" onClick={resetControllerMappings}>
            {i18n.t('settings:controllers.mapping.reset')}
          </button>
        </div>
        <p className="section-description">{i18n.t('settings:controllers.mapping.description')}</p>

        <div className="mapping-grid">
          {BUTTON_CONFIG.map((btn) => (
            <div key={btn.id} className="mapping-card">
              <div className="mapping-label-box">
                <span className="mapping-group">
                  {i18n.t(`settings:controllers.mapping.groups.${btn.group}`, {
                    defaultValue: btn.group,
                  })}
                </span>
                <span className="mapping-btn-name">
                  {i18n.t(`settings:controllers.mapping.buttons.${btn.id}`, {
                    defaultValue: btn.id,
                  })}
                </span>
              </div>
              <select
                className="mapping-select"
                value={
                  (controllerMappings[btn.id] || DEFAULT_CONTROLLER_MAPPINGS[btn.id]) === 'toggle_guide'
                    ? 'toggle_livetv'
                    : controllerMappings[btn.id] || DEFAULT_CONTROLLER_MAPPINGS[btn.id] || 'none'
                }
                onChange={(e) => handleMappingChange(btn.id, e.target.value)}
              >
                {AVAILABLE_ACTIONS.map((act) => (
                  <option key={act.id} value={act.id}>
                    {i18n.t(`settings:controllers.mapping.actions.${act.id}`, {
                      defaultValue: act.id,
                    })}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Button Combination Matrix — hold a modifier (L1/L2/R1/R2) + a button */}
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:controllers.chords.title')}</h3>
          <button className="reset-btn" onClick={resetControllerChords}>
            {i18n.t('settings:controllers.chords.reset')}
          </button>
        </div>
        <p className="section-description">{i18n.t('settings:controllers.chords.description')}</p>

        <div className="settings-tabs" style={{ marginBottom: 14, padding: '0 4px' }}>
          {CHORD_MODIFIERS.map((mod) => (
            <button
              key={mod.id}
              className={`settings-tab ${chordTab === mod.id ? 'active' : ''}`}
              onClick={() => setChordTab(mod.id)}
            >
              {i18n.t(`settings:controllers.chords.modifiers.${mod.id}`, {
                defaultValue: mod.id,
              })}
            </button>
          ))}
        </div>

        <div className="mapping-grid">
          {CHORD_BASE_BUTTONS.map((base) => {
            const chordKey = `${chordTab}+${base.id}`;
            return (
              <div key={chordKey} className="mapping-card chord-card">
                <div className="mapping-label-box">
                  <span className="mapping-group">
                    {i18n.t(`settings:controllers.chords.modifiers.${chordTab}`, {
                      defaultValue: chordTab,
                    })}
                  </span>
                  <span className="mapping-btn-name">
                    +{' '}
                    {i18n.t(`settings:controllers.mapping.buttons.${base.id}`, {
                      defaultValue: base.id,
                    })}
                  </span>
                </div>
                <select
                  className="mapping-select"
                  value={controllerChords[chordKey] || DEFAULT_CONTROLLER_CHORDS[chordKey] || 'none'}
                  onChange={(e) => handleChordChange(chordTab, base.id, e.target.value)}
                >
                  {AVAILABLE_ACTIONS.map((act) => (
                    <option key={act.id} value={act.id}>
                      {i18n.t(`settings:controllers.mapping.actions.${act.id}`, {
                        defaultValue: act.id,
                      })}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Generic Gamepad Calibration / Remap Modal */}
      <ControllerRemapModal
        isOpen={isRemapModalOpen}
        onClose={() => setIsRemapModalOpen(false)}
        connectedDevices={connectedDevices}
      />
    </div>
  );
}
