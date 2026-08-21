import { useEffect, useState, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { dispatchSpatialNav } from '../services/spatialNavigation';

export interface GamepadDeviceInfo {
  id: number;
  name: string;
  is_connected: boolean;
  uuid: string;
}

export interface GamepadEventPayload {
  action: string;
  button: string;
  pressed: boolean;
  gamepad_id: number;
  gamepad_name: string;
}

export interface LiveButtonEvent {
  action: string;
  rawLabel: string;
  deviceName: string;
}

// Global button listener registry for live visualizer
const buttonListeners = new Set<(event: LiveButtonEvent) => void>();

export function subscribeGamepadButtonPress(cb: (event: LiveButtonEvent) => void): () => void {
  buttonListeners.add(cb);
  return () => buttonListeners.delete(cb);
}

function notifyButtonPressed(action: string, rawLabel: string = action, deviceName: string = 'Gamepad') {
  const payload: LiveButtonEvent = { action, rawLabel, deviceName };
  buttonListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch {}
  });
}

// Standard HTML5 Gamepad Layout
const STANDARD_BUTTON_MAP: Record<number, string> = {
  0: 'south', // A / Cross
  1: 'east', // B / Circle
  2: 'west', // X / Square
  3: 'north', // Y / Triangle
  4: 'left_bumper', // L1
  5: 'right_bumper', // R1
  6: 'left_trigger', // L2
  7: 'right_trigger', // R2
  8: 'select', // Share / Create
  9: 'start', // Options / Start
  10: 'left_stick_click', // L3
  11: 'right_stick_click', // R3
  12: 'dpad_up', // D-Pad Up
  13: 'dpad_down', // D-Pad Down
  14: 'dpad_left', // D-Pad Left
  15: 'dpad_right', // D-Pad Right
  16: 'guide', // PS Button / Home
  17: 'touchpad', // Touchpad Click
};

// DualSense / DualShock DirectInput Bluetooth Layout (when mapping !== 'standard')
const DUALSENSE_BT_MAP: Record<number, string> = {
  0: 'west', // Square
  1: 'south', // Cross
  2: 'east', // Circle
  3: 'north', // Triangle
  4: 'left_bumper', // L1
  5: 'right_bumper', // R1
  6: 'left_trigger', // L2
  7: 'right_trigger', // R2
  8: 'select', // Share / Create
  9: 'start', // Options
  10: 'left_stick_click', // L3
  11: 'right_stick_click', // R3
  12: 'guide', // PS Button
  13: 'touchpad', // Touchpad Click
  14: 'dpad_up',
  15: 'dpad_down',
  16: 'dpad_left',
  17: 'dpad_right',
};

