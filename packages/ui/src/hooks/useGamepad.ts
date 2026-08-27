import { useEffect, useState, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { dispatchSpatialNav, getActiveModal, onUserManualScroll } from '../services/spatialNavigation';
import { setNavSource } from '../services/controllerTextInput';

// ── Native-claim tracking ──────────────────────────────────────────────────
// The native backends (gilrs XInput + the raw HID backend) fully cover the
// pads they enumerate and their data is trustworthy. The browser Gamepad API
// is a redundant fallback that is only needed for pads neither native backend
// sees — and for those it sometimes IS the only working source (WebView2's
// DualSense-over-BT handling can list the pad while delivering garbage axes /
// buttons, which the 60ms dedupe can't catch because the garbage produces
// different actions than the native side). Once a native event has named a
// pad, the browser poller stops dispatching for it, so Chromium's broken data
// can never inject phantom input on top of working native input.
const nativeClaimedPadNames = new Set<string>();
const nativeClaimedVids = new Set<string>();

/** 'DualSense Wireless Controller (HID 054c:0ce6)' → 'dualsense wireless controller' */
function normalizePadName(name: string): string {
  return name.toLowerCase().split('(')[0].trim();
}

function claimNativePad(name: string) {
  nativeClaimedPadNames.add(normalizePadName(name));
  const vidMatch = name.match(/\(hid\s+([0-9a-f]{4}):/i);
  if (vidMatch) nativeClaimedVids.add(vidMatch[1].toLowerCase());
}

/** True when the native backends have claimed the pad the browser is looking at. */
function isClaimedByNative(browserPadName: string): boolean {
  if (nativeClaimedPadNames.has(normalizePadName(browserPadName))) return true;
  // Chromium's device string can differ from the native name ("Wireless
  // Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)" vs the HID
  // backend's "DualSense Wireless Controller (HID 054c:0ce6)"), so also match
  // on the vendor id.
  const vidMatch = browserPadName.match(/vendor:\s*([0-9a-f]{4})/i);
  return !!vidMatch && nativeClaimedVids.has(vidMatch[1].toLowerCase());
}

// ── Per-frame diagnostics ──────────────────────────────────────────────────
// Enable by setting window.__ynotvGamepadDebug = true in the webview console,
// or by launching with YNOTV_HID_DEBUG=1 / YNOTV_GAMEPAD_DEBUG=1 (the native
// side auto-enables it via the gamepad_debug_enabled command). Logs go through
// the tauri-plugin-log bridge, so they reach the same log file / terminal as
// the Rust logs.
async function debugGamepad(message: string) {
  if ((window as any).__ynotvGamepadDebug !== true) return;
  try {
    const { info } = await import('@tauri-apps/plugin-log');
    await info('[gamepad-debug] ' + message);
  } catch {
    console.info('[gamepad-debug]', message);
  }
}

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

export interface GamepadStickPayload {
  x: number;
  y: number;
  gamepad_id: number;
  gamepad_name: string;
}

export interface LiveButtonEvent {
  action: string;
  rawLabel: string;
  deviceName: string;
}

export interface StickTelemetryEvent {
  stick: 'left' | 'right';
  x: number;
  y: number;
  deviceName?: string;
}

export interface RawGamepadInputEvent {
  buttonIndex?: number;
  buttonCode: string;
  rawLabel: string;
  isPressed: boolean;
  deviceName: string;
}

// Global button listener registry for live visualizer
const buttonListeners = new Set<(event: LiveButtonEvent) => void>();
const stickListeners = new Set<(event: StickTelemetryEvent) => void>();
let calibrationCallback: ((event: RawGamepadInputEvent) => void) | null = null;

export function subscribeGamepadButtonPress(cb: (event: LiveButtonEvent) => void): () => void {
  buttonListeners.add(cb);
  return () => buttonListeners.delete(cb);
}

export function subscribeGamepadStickTelemetry(cb: (event: StickTelemetryEvent) => void): () => void {
  stickListeners.add(cb);
  return () => stickListeners.delete(cb);
}

export function setGamepadCalibrationCallback(cb: ((event: RawGamepadInputEvent) => void) | null) {
  calibrationCallback = cb;
}

function notifyButtonPressed(action: string, rawLabel: string = action, deviceName: string = 'Gamepad') {
  const payload: LiveButtonEvent = { action, rawLabel, deviceName };
  buttonListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch {}
  });
}

function notifyStickMoved(stick: 'left' | 'right', x: number, y: number, deviceName?: string) {
  const payload: StickTelemetryEvent = { stick, x, y, deviceName };
  stickListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch {}
  });
}

