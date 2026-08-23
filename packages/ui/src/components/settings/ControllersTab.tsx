import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore, DEFAULT_CONTROLLER_MAPPINGS } from '../../stores/settingsStore';
import { subscribeGamepadButtonPress, type GamepadDeviceInfo, type LiveButtonEvent } from '../../hooks/useGamepad';
import { generateQrDataUrl } from '../../utils/qrCode';
import './ControllersTab.css';

const AVAILABLE_ACTIONS: Array<{ id: string; label: string }> = [
  { id: 'select', label: 'Select / Play (Click)' },
  { id: 'back', label: 'Back / Close Dialog' },
  { id: 'nav_up', label: 'Navigate Up' },
  { id: 'nav_down', label: 'Navigate Down' },
  { id: 'nav_left', label: 'Navigate Left' },
  { id: 'nav_right', label: 'Navigate Right' },
  { id: 'play_pause', label: 'Play / Pause Toggle' },
  { id: 'seek_forward', label: 'Fast Forward (+10s)' },
  { id: 'seek_backward', label: 'Rewind (-10s)' },
  { id: 'next_channel', label: 'Next Channel (Channel Up)' },
  { id: 'prev_channel', label: 'Previous Channel (Channel Down)' },
  { id: 'toggle_fullscreen', label: 'Toggle Fullscreen' },
  { id: 'toggle_mute', label: 'Toggle Mute' },
  { id: 'search', label: 'Search' },
  { id: 'subtitles', label: 'Audio & Subtitle Tracks' },
  { id: 'toggle_livetv', label: 'Toggle LiveTV' },
  { id: 'toggle_nuvio', label: 'Toggle Nuvio' },
  { id: 'toggle_stremio', label: 'Toggle Stremio' },
  { id: 'toggle_transparent_overlay', label: 'Toggle Transparent Overlay' },
  { id: 'toggle_overlay', label: 'Toggle Overlay' },
  { id: 'toggle_live_game_sidebar', label: 'Open Live Games' },
  { id: 'open_movies', label: 'Open Movies' },
  { id: 'open_series', label: 'Open TV Series' },
  { id: 'open_sports', label: 'Open Sports Hub' },
  { id: 'open_settings', label: 'Open Settings' },
  { id: 'none', label: 'None (Unassigned)' },
];

const BUTTON_CONFIG: Array<{ id: string; label: string; group: string }> = [
  { id: 'south', label: 'A / Cross (Bottom Button)', group: 'Face Buttons' },
  { id: 'east', label: 'B / Circle (Right Button)', group: 'Face Buttons' },
  { id: 'west', label: 'X / Square (Left Button)', group: 'Face Buttons' },
  { id: 'north', label: 'Y / Triangle (Top Button)', group: 'Face Buttons' },
  { id: 'dpad_up', label: 'D-Pad Up', group: 'D-Pad' },
  { id: 'dpad_down', label: 'D-Pad Down', group: 'D-Pad' },
  { id: 'dpad_left', label: 'D-Pad Left', group: 'D-Pad' },
  { id: 'dpad_right', label: 'D-Pad Right', group: 'D-Pad' },
  { id: 'left_bumper', label: 'L1 / LB (Left Bumper)', group: 'Shoulder & Triggers' },
  { id: 'right_bumper', label: 'R1 / RB (Right Bumper)', group: 'Shoulder & Triggers' },
  { id: 'left_trigger', label: 'L2 / LT (Left Trigger)', group: 'Shoulder & Triggers' },
  { id: 'right_trigger', label: 'R2 / RT (Right Trigger)', group: 'Shoulder & Triggers' },
  { id: 'left_stick_click', label: 'L3 (Left Stick Click)', group: 'Thumbsticks' },
  { id: 'right_stick_click', label: 'R3 (Right Stick Click)', group: 'Thumbsticks' },
  { id: 'start', label: 'Start / Options / Menu', group: 'Menu' },
  { id: 'select', label: 'Select / Share / Create', group: 'Menu' },
];