export function useGamepad() {
  const controllerEnabled = useSettingsStore((s) => s.controllerEnabled);
  const controllerMappings = useSettingsStore((s) => s.controllerMappings);
  const controllerDeadzone = useSettingsStore((s) => s.controllerDeadzone);
  const [connectedGamepads, setConnectedGamepads] = useState<GamepadDeviceInfo[]>([]);

  const mappingsRef = useRef(controllerMappings);
  mappingsRef.current = controllerMappings;

  const enabledRef = useRef(controllerEnabled);
  enabledRef.current = controllerEnabled;

  const deadzoneRef = useRef(controllerDeadzone);
  deadzoneRef.current = controllerDeadzone;

  // When the browser Gamepad API reports any connected pad, it is the active
  // input source and the native gilrs backend is suppressed. Most controllers
  // are visible to BOTH sources, so without this every press would dispatch
  // twice (double-steps in menus). gilrs remains the fallback for webviews
  // where the Gamepad API exposes no devices.
  const browserHasGamepadsRef = useRef(false);

  // 1. Tauri Native Backend Listener (gilrs & Phone Remote Server)
  useEffect(() => {
    let unlistenGamepad: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;
    let unlistenRemote: (() => void) | null = null;
    let isCancelled = false;

    const setupTauri = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');

        if (isCancelled) return;

        // Query initial gamepads from Rust
        invoke<GamepadDeviceInfo[]>('get_connected_gamepads')
          .then((list) => {
            if (!isCancelled && Array.isArray(list) && list.length > 0) {
              setConnectedGamepads((prev) => {
                const combined = [...prev];
                list.forEach((item) => {
                  if (!combined.some((c) => c.name === item.name || c.id === item.id)) {
                    combined.push(item);
                  }
                });
                return combined;
              });
            }
          })
          .catch(() => {});

        // Listen for connection / disconnection
        unlistenStatus = await listen<{ gamepads: GamepadDeviceInfo[] }>(
          'ynotv://gamepad-status',
          (event) => {
            if (!isCancelled && event.payload?.gamepads) {
              setConnectedGamepads((prev) => {
                const list = event.payload.gamepads;
                const combined = [...list];
                prev.forEach((item) => {
                  if (!combined.some((c) => c.name === item.name || c.id === item.id)) {
                    combined.push(item);
                  }
                });
                return combined;
              });
            }
          }
        );

        // Listen for controller button / stick events from Rust
        unlistenGamepad = await listen<GamepadEventPayload>('ynotv://gamepad', (event) => {
          const rawAction = event.payload?.action;
          const pressed = event.payload?.pressed;
          const gpName = event.payload?.gamepad_name || 'Controller';
          if (!rawAction) return;

          // Browser Gamepad API is driving this device — skip the native
          // backend so the same press isn't dispatched twice.
          if (browserHasGamepadsRef.current) return;

          if (pressed) {
            notifyButtonPressed(rawAction, event.payload.button || rawAction, gpName);
          }

          if (!enabledRef.current || !pressed) return;

          const action = mappingsRef.current[rawAction] || rawAction;
          executeAction(action);
        });

        // Listen for Phone Remote Web commands
        unlistenRemote = await listen<any>('remote://cmd', (event) => {
          const payload = event.payload;
          if (!payload) return;

          if (payload.action === 'nav' && payload.key) {
            dispatchSpatialNav(payload.key);
            return;
          }

          if (payload.action === 'openView' && payload.view) {
            window.dispatchEvent(
              new CustomEvent('ynotv:navigate-view', { detail: { view: payload.view } })
            );
            return;
          }

          if (payload.action) {
            executeAction(payload.action);
          }
        });
      } catch (e) {
        console.warn('[useGamepad] Tauri listeners not initialized:', e);
      }
    };

    setupTauri();

    return () => {
      isCancelled = true;
      unlistenGamepad?.();
      unlistenStatus?.();
      unlistenRemote?.();
    };
  }, []);

  // 2. Browser HTML5 Gamepad API Poller (DualSense 5 Bluetooth & DirectInput)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let rafId: number;
    const prevButtonStates = new Map<string, boolean>();
    let activeDir: string | null = null;
    let dirHeldSince = 0;
    let lastDirTime = 0;

    const REPEAT_DELAY_MS = 280;
    const REPEAT_INTERVAL_MS = 120;

    const pollGamepads = () => {
      const gamepads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
      let anyConnected = false;
      const connectedList: GamepadDeviceInfo[] = [];

      for (let i = 0; i < gamepads.length; i++) {
        const gp = gamepads[i];
        if (!gp || !gp.connected) continue;

        anyConnected = true;
        const gpName = gp.id || `Gamepad ${gp.index + 1}`;
        connectedList.push({
          id: gp.index,
          name: gpName,
          is_connected: true,
          uuid: gp.id,
        });

        const isDualSenseBt =
          gp.mapping !== 'standard' &&
          (gpName.toLowerCase().includes('054c') ||
            gpName.toLowerCase().includes('dualsense') ||
            gpName.toLowerCase().includes('wireless controller') ||
            gpName.toLowerCase().includes('playstation'));

        const buttonMap = isDualSenseBt ? DUALSENSE_BT_MAP : STANDARD_BUTTON_MAP;

        // Scan all buttons on this controller
        for (let btnIdx = 0; btnIdx < gp.buttons.length; btnIdx++) {
          const btn = gp.buttons[btnIdx];
          const isPressed =
            typeof btn === 'object'
              ? btn.pressed || btn.value > 0.35
              : typeof btn === 'number'
              ? btn > 0.35
              : false;

          const stateKey = `${gp.index}_btn_${btnIdx}`;
          const wasPressed = prevButtonStates.get(stateKey) || false;

          if (isPressed && !wasPressed) {
            prevButtonStates.set(stateKey, true);
            const rawAction = buttonMap[btnIdx] || `button_${btnIdx}`;
            notifyButtonPressed(rawAction, `Button ${btnIdx} (${rawAction})`, gpName);

            if (enabledRef.current) {
              const action = mappingsRef.current[rawAction] || rawAction;
              executeAction(action);
            }
          } else if (!isPressed && wasPressed) {
            prevButtonStates.set(stateKey, false);
          }
        }

        // Scan Left Analog Stick (Axes 0 & 1)
        const deadzone = deadzoneRef.current;
        const stickX = gp.axes[0] || 0;
        const stickY = gp.axes[1] || 0;

        let currentDir: string | null = null;
        if (stickY < -deadzone) {
          currentDir = 'dpad_up';
        } else if (stickY > deadzone) {
          currentDir = 'dpad_down';
        } else if (stickX < -deadzone) {
          currentDir = 'dpad_left';
        } else if (stickX > deadzone) {
          currentDir = 'dpad_right';
        }

        // Scan D-Pad Hat Switch (DirectInput on Bluetooth DualSense / standard pads)
        if (!currentDir) {
          for (const axisIdx of [9, 4, 2, 3]) {
            if (axisIdx < gp.axes.length) {
              const hat = gp.axes[axisIdx];
              if (hat !== undefined && hat >= -1.05 && hat <= 1.05) {
                // DirectInput Hat standard angles
                if (hat >= -1.05 && hat <= -0.85) {
                  currentDir = 'dpad_up';
                } else if (hat >= -0.55 && hat <= -0.30) {
                  currentDir = 'dpad_right';
                } else if (hat >= 0.00 && hat <= 0.25) {
                  currentDir = 'dpad_down';
                } else if (hat >= 0.55 && hat <= 0.85) {
                  currentDir = 'dpad_left';
                }
              }
            }
          }
        }

        const now = Date.now();
        if (currentDir) {
          if (activeDir !== currentDir) {
            activeDir = currentDir;
            dirHeldSince = now;
            lastDirTime = now;
            notifyButtonPressed(currentDir, currentDir.toUpperCase(), gpName);

            if (enabledRef.current) {
              const action = mappingsRef.current[currentDir] || currentDir;
              executeAction(action);
            }
          } else {
            const heldDuration = now - dirHeldSince;
            const sinceLast = now - lastDirTime;
            if (heldDuration >= REPEAT_DELAY_MS && sinceLast >= REPEAT_INTERVAL_MS) {
              lastDirTime = now;
              notifyButtonPressed(currentDir, currentDir.toUpperCase(), gpName);

              if (enabledRef.current) {
                const action = mappingsRef.current[currentDir] || currentDir;
                executeAction(action);
              }
            }
          }
        } else if (activeDir) {
          activeDir = null;
        }
      }

      if (anyConnected && connectedList.length > 0) {
        setConnectedGamepads((prev) => {
          if (prev.length !== connectedList.length) return connectedList;
          return prev;
        });
      }

      // Refresh the source-selection flag each frame (staleness of a few ms is
      // fine — it only gates the native backend while pads are connected).
      browserHasGamepadsRef.current = anyConnected;

      rafId = requestAnimationFrame(pollGamepads);
    };

    rafId = requestAnimationFrame(pollGamepads);

    const onConnected = (e: GamepadEvent) => {
      console.info('[useGamepad] Bluetooth/USB Gamepad connected:', e.gamepad.id);
    };

    const onDisconnected = (e: GamepadEvent) => {
      console.info('[useGamepad] Gamepad disconnected:', e.gamepad.id);
    };

    window.addEventListener('gamepadconnected', onConnected);
    window.addEventListener('gamepaddisconnected', onDisconnected);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('gamepadconnected', onConnected);
      window.removeEventListener('gamepaddisconnected', onDisconnected);
    };
  }, []);

  return { connectedGamepads };
}

