import React, { useState, useEffect } from 'react';
import { useSettingsStore, DEFAULT_CONTROLLER_MAPPINGS } from '../../stores/settingsStore';
import { subscribeGamepadButtonPress, type GamepadDeviceInfo, type LiveButtonEvent } from '../../hooks/useGamepad';
import { generateQrSvg } from '../../utils/qrCode';
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
  { id: 'toggle_guide', label: 'TV Guide (EPG)' },
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
  const controllerDeadzone = useSettingsStore((s) => s.controllerDeadzone);
  const setControllerDeadzone = useSettingsStore((s) => s.setControllerDeadzone);
  const controllerMappings = useSettingsStore((s) => s.controllerMappings);
  const setControllerMappings = useSettingsStore((s) => s.setControllerMappings);
  const resetControllerMappings = useSettingsStore((s) => s.resetControllerMappings);

  const remoteControlEnabled = useSettingsStore((s) => s.remoteControlEnabled);
  const setRemoteControlEnabled = useSettingsStore((s) => s.setRemoteControlEnabled);
  const remoteControlPort = useSettingsStore((s) => s.remoteControlPort);

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

  // Query server status and start if enabled
  const refreshServer = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (remoteControlEnabled) {
        const res = await invoke<any>('web_serve_start', { port: remoteControlPort });
        if (res) setRemoteStatus(res);
      } else {
        await invoke('web_serve_stop');
        const status = await invoke<any>('web_serve_status');
        if (status) setRemoteStatus(status);
      }
    } catch (e) {
      console.warn('[ControllersTab] Server sync error:', e);
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

  const qrSvgString = generateQrSvg(remoteStatus.remote_url, 150);

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
              Control channels, menus, movies, sports, and video playback with connected gamepads
            </span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={controllerEnabled}
              onChange={(e) => setControllerEnabled(e.target.checked)}
            />
            <span className="slider round"></span>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 className="section-title">Virtual Phone Remote (No Hardware Needed)</h3>
            <p className="section-desc">
              Turn any smartphone into a wireless TV touchpad, D-pad, and media remote over your local Wi-Fi.
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
              Hosts a wireless web remote at http://{remoteStatus.local_ip}:{remoteControlPort}/remote
            </span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={remoteControlEnabled}
              onChange={(e) => setRemoteControlEnabled(e.target.checked)}
            />
            <span className="slider round"></span>
          </label>
        </div>

        {remoteControlEnabled && (
          <div className="phone-remote-card">
            <div className="remote-qr-box">
              <div
                className="qr-svg-wrapper"
                dangerouslySetInnerHTML={{ __html: qrSvgString }}
              />
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
                value={controllerMappings[btn.id] || DEFAULT_CONTROLLER_MAPPINGS[btn.id] || 'none'}
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