// Both the native gilrs backend and the browser Gamepad API can see the same
// pad, so one press can arrive from each source within a few ms. Instead of
// picking a single source up front (which breaks when a webview reports a pad
// it can't actually poll — e.g. DualSense over Bluetooth on some WebView2
// builds), let both sources dispatch and drop the duplicate. Whichever source
// fires first wins; the repeat rates of held buttons (120ms+) are far above
// this window, so long-press repeat still works.
const lastDispatchedAction = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60;

function tryDispatchAction(action: string): boolean {
  const now = Date.now();
  const last = lastDispatchedAction.get(action) || 0;
  if (now - last < DEDUPE_WINDOW_MS) return false;
  lastDispatchedAction.set(action, now);
  executeAction(action);
  return true;
}

// ── Button-combination chords ─────────────────────────────────────────────
// Holding a modifier button (shoulders/triggers) turns a base button press
// into a different action (e.g. L2 + D-Pad Up = next channel). Detection is
// entirely frontend-side: every input source (gilrs native, raw HID native,
// browser poller) funnels through these shared helpers, so held-modifier
// state stays consistent no matter which backend fired.
const MODIFIER_BUTTONS = new Set(['left_bumper', 'right_bumper', 'left_trigger', 'right_trigger']);
// Most-recently-pressed first; when two modifiers are held, the newest wins.
const heldModifiers: string[] = [];

function setHeldModifier(action: string, pressed: boolean) {
  if (!MODIFIER_BUTTONS.has(action)) return;
  const idx = heldModifiers.indexOf(action);
  if (pressed && idx === -1) {
    heldModifiers.push(action);
  } else if (!pressed && idx !== -1) {
    heldModifiers.splice(idx, 1);
  }
}

function clearHeldModifiers() {
  heldModifiers.length = 0;
}

/** The chord action (app action) for a base-button press, or null if none. */
function chordActionFor(rawButton: string, chords: Record<string, string>): string | null {
  if (heldModifiers.length === 0) return null;
  const modifier = heldModifiers[heldModifiers.length - 1];
  return chords[`${modifier}+${rawButton}`] || null;
}