export function executeAction(action: string) {
  switch (action) {
    case 'select':
      dispatchSpatialNav('select');
      break;
    case 'back':
      dispatchSpatialNav('back');
      break;
    case 'nav_up':
      dispatchSpatialNav('up');
      break;
    case 'nav_down':
      dispatchSpatialNav('down');
      break;
    case 'nav_left':
      dispatchSpatialNav('left');
      break;
    case 'nav_right':
      dispatchSpatialNav('right');
      break;
    case 'play_pause':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-play-pause'));
      break;
    case 'seek_forward':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-seek', { detail: { delta: 10 } }));
      break;
    case 'seek_backward':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-seek', { detail: { delta: -10 } }));
      break;
    case 'next_channel':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-channel-step', { detail: { step: 1 } }));
      break;
    case 'prev_channel':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-channel-step', { detail: { step: -1 } }));
      break;
    case 'toggle_fullscreen':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-fullscreen'));
      break;
    case 'toggle_mute':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-mute'));
      break;
    case 'search':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-open-search'));
      break;
    case 'subtitles':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-open-subtitles'));
      break;
    case 'toggle_guide':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'guide' } }));
      break;
    case 'open_movies':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'movies' } }));
      break;
    case 'open_series':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'series' } }));
      break;
    case 'open_sports':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'sports' } }));
      break;
    case 'open_settings':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'settings' } }));
      break;
    case 'none':
      break;
    default:
      break;
  }
}