export function ControllersTab() {
  const controllerEnabled = useSettingsStore((s) => s.controllerEnabled);
  const setControllerEnabled = useSettingsStore((s) => s.setControllerEnabled);
  const controllerBackgroundListening = useSettingsStore((s) => s.controllerBackgroundListening);
  const setControllerBackgroundListening = useSettingsStore((s) => s.setControllerBackgroundListening);
  const controllerDeadzone = useSettingsStore((s) => s.controllerDeadzone);
  const setControllerDeadzone = useSettingsStore((s) => s.setControllerDeadzone);
  const controllerMappings = useSettingsStore((s) => s.controllerMappings);
  const setControllerMappings = useSettingsStore((s) => s.setControllerMappings);
  const resetControllerMappings = useSettingsStore((s) => s.resetControllerMappings);

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
            if (!detected.some((d) => d.name === item.name || d.id === item.id)) {
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
        <h3 className="section-title">Gamepad & Controller Support</h3>
        <p className="section-desc">
          Navigate YNOTV with any PS5 DualSense (Bluetooth or USB), PS4, Xbox, Switch Pro, or TV remote.
        </p>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Enable Controller Navigation</span>
            <span className="setting-sublabel">
              Control channels, menus, movies, sports, and video playback with connected gamepads.
              Off by default — enable it to start listening for controller input.
            </span>
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

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Listen When App Is Not Focused</span>
            <span className="setting-sublabel">
              Process controller input while YNOTV is running in the background. Off by default —
              inputs are ignored unless the app window is focused.
            </span>
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

        {/* Live Detected Controllers Status */}
        <div className="device-status-card">
          <div className="device-status-header">
            <span className="device-icon">🎮</span>
            <div className="device-info-main">
              <span className="device-status-title">
                {connectedDevices.length > 0
                  ? `${connectedDevices.length} Controller${connectedDevices.length > 1 ? 's' : ''} Connected`
                  : 'No Gamepads Detected'}
              </span>
              <span className="device-status-sub">
                {connectedDevices.length > 0
                  ? connectedDevices.map((d) => d.name).join(', ')
                  : 'Connect a Bluetooth or USB controller (DualSense 5, Xbox, Switch Pro) to begin'}
              </span>
            </div>
            <span
              className={`device-pill ${
                connectedDevices.length > 0 ? 'pill-connected' : 'pill-disconnected'
              }`}
            >
              {connectedDevices.length > 0 ? 'Ready' : 'Scanning'}
            </span>
          </div>

          {/* Live Button Visualizer */}
          <div className="live-tester">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="tester-label">Live Button Monitor (Press any button on controller):</span>
              {lastActiveInfo && (
                <span className="live-telemetry">
                  Last Detected: <strong>{lastActiveInfo.rawLabel}</strong>
                </span>
              )}
            </div>
            <div className="tester-buttons">
              {[
                { id: 'south', name: 'A / Cross' },
                { id: 'east', name: 'B / Circle' },
                { id: 'west', name: 'X / Square' },
                { id: 'north', name: 'Y / Triangle' },
                { id: 'dpad_up', name: 'D-Pad ▲' },
                { id: 'dpad_down', name: 'D-Pad ▼' },
                { id: 'dpad_left', name: 'D-Pad ◀' },
                { id: 'dpad_right', name: 'D-Pad ▶' },
                { id: 'left_bumper', name: 'L1' },
                { id: 'right_bumper', name: 'R1' },
                { id: 'left_trigger', name: 'L2' },
                { id: 'right_trigger', name: 'R2' },
                { id: 'left_stick_click', name: 'L3' },
                { id: 'right_stick_click', name: 'R3' },
                { id: 'start', name: 'Options' },
                { id: 'select', name: 'Share' },
              ].map((btn) => (
                <span
                  key={btn.id}
                  className={`tester-btn ${lastActiveBtn === btn.id ? 'active' : ''}`}
                >
                  {btn.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Stick Sensitivity / Deadzone */}
        <div className="setting-row" style={{ marginTop: '16px' }}>
          <div className="setting-info" style={{ flex: 1, minWidth: 0, paddingRight: '16px' }}>
            <span className="setting-label">
              Analog Stick Deadzone ({Math.round(controllerDeadzone * 100)}%)
            </span>
            <span className="setting-sublabel">
              Prevents stick drift by setting the minimum tilt required before moving focus
            </span>
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
      </div>

      {/* Built-in Phone Remote Server */}
      <div className="settings-section">
        {showRemotePrompt && (
          <div className="phone-remote-prompt">
            <div className="phone-remote-prompt-info">
              <strong className="phone-remote-prompt-title">Enable Phone Remote?</strong>
              <span className="phone-remote-prompt-text">
                Control YNOTV from your phone over Wi-Fi — a touchpad, D-pad, and media remote. The
                local server is off by default and starts only when you turn it on.
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
                Enable
              </button>
              <button className="phone-remote-prompt-btn" onClick={() => setShowRemotePrompt(false)}>
                Not now
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 className="section-title">Virtual Phone Remote (No Hardware Needed)</h3>
            <p className="section-desc">
              Turn any smartphone into a wireless TV touchpad, D-pad, and media remote over your local Wi-Fi.
              Off by default — enable it to start the local server.
            </p>
          </div>
          <span
            className={`device-pill ${
              remoteStatus.running ? 'pill-connected' : 'pill-disconnected'
            }`}
          >
            {remoteStatus.running ? `Server Active (Port ${remoteControlPort})` : 'Server Stopped'}
          </span>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Enable Phone Remote Server</span>
            <span className="setting-sublabel">
              {remoteControlEnabled
                ? `Hosts a wireless web remote at http://${remoteStatus.local_ip}:${remoteControlPort}/remote`
                : 'Once enabled, a QR code and connection URL appear below for pairing your phone.'}
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
            <strong>Server failed to start.</strong>
            <span>{serverError}</span>
            <button className="phone-remote-steps-dismiss" onClick={refreshServer}>
              Retry
            </button>
          </div>
        )}

        {remoteControlEnabled && showRemoteSteps && (
          <div className="phone-remote-steps">
            <div className="phone-remote-steps-header">
              <span className="phone-remote-steps-title">How it works</span>
              <button className="phone-remote-steps-dismiss" onClick={dismissRemoteSteps}>
                Got it
              </button>
            </div>
            <ol className="phone-remote-steps-list">
              <li>Keep the YNOTV app running on this PC.</li>
              <li>Scan the QR code with your phone&apos;s camera — or open the URL below.</li>
              <li>Control YNOTV from your phone: touchpad, D-pad, and media remote.</li>
            </ol>
          </div>
        )}

        {remoteControlEnabled && (
          <div className="phone-remote-card">
            <div className="remote-qr-box">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Remote QR Code"
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
                  Generating QR...
                </div>
              )}
              <span className="qr-hint">Scan with phone camera</span>
            </div>
            <div className="remote-details">
              <span className="remote-url-label">Open on your phone's browser:</span>
              <div className="remote-url-bar">
                <span className="remote-url-text">{remoteStatus.remote_url}</span>
                <button className="copy-btn" onClick={() => copyUrl(remoteStatus.remote_url)}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
                <button className="open-btn" onClick={openInBrowser} title="Test in local browser">
                  Open
                </button>
              </div>

              {remoteStatus.all_urls && remoteStatus.all_urls.length > 1 && (
                <div className="alt-urls-box">
                  <span className="alt-urls-title">Alternative Network Addresses:</span>
                  <div className="alt-urls-list">
                    {remoteStatus.all_urls.map((url) => (
                      <button
                        key={url}
                        className="alt-url-pill"
                        onClick={() => copyUrl(url)}
                        title="Click to copy"
                      >
                        {url}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="remote-instructions">
                Make sure your phone is connected to the same Wi-Fi network as this PC. You will have a full wireless touchpad, D-Pad, volume controls, and section shortcuts!
              </p>

              <div style={{ marginTop: '4px' }}>
                <button className="restart-server-btn" onClick={refreshServer}>
                  🔄 Restart Server on Port {remoteControlPort}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Button Customization Matrix */}
      <div className="settings-section">
        <div className="matrix-header">
          <div>
            <h3 className="section-title">Button Mapping Customization</h3>
            <p className="section-desc">Choose what each controller button does</p>
          </div>
          <button className="reset-btn" onClick={resetControllerMappings}>
            Reset to Defaults
          </button>
        </div>

        <div className="mapping-grid">
          {BUTTON_CONFIG.map((btn) => (
            <div key={btn.id} className="mapping-card">
              <div className="mapping-label-box">
                <span className="mapping-group">{btn.group}</span>
                <span className="mapping-btn-name">{btn.label}</span>
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
                    {act.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