function scrollActiveContainerByStick(rawX: number, rawY: number, deadzone: number) {
  if (typeof document === 'undefined') return;

  // Exponential response curve for fine precision and rapid sweeping
  const calcDelta = (val: number) => {
    const abs = Math.abs(val);
    if (abs <= deadzone) return 0;
    const norm = (abs - deadzone) / (1 - deadzone);
    return Math.sign(val) * Math.pow(norm, 1.6) * 22;
  };

  const deltaY = calcDelta(rawY);
  const deltaX = calcDelta(rawX);
  if (deltaY === 0 && deltaX === 0) return;

  const isScrollable = (el: HTMLElement): boolean => {
    const style = window.getComputedStyle(el);
    return (
      style.overflowY === 'auto' || style.overflowY === 'scroll' ||
      style.overflowX === 'auto' || style.overflowX === 'scroll'
    );
  };

  // Collect candidate scrollers, innermost first:
  //   1. the active modal's scroller (z-aware, so stacked modals like Game
  //      Detail over the Live Games picker resolve correctly),
  //   2. the focused element's scrollable ancestors (rail → row → page),
  //   3. the known active page scroller,
  //   4. the document root.
  const candidates: HTMLElement[] = [];

  const modal = getActiveModal();
  if (modal) {
    const modalScroller = modal.querySelector<HTMLElement>(
      '.settings-tab-content, .movie-detail__scroll, .series-detail__scroll, .stremio-detail-body, .game-detail-content, [data-virtuoso-scroller]'
    );
    candidates.push(modalScroller || modal);
  }

  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) {
    let node: HTMLElement | null = active.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollable(node)) candidates.push(node);
      node = node.parentElement;
    }
  }

  const known = document.querySelector<HTMLElement>(
    '.nuvio-main, .stremio-home, .stremio-main, .vod-page__home, .vod-browse__grid-scroll, .local-grid-scroll, .guide-channels, .sports-hub, .dvr-dashboard, .tv-calendar-page, .channel-panel, .epg-content'
  );
  if (known) candidates.push(known);

  candidates.push((document.scrollingElement as HTMLElement | null) || document.documentElement);

  // When a modal is open, its scroller owns both axes — never leak scroll to
  // the page behind the modal.
  if (modal && candidates[0]) {
    const modalScroller = candidates[0];
    if (deltaY !== 0) modalScroller.scrollTop += deltaY;
    if (deltaX !== 0) modalScroller.scrollLeft += deltaX;
    onUserManualScroll();
    return;
  }

  // Rail layouts (nuvio/stremio home): the focused poster sits inside a
  // horizontal .nuvio-scroll-rail that can only scroll left/right, so vertical
  // stick input must fall through to the nearest ancestor that can actually
  // scroll vertically (the page), instead of being swallowed by the rail.
  const findScroller = (axis: 'x' | 'y'): HTMLElement | null =>
    candidates.find((el) =>
      axis === 'y' ? el.scrollHeight > el.clientHeight + 4 : el.scrollWidth > el.clientWidth + 4
    ) || null;

  const scrollerY = deltaY !== 0 ? findScroller('y') : null;
  const scrollerX = deltaX !== 0 ? findScroller('x') : null;

  let didScroll = false;
  if (scrollerY) {
    scrollerY.scrollTop += deltaY;
    didScroll = true;
  }
  if (scrollerX) {
    scrollerX.scrollLeft += deltaX;
    didScroll = true;
  }
  if (didScroll) onUserManualScroll();
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
  const controllerBackgroundListening = useSettingsStore((s) => s.controllerBackgroundListening);
  const controllerMappings = useSettingsStore((s) => s.controllerMappings);
  const controllerChords = useSettingsStore((s) => s.controllerChords);
  const controllerDeadzone = useSettingsStore((s) => s.controllerDeadzone);
  const controllerRepeatDelayMs = useSettingsStore((s) => s.controllerRepeatDelayMs);
  const controllerRepeatIntervalMs = useSettingsStore((s) => s.controllerRepeatIntervalMs);
  const [connectedGamepads, setConnectedGamepads] = useState<GamepadDeviceInfo[]>([]);

  const mappingsRef = useRef(controllerMappings);
  mappingsRef.current = controllerMappings;

  const chordsRef = useRef(controllerChords);
  chordsRef.current = controllerChords;

  const enabledRef = useRef(controllerEnabled);
  enabledRef.current = controllerEnabled;

  const backgroundListenRef = useRef(controllerBackgroundListening);
  backgroundListenRef.current = controllerBackgroundListening;

  const deadzoneRef = useRef(controllerDeadzone);
  deadzoneRef.current = controllerDeadzone;

  // Controller input is only processed while the app window has focus, unless
  // the user opted into background listening. Shared by the native gilrs
  // listener and the browser Gamepad API poller, so an unfocused window can
  // never react to a pad that belongs to the app the user is actually using.
  const isInputActive = () =>
    backgroundListenRef.current || (typeof document !== 'undefined' && document.hasFocus());

  // 1. Tauri Native Backend Listener (gilrs & Phone Remote Server)
  useEffect(() => {
    let unlistenGamepad: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;
    let unlistenStick: (() => void) | null = null;
    let unlistenRemote: (() => void) | null = null;
    let isCancelled = false;

    // ── D-pad hold-to-repeat (phone-remote-style acceleration) ────────────────
    // The native side delivers dpad presses/releases as discrete edges, so a
    // held directional button only fires once. Mirror the phone remote's
    // D-pad: re-fire the action while the button is held, starting after a
    // short hold delay and gradually speeding up. Timings match the remote
    // (see NAV_REPEAT_* in web_server.rs).
    const DPAD_DIRECTIONS = new Set(['dpad_up', 'dpad_down', 'dpad_left', 'dpad_right']);
    // Repeat timings read fresh from settings at schedule time so a change
    // applies immediately without re-running the whole effect. Defaults mirror
    // the phone remote's D-pad (NAV_REPEAT_* in web_server.rs): hold delay
    // 350ms, starting interval 220ms, −15ms per repeat, 60ms fastest. The
    // starting interval drives the whole accelerating curve — step and min
    // scale with it so the curve keeps its shape as the user adjusts speed.
    const NAV_REPEAT_PROTO_START = 220;
    const NAV_REPEAT_PROTO_STEP = 15;
    const NAV_REPEAT_PROTO_MIN = 60;
    const navRepeatDelayMs = () => useSettingsStore.getState().controllerRepeatDelayMs;
    const navRepeatStartMs = () => {
      const start = useSettingsStore.getState().controllerRepeatIntervalMs;
      return Math.max(40, Math.round(start));
    };
    const navRepeatStepMs = (startMs: number) => Math.max(5, Math.round(startMs * (NAV_REPEAT_PROTO_STEP / NAV_REPEAT_PROTO_START)));
    const navRepeatMinMs = (startMs: number) => Math.max(navRepeatStepMs(startMs), Math.round(startMs * (NAV_REPEAT_PROTO_MIN / NAV_REPEAT_PROTO_START)));

    // Dispatch one dpad action, honoring enabled/focus gates, held-modifier
    // chords, and custom mappings — identical to the initial-press path below.
    const repeatNativeAction = (action: string) => {
      if (!enabledRef.current || !isInputActive()) return;
      const chord = chordActionFor(action, chordsRef.current);
      if (chord) {
        tryDispatchAction(chord);
        return;
      }
      tryDispatchAction(mappingsRef.current[action] || action);
    };

    // Per-direction timers for an active hold.
    const heldDpad: {
      [dir: string]: { hold: number | null; repeat: number | null };
    } = {};
    const stopDpadRepeat = (dir: string) => {
      const t = heldDpad[dir];
      if (!t) return;
      if (t.hold !== null) clearTimeout(t.hold);
      if (t.repeat !== null) clearTimeout(t.repeat);
      delete heldDpad[dir];
    };
    const stopAllDpadRepeat = () => {
      Object.keys(heldDpad).forEach(stopDpadRepeat);
    };
    const startDpadRepeat = (dir: string) => {
      stopDpadRepeat(dir);
      const t: { hold: number | null; repeat: number | null } = { hold: null, repeat: null };
      heldDpad[dir] = t;
      t.hold = window.setTimeout(() => {
        t.hold = null;
        const startMs = navRepeatStartMs();
        const stepMs = navRepeatStepMs(startMs);
        const minMs = navRepeatMinMs(startMs);
        let intervalMs = startMs;
        const tick = () => {
          repeatNativeAction(dir);
          intervalMs = Math.max(minMs, intervalMs - stepMs);
          t.repeat = window.setTimeout(tick, intervalMs);
        };
        tick();
      }, navRepeatDelayMs());
    };

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

        // Auto-enable per-frame diagnostics when the native debug env vars are set.
        invoke<boolean>('gamepad_debug_enabled')
          .then((enabled) => {
            if (enabled) (window as any).__ynotvGamepadDebug = true;
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
          let rawAction = event.payload?.action;
          const pressed = event.payload?.pressed;
          const gpName = event.payload?.gamepad_name || 'Controller';
          if (!rawAction) return;

          // First native event from a pad claims it, disabling the browser
          // poller for that pad (see the claim helpers above).
          claimNativePad(gpName);
          debugGamepad(
            `native event: action=${rawAction} pressed=${pressed} id=${event.payload?.gamepad_id} name=${gpName}`
          );

          if (calibrationCallback && pressed) {
            calibrationCallback({
              buttonCode: rawAction,
              rawLabel: event.payload.button || rawAction,
              isPressed: true,
              deviceName: gpName,
            });
            return;
          }

          // Custom hardware profile lookup
          const customProfiles = useSettingsStore.getState().customGamepadProfiles;
          const padProfile = customProfiles[gpName] || customProfiles[normalizePadName(gpName)];
          if (padProfile && padProfile[rawAction]) {
            rawAction = padProfile[rawAction];
          }

          const buttonSource = event.payload?.button || rawAction;
          const isLeftStickEvent =
            buttonSource.toLowerCase().includes('leftstick') ||
            buttonSource.toLowerCase().includes('analog') ||
            gpName.toLowerCase() === 'analog';

          // Manage the accelerating hold-to-repeat for dpad directions. The
          // initial press still dispatches through the normal path below; these
          // timers only add the repeats. Releasing stops the current repeat.
          // Skip stick events: the analog stick maps to dpad_* too but already
          // repeats natively and never emits a release, so a timer would leak.
          if (!isLeftStickEvent && DPAD_DIRECTIONS.has(rawAction)) {
            if (pressed) startDpadRepeat(rawAction);
            else stopDpadRepeat(rawAction);
          }

          if (pressed) {
            if (isLeftStickEvent) {
              let sx = 0;
              let sy = 0;
              if (rawAction === 'dpad_up') sy = -1;
              else if (rawAction === 'dpad_down') sy = 1;
              else if (rawAction === 'dpad_left') sx = -1;
              else if (rawAction === 'dpad_right') sx = 1;
              notifyStickMoved('left', sx, sy, gpName);
              setTimeout(() => {
                notifyStickMoved('left', 0, 0, gpName);
              }, 220);
            } else {
              notifyButtonPressed(rawAction, buttonSource, gpName);
            }
          }

          // Chords: keep held-modifier state in sync on both edges BEFORE the
          // enabled/focus gates, so a release that arrives after a blur (or
          // while disabled) can't leave a modifier stuck on.
          setHeldModifier(rawAction, pressed);

          if (!enabledRef.current || !pressed || !isInputActive()) return;

          // A held modifier swaps in the chord action and suppresses the
          // base button's normal action (Steam-style).
          const chord = chordActionFor(rawAction, chordsRef.current);
          if (chord) {
            tryDispatchAction(chord);
            return;
          }

          const action = mappingsRef.current[rawAction] || rawAction;
          tryDispatchAction(action);
        });

        // Listen for native right-stick scroll updates (both gilrs XInput and
        // the raw HID backend emit these). Claimed pads never reach the browser
        // poller's scroll path, so this is the only way they can scroll.
        unlistenStick = await listen<GamepadStickPayload>('ynotv://gamepad-stick', (event) => {
          const p = event.payload;
          if (!p) return;
          // Any native event from a pad means the native side owns it.
          claimNativePad(p.gamepad_name || 'Controller');
          notifyStickMoved('right', p.x, p.y, p.gamepad_name);
          if (!enabledRef.current || !isInputActive()) return;
          // The native backends emit Y with UP positive (matching their D-pad
          // emulation), while scrollActiveContainerByStick expects the browser
          // Gamepad API convention — UP negative, since scrollTop grows
          // downward. Flip Y at the boundary so up scrolls up.
          scrollActiveContainerByStick(p.x, -p.y, deadzoneRef.current);
        });

        // Listen for Phone Remote Web commands
        unlistenRemote = await listen<any>('remote://cmd', (event) => {
          const payload = event.payload;
          if (!payload) return;

          // Nav commands from the phone remote are marked as 'remote' so search
          // boxes can open the phone-side query box instead of the OSK.
          setNavSource('remote');

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

          // Phone remote search box → live search in the app (mirrors typing in
          // the titlebar search). `commit` is true on Enter / the Go button so
          // the query is recorded in search history.
          if (payload.action === 'searchQuery') {
            window.dispatchEvent(
              new CustomEvent('ynotv:remote-search-query', {
                detail: {
                  query: typeof payload.query === 'string' ? payload.query : '',
                  commit: payload.commit === true,
                },
              })
            );
            return;
          }

          // Text typed in the phone remote's type-into-field modal, targeting a
          // search box the user activated from the remote.
          if (payload.action === 'textInput') {
            window.dispatchEvent(
              new CustomEvent('ynotv:remote-text-input', {
                detail: {
                  fieldId: typeof payload.fieldId === 'string' ? payload.fieldId : '',
                  text: typeof payload.text === 'string' ? payload.text : '',
                  commit: payload.commit === true,
                  cancel: payload.cancel === true,
                },
              })
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

    // If a pad drops (or Bluetooth glitches) mid-hold, no release event ever
    // arrives — clear held modifiers when the window loses focus (unless the
    // user opted into background listening) so a stuck chord can't wedge input.
    const onWindowBlur = () => {
      if (!backgroundListenRef.current) {
        clearHeldModifiers();
        stopAllDpadRepeat();
      }
    };
    window.addEventListener('blur', onWindowBlur);

    return () => {
      isCancelled = true;
      window.removeEventListener('blur', onWindowBlur);
      stopAllDpadRepeat();
      unlistenGamepad?.();
      unlistenStatus?.();
      unlistenStick?.();
      unlistenRemote?.();
    };
  }, []);

  // 2. Browser HTML5 Gamepad API Poller (DualSense 5 Bluetooth & DirectInput)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    console.info(
      '[useGamepad] Diagnostics: set window.__ynotvGamepadDebug = true in the webview console (or launch with YNOTV_HID_DEBUG=1 / YNOTV_GAMEPAD_DEBUG=1) to log per-frame gamepad state.'
    );

    let rafId: number;
    const prevButtonStates = new Map<string, boolean>();
    let activeDir: string | null = null;
    let dirHeldSince = 0;
    let lastDirTime = 0;
    let lastStatusLog = 0;

    const REPEAT_DELAY_MS = 280;
    const REPEAT_INTERVAL_MS = 120;

    const pollGamepads = () => {
      // Chromium refuses to expose gamepads while the document isn't focused,
      // so a hidden window has nothing to poll — skip the scan (background
      // input rides entirely on the native gilrs path in that state).
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        rafId = requestAnimationFrame(pollGamepads);
        return;
      }
      const gamepads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
      let anyConnected = false;
      const connectedList: GamepadDeviceInfo[] = [];
      const statusLines: string[] = [];

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

        // A pad that produced a native event (gilrs XInput or the raw HID
        // backend) is fully driven by the native side. Chromium's Gamepad API
        // data for the same pad is at best redundant and at worst garbage
        // (DualSense over Bluetooth is the classic case — listed but with
        // broken axes), so we stop dispatching its buttons / sticks / hat and
        // only keep it for the device list and the diagnostic lines below.
        const claimed = isClaimedByNative(gpName);

        // Scan all buttons on this controller
        if (!claimed) {
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
            const rawAction = buttonMap[btnIdx] || `button_${btnIdx}`;

            if (isPressed && !wasPressed) {
              prevButtonStates.set(stateKey, true);

              if (calibrationCallback) {
                calibrationCallback({
                  buttonIndex: btnIdx,
                  buttonCode: rawAction,
                  rawLabel: `Button ${btnIdx}`,
                  isPressed: true,
                  deviceName: gpName,
                });
                continue;
              }

              // Custom hardware profile lookup
              const customProfiles = useSettingsStore.getState().customGamepadProfiles;
              const padProfile = customProfiles[gpName] || customProfiles[normalizePadName(gpName)];
              let resolvedAction = rawAction;
              if (padProfile && padProfile[rawAction]) {
                resolvedAction = padProfile[rawAction];
              } else if (padProfile && padProfile[String(btnIdx)]) {
                resolvedAction = padProfile[String(btnIdx)];
              }

              notifyButtonPressed(resolvedAction, `Button ${btnIdx} (${resolvedAction})`, gpName);

              // Chords: a modifier held while this button presses swaps in the
              // chord action and suppresses the base button's normal action.
              setHeldModifier(resolvedAction, true);
              if (enabledRef.current && isInputActive()) {
                const chord = chordActionFor(resolvedAction, chordsRef.current);
                if (chord) {
                  tryDispatchAction(chord);
                } else {
                  const action = mappingsRef.current[resolvedAction] || resolvedAction;
                  tryDispatchAction(action);
                }
              }
            } else if (!isPressed && wasPressed) {
              prevButtonStates.set(stateKey, false);
              setHeldModifier(rawAction, false);
            }
          }
        }

        // Left Analog Stick (Axes 0 & 1) → D-pad direction & visualizer telemetry
        const deadzone = deadzoneRef.current;
        const stickX = gp.axes[0] || 0;
        const stickY = gp.axes[1] || 0;

        notifyStickMoved('left', stickX, stickY, gpName);

        let currentDir: string | null = null;
        let isStickNav = false;
        if (stickY < -deadzone) {
          currentDir = 'dpad_up';
          isStickNav = true;
        } else if (stickY > deadzone) {
          currentDir = 'dpad_down';
          isStickNav = true;
        } else if (stickX < -deadzone) {
          currentDir = 'dpad_left';
          isStickNav = true;
        } else if (stickX > deadzone) {
          currentDir = 'dpad_right';
          isStickNav = true;
        }

        // Scan D-Pad Hat Switch ONLY on raw DirectInput / Bluetooth controllers (mapping !== 'standard')
        // Standard gamepads and DS4Windows already have D-Pad mapped to buttons 12-15 above.
        let hatVal: number | undefined;
        if (!currentDir && gp.mapping !== 'standard' && gp.axes.length > 9) {
          const hat = gp.axes[9];
          hatVal = typeof hat === 'number' ? hat : undefined;
          if (typeof hat === 'number' && hat >= -1.05 && hat <= 1.05) {
            // DirectInput 8-way Hat angles (0.0 is resting stick/idle, strictly excluded):
            // Up: -1.0, Right: -0.43, Down: 0.14, Left: 0.71
            if (hat >= -1.05 && hat <= -0.80) {
              currentDir = 'dpad_up';
            } else if (hat >= -0.55 && hat <= -0.30) {
              currentDir = 'dpad_right';
            } else if (hat >= 0.08 && hat <= 0.22) {
              currentDir = 'dpad_down';
            } else if (hat >= 0.55 && hat <= 0.85) {
              currentDir = 'dpad_left';
            }
          }
        }

        if (!claimed) {
          const now = Date.now();
          if (currentDir) {
            if (activeDir !== currentDir) {
              activeDir = currentDir;
              dirHeldSince = now;
              lastDirTime = now;
              if (!isStickNav) {
                notifyButtonPressed(currentDir, currentDir.toUpperCase(), gpName);
              }
              debugGamepad(
                `poller dir start: idx=${gp.index} dir=${currentDir} ax0=${stickX.toFixed(2)} ax1=${stickY.toFixed(2)} hat=${hatVal === undefined ? '-' : hatVal.toFixed(2)}`
              );

              if (enabledRef.current && isInputActive()) {
                const action = mappingsRef.current[currentDir] || currentDir;
                tryDispatchAction(action);
              }
            } else {
              const heldDuration = now - dirHeldSince;
              const sinceLast = now - lastDirTime;
              if (heldDuration >= REPEAT_DELAY_MS && sinceLast >= REPEAT_INTERVAL_MS) {
                lastDirTime = now;
                if (!isStickNav) {
                  notifyButtonPressed(currentDir, currentDir.toUpperCase(), gpName);
                }
                debugGamepad(
                  `poller dir repeat: idx=${gp.index} dir=${currentDir} ax0=${stickX.toFixed(2)} ax1=${stickY.toFixed(2)} hat=${hatVal === undefined ? '-' : hatVal.toFixed(2)}`
                );

                if (enabledRef.current && isInputActive()) {
                  const action = mappingsRef.current[currentDir] || currentDir;
                  executeAction(action);
                }
              }
            }
          } else if (activeDir) {
            activeDir = null;
          }
        }

        // Diagnostic heartbeat line — what Chromium reports for this pad.
        statusLines.push(
          `idx=${gp.index} map="${gp.mapping}" btns=${gp.buttons.length} axes=${gp.axes.length} [${gp.axes
            .map((a) => (a ?? 0).toFixed(2))
            .join(',')}] ax0=${stickX.toFixed(2)} ax1=${stickY.toFixed(2)} hat=${hatVal === undefined ? '-' : hatVal.toFixed(2)} dir=${currentDir ?? '-'} claimed=${claimed}`
        );

        // Scan Right Analog Stick (Axes 2 & 3/5) for smooth variable-speed page scrolling & telemetry
        let rightStickX = 0;
        let rightStickY = 0;

        if (gp.axes.length > 2) {
          rightStickX = gp.axes[2] || 0;
        }
        if (gp.axes.length > 3) {
          const axis3 = gp.axes[3];
          const axis5 = gp.axes.length > 5 ? gp.axes[5] : null;
          if (gp.mapping !== 'standard' && typeof axis5 === 'number' && Math.abs(axis3 + 1) < 0.05) {
            rightStickY = axis5;
          } else {
            rightStickY = axis3 || 0;
          }
        }

        notifyStickMoved('right', rightStickX, rightStickY, gpName);

        if (!claimed && enabledRef.current && isInputActive()) {
          if (Math.abs(rightStickY) > deadzone || Math.abs(rightStickX) > deadzone) {
            scrollActiveContainerByStick(rightStickX, rightStickY, deadzone);
          }
        }
      }

      // Heartbeat: dump per-pad browser state every 2s so a quiet phantom
      // source still shows up without flooding the log at 60fps.
      if (statusLines.length > 0) {
        const nowMs = Date.now();
        if (nowMs - lastStatusLog >= 2000) {
          lastStatusLog = nowMs;
          debugGamepad('poller: ' + statusLines.join(' | '));
        }
      }

      if (anyConnected && connectedList.length > 0) {
        setConnectedGamepads((prev) => {
          if (prev.length !== connectedList.length) return connectedList;
          return prev;
        });
      }

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
  // Physical controllers (and any non-remote fallback) drive spatial nav.
  setNavSource('controller');
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
    case 'seek_forward_30':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-seek', { detail: { delta: 30 } }));
      break;
    case 'seek_backward_30':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-seek', { detail: { delta: -30 } }));
      break;
    case 'next_channel':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-channel-step', { detail: { step: 1 } }));
      break;
    case 'prev_channel':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-channel-step', { detail: { step: -1 } }));
      break;
    case 'epg_shift_forward':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-epg-shift', { detail: { delta: 1 } }));
      break;
    case 'epg_shift_backward':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-epg-shift', { detail: { delta: -1 } }));
      break;
    case 'toggle_fullscreen':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-fullscreen'));
      break;
    case 'toggle_mute':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-mute'));
      break;
    case 'volume_up':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-volume-step', { detail: { delta: 5 } }));
      break;
    case 'volume_down':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-volume-step', { detail: { delta: -5 } }));
      break;
    case 'search':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-open-search'));
      break;
    case 'subtitles':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-open-subtitles'));
      break;
    case 'toggle_livetv':
    case 'toggle_guide':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'livetv' } }));
      break;
    case 'toggle_nuvio':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'nuvio' } }));
      break;
    case 'toggle_stremio':
      window.dispatchEvent(new CustomEvent('ynotv:navigate-view', { detail: { view: 'stremio' } }));
      break;
    case 'toggle_transparent_overlay':
    case 'open_sections':
    case 'toggle_sections':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-transparent-guide'));
      break;
    case 'toggle_overlay':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-overlay'));
      break;
    case 'toggle_live_game_sidebar':
      window.dispatchEvent(new CustomEvent('ynotv:gamepad-toggle-live-game-sidebar'));
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

// ── Keyboard as Controller ─────────────────────────────────────────────────
// Maps physical keys (e.code) to controller buttons so an HTPC keyboard /
// wireless remote can drive the same controller UI (spatial nav, chords,
// mappings, visualizer) as a gamepad. Keys are translated into controller
// buttons and fed through the exact same pipeline as a gamepad press:
//   key → controller button → controllerMappings/chords → executeAction
// Only mapped keys are intercepted — everything else keeps its normal
// behavior, and keys are ignored while typing in text fields.
const KEYBOARD_BUTTON_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Space: 'Space',
  Tab: 'Tab',
};

/** Pretty label for a stored key code (used in the settings key-binding UI). */
export function keyboardKeyLabel(code: string): string {
  if (KEYBOARD_BUTTON_LABELS[code]) return KEYBOARD_BUTTON_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (code.startsWith('Media')) return code.slice(5);
  return code;
}

// While the settings key-capture UI is waiting for a press, the keyboard
// controller layer must stand down so the capture listener sees the key.
let keyboardCaptureActive = false;
export function setKeyboardCaptureActive(active: boolean) {
  keyboardCaptureActive = active;
}

// Keys that must keep their normal behavior while an editable field is
// focused (typing, submitting a form, deleting characters, moving the caret
// by word). Everything else — D-Pad arrows, Escape, F-keys, media keys — acts
// as a controller button even then, so spatial focus can move away from
// search boxes exactly like it can with a real gamepad.
const EDITING_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Home', 'End']);

export function useKeyboardAsController() {
  const keyboardControllerEnabled = useSettingsStore((s) => s.keyboardControllerEnabled);
  const keyboardControllerMappings = useSettingsStore((s) => s.keyboardControllerMappings);
  const controllerMappings = useSettingsStore((s) => s.controllerMappings);
  const controllerChords = useSettingsStore((s) => s.controllerChords);
  const controllerBackgroundListening = useSettingsStore((s) => s.controllerBackgroundListening);

  const kbEnabledRef = useRef(keyboardControllerEnabled);
  kbEnabledRef.current = keyboardControllerEnabled;
  const kbMappingsRef = useRef(keyboardControllerMappings);
  kbMappingsRef.current = keyboardControllerMappings;
  const mappingsRef = useRef(controllerMappings);
  mappingsRef.current = controllerMappings;
  const chordsRef = useRef(controllerChords);
  chordsRef.current = controllerChords;
  const backgroundListenRef = useRef(controllerBackgroundListening);
  backgroundListenRef.current = controllerBackgroundListening;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const isInputActive = () =>
      backgroundListenRef.current || (typeof document !== 'undefined' && document.hasFocus());

    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!target) return false;
      const el = target as HTMLElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        el.isContentEditable === true
      );
    };

    const resolveButton = (e: KeyboardEvent): string | null => {
      const table = kbMappingsRef.current;
      return table[e.code] || table[e.key] || null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (keyboardCaptureActive) return;
      const button = resolveButton(e);
      if (!button) return;
      if (!kbEnabledRef.current || !isInputActive()) return;

      // While an editable field is focused, let text-editing keys behave
      // normally: printable keys type (even if a letter is bound to a
      // controller button), Enter submits, Backspace/Delete edit. All other
      // mapped keys still act as controller buttons, so the D-Pad moves
      // spatial focus away from search boxes — matching a real gamepad.
      if (isTypingTarget(e.target)) {
        const producesText = e.isComposing || (e.key && e.key.length === 1);
        if (producesText || EDITING_KEYS.has(e.key)) return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.repeat) {
        // Native key repeat: re-fire the mapped action, bypassing the 60ms
        // dedupe window (mirrors the gamepad poller's repeat path) so held
        // keys move through the grid at the OS repeat rate.
        const chord = chordActionFor(button, chordsRef.current);
        if (chord) {
          tryDispatchAction(chord);
        } else {
          executeAction(mappingsRef.current[button] || button);
        }
        return;
      }

      notifyButtonPressed(button, `${keyboardKeyLabel(e.code)} → ${button}`, 'Keyboard');
      setHeldModifier(button, true);

      const chord = chordActionFor(button, chordsRef.current);
      if (chord) {
        tryDispatchAction(chord);
      } else {
        tryDispatchAction(mappingsRef.current[button] || button);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (keyboardCaptureActive) return;
      const button = resolveButton(e);
      if (!button) return;
      setHeldModifier(button, false);
    };

    const onWindowBlur = () => {
      clearHeldModifiers();
    };

    // Capture phase so a mapped key fully takes over before any app shortcut
    // (bubble-phase) listener sees it.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onWindowBlur);
    };
  }, []);
}
