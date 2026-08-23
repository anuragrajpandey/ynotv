use gilrs::{Axis, Button, Event, EventType, Gilrs};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static RUNNING: AtomicBool = AtomicBool::new(false);

static DEBUG: OnceLock<bool> = OnceLock::new();

/// Opt-in diagnostics via `YNOTV_GAMEPAD_DEBUG=1`. When enabled, every
/// gilrs event and emitted payload is logged at info level so phantom input
/// from the native XInput backend can be traced (e.g. a virtual Xbox pad
/// left behind by a controller-emulation tool).
pub fn debug_enabled() -> bool {
    *DEBUG.get_or_init(|| {
        std::env::var("YNOTV_GAMEPAD_DEBUG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

fn emit_debug(name: &str, action: &str, button: &str, pressed: bool, id: usize) {
    if debug_enabled() {
        info!(
            "[gamepad-debug] {} emit {} ({}) pressed={} id={}",
            name, action, button, pressed, id
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamepadInfo {
    pub id: usize,
    pub name: String,
    pub is_connected: bool,
    pub uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamepadPayload {
    pub action: String,
    pub button: String,
    pub pressed: bool,
    pub gamepad_id: usize,
    pub gamepad_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamepadStatusPayload {
    pub gamepads: Vec<GamepadInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GamepadStickPayload {
    /// Right-stick X in [-1, 1] (right positive).
    pub x: f32,
    /// Right-stick Y in [-1, 1] with UP positive (same convention as the
    /// D-pad emulation). The frontend flips the sign before scrolling because
    /// DOM scrollTop grows downward.
    pub y: f32,
    pub gamepad_id: usize,
    pub gamepad_name: String,
}

/// Minimum time between right-stick scroll updates. Pads report at up to
/// ~1 kHz, so without a throttle the event bus would be flooded with scroll
/// updates; 16 ms (~60 Hz) keeps scrolling smooth while staying cheap.
pub const STICK_SCROLL_MIN_INTERVAL_MS: u128 = 16;

/// Emit a right-stick scroll update (`ynotv://gamepad-stick`), throttled to
/// ~60 Hz. `last_emit` is the caller's per-device throttle clock. Both native
/// backends (gilrs XInput + raw HID) use this so claimed pads scroll too —
/// the browser poller only handles pads the native side hasn't claimed.
pub fn emit_stick_scroll(
    handle: &AppHandle,
    x: f32,
    y: f32,
    gamepad_id: usize,
    gamepad_name: &str,
    last_emit: &mut Instant,
) {
    let now = Instant::now();
    if now.duration_since(*last_emit).as_millis() < STICK_SCROLL_MIN_INTERVAL_MS {
        return;
    }
    *last_emit = now;
    let _ = handle.emit(
        "ynotv://gamepad-stick",
        GamepadStickPayload {
            x,
            y,
            gamepad_id,
            gamepad_name: gamepad_name.to_string(),
        },
    );
}

fn connected_gamepads_slot() -> &'static Mutex<HashMap<usize, GamepadInfo>> {
    static S: OnceLock<Mutex<HashMap<usize, GamepadInfo>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get_connected_gamepads() -> Vec<GamepadInfo> {
    if let Ok(map) = connected_gamepads_slot().lock() {
        map.values().cloned().collect()
    } else {
        Vec::new()
    }
}

/// Register a pad in the shared connected list (used by the raw HID backend,
/// whose devices gilrs never sees) and notify the frontend.
pub fn register_connected(info: GamepadInfo) {
    if let Ok(mut map) = connected_gamepads_slot().lock() {
        map.insert(info.id, info);
    }
}

/// Remove a pad from the shared connected list and notify the frontend.
pub fn unregister_connected(id: usize) {
    if let Ok(mut map) = connected_gamepads_slot().lock() {
        map.remove(&id);
    }
}

/// Emit the current connected-pad list to the frontend (`ynotv://gamepad-status`).
pub fn broadcast_status(handle: &AppHandle) {
    let _ = handle.emit(
        "ynotv://gamepad-status",
        GamepadStatusPayload {
            gamepads: get_connected_gamepads(),
        },
    );
}

pub fn start(app_handle: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = app_handle.clone();

    thread::Builder::new()
        .name("ynotv-gamepad".to_string())
        .spawn(move || {
            let mut gilrs = match Gilrs::new() {
                Ok(g) => g,
                Err(e) => {
                    warn!("[gamepad] Failed to initialize gilrs: {}", e);
                    RUNNING.store(false, Ordering::SeqCst);
                    return;
                }
            };

            // Seed currently connected gamepads
            {
                let mut map = connected_gamepads_slot().lock().unwrap_or_else(|e| e.into_inner());
                map.clear();
                for (id, gamepad) in gilrs.gamepads() {
                    let info = GamepadInfo {
                        id: usize::from(id),
                        name: gamepad.name().to_string(),
                        is_connected: gamepad.is_connected(),
                        uuid: format!("{:?}", gamepad.uuid()),
                    };
                    info!("[gamepad] Detected gamepad: {} (ID: {:?})", info.name, info.id);
                    map.insert(info.id, info);
                }
            }

            let initial_list = get_connected_gamepads();
            let _ = handle.emit("ynotv://gamepad-status", GamepadStatusPayload { gamepads: initial_list });

            const AXIS_DEADZONE: f32 = 0.45;
            const REPEAT_DELAY_MS: u128 = 280;
            const REPEAT_INTERVAL_MS: u128 = 120;

            let mut active_dir: Option<&'static str> = None;
            let mut last_dir_time = Instant::now();
            let mut dir_held_since = Instant::now();

            let mut stick_x: f32 = 0.0;
            let mut stick_y: f32 = 0.0;
            let mut stick_rx: f32 = 0.0;
            let mut stick_ry: f32 = 0.0;
            let mut last_scroll_emit = Instant::now();
            let mut last_axis_id: usize = 0;
            let mut last_axis_name = String::from("Controller");

            while RUNNING.load(Ordering::Relaxed) {
                let mut had_event = false;

                while let Some(Event { id, event, time: _ }) = gilrs.next_event() {
                    had_event = true;
                    let gamepad_id = usize::from(id);
                    let gamepad = gilrs.gamepad(id);
                    let gamepad_name = gamepad.name().to_string();

                    match event {
                        EventType::Connected => {
                            info!("[gamepad] Connected: {} (ID: {})", gamepad_name, gamepad_id);
                            let info = GamepadInfo {
                                id: gamepad_id,
                                name: gamepad_name.clone(),
                                is_connected: true,
                                uuid: format!("{:?}", gamepad.uuid()),
                            };
                            if let Ok(mut map) = connected_gamepads_slot().lock() {
                                map.insert(gamepad_id, info);
                            }
                            let _ = handle.emit("ynotv://gamepad-status", GamepadStatusPayload {
                                gamepads: get_connected_gamepads(),
                            });
                        }
                        EventType::Disconnected => {
                            info!("[gamepad] Disconnected: ID {}", gamepad_id);
                            if let Ok(mut map) = connected_gamepads_slot().lock() {
                                map.remove(&gamepad_id);
                            }
                            let _ = handle.emit("ynotv://gamepad-status", GamepadStatusPayload {
                                gamepads: get_connected_gamepads(),
                            });
                        }
                        EventType::ButtonPressed(btn, code) => {
                            let action = map_button_or_code(btn, code);
                            if !action.is_empty() {
                                emit_debug(&gamepad_name, &action, &format!("{:?}", btn), true, gamepad_id);
                                let payload = GamepadPayload {
                                    action,
                                    button: format!("{:?}", btn),
                                    pressed: true,
                                    gamepad_id,
                                    gamepad_name: gamepad_name.clone(),
                                };
                                let _ = handle.emit("ynotv://gamepad", payload);
                            }
                        }
                        EventType::ButtonReleased(btn, code) => {
                            let action = map_button_or_code(btn, code);
                            if !action.is_empty() {
                                emit_debug(&gamepad_name, &action, &format!("{:?}", btn), false, gamepad_id);
                                let payload = GamepadPayload {
                                    action,
                                    button: format!("{:?}", btn),
                                    pressed: false,
                                    gamepad_id,
                                    gamepad_name: gamepad_name.clone(),
                                };
                                let _ = handle.emit("ynotv://gamepad", payload);
                            }
                        }
                        EventType::ButtonChanged(btn, val, code) => {
                            let action = map_button_or_code(btn, code);
                            if !action.is_empty() {
                                let is_pressed = val > 0.4;
                                emit_debug(&gamepad_name, &action, &format!("{:?}", btn), is_pressed, gamepad_id);
                                let payload = GamepadPayload {
                                    action,
                                    button: format!("{:?}", btn),
                                    pressed: is_pressed,
                                    gamepad_id,
                                    gamepad_name: gamepad_name.clone(),
                                };
                                let _ = handle.emit("ynotv://gamepad", payload);
                            }
                        }
                        EventType::AxisChanged(axis, val, _) => {
                            if debug_enabled() {
                                info!(
                                    "[gamepad-debug] {} axis {:?} = {:.3}",
                                    gamepad_name, axis, val
                                );
                            }
                            if axis == Axis::LeftStickX {
                                stick_x = val;
                                last_axis_id = gamepad_id;
                                last_axis_name = gamepad_name.clone();
                            } else if axis == Axis::LeftStickY {
                                stick_y = val;
                                last_axis_id = gamepad_id;
                                last_axis_name = gamepad_name.clone();
                            } else if axis == Axis::RightStickX {
                                stick_rx = val;
                                last_axis_id = gamepad_id;
                                last_axis_name = gamepad_name.clone();
                            } else if axis == Axis::RightStickY {
                                stick_ry = val;
                                last_axis_id = gamepad_id;
                                last_axis_name = gamepad_name.clone();
                            } else if axis == Axis::DPadX {
                                if val > 0.4 {
                                    emit_debug(&gamepad_name, "dpad_right", "DPadRight", true, gamepad_id);
                                    let _ = handle.emit("ynotv://gamepad", GamepadPayload {
                                        action: "dpad_right".to_string(),
                                        button: "DPadRight".to_string(),
                                        pressed: true,
                                        gamepad_id,
                                        gamepad_name: gamepad_name.clone(),
                                    });
                                } else if val < -0.4 {
                                    emit_debug(&gamepad_name, "dpad_left", "DPadLeft", true, gamepad_id);
                                    let _ = handle.emit("ynotv://gamepad", GamepadPayload {
                                        action: "dpad_left".to_string(),
                                        button: "DPadLeft".to_string(),
                                        pressed: true,
                                        gamepad_id,
                                        gamepad_name: gamepad_name.clone(),
                                    });
                                }
                            } else if axis == Axis::DPadY {
                                if val > 0.4 {
                                    emit_debug(&gamepad_name, "dpad_up", "DPadUp", true, gamepad_id);
                                    let _ = handle.emit("ynotv://gamepad", GamepadPayload {
                                        action: "dpad_up".to_string(),
                                        button: "DPadUp".to_string(),
                                        pressed: true,
                                        gamepad_id,
                                        gamepad_name: gamepad_name.clone(),
                                    });
                                } else if val < -0.4 {
                                    emit_debug(&gamepad_name, "dpad_down", "DPadDown", true, gamepad_id);
                                    let _ = handle.emit("ynotv://gamepad", GamepadPayload {
                                        action: "dpad_down".to_string(),
                                        button: "DPadDown".to_string(),
                                        pressed: true,
                                        gamepad_id,
                                        gamepad_name: gamepad_name.clone(),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }

                // Process analog stick navigation with repeat timing
                let current_dir = if stick_y > AXIS_DEADZONE {
                    Some("dpad_up")
                } else if stick_y < -AXIS_DEADZONE {
                    Some("dpad_down")
                } else if stick_x < -AXIS_DEADZONE {
                    Some("dpad_left")
                } else if stick_x > AXIS_DEADZONE {
                    Some("dpad_right")
                } else {
                    None
                };

                let now = Instant::now();
                if let Some(dir) = current_dir {
                    if active_dir != Some(dir) {
                        active_dir = Some(dir);
                        dir_held_since = now;
                        last_dir_time = now;
                        emit_debug("Analog", dir, "LeftStick", true, 0);
                        let payload = GamepadPayload {
                            action: dir.to_string(),
                            button: "LeftStick".to_string(),
                            pressed: true,
                            gamepad_id: 0,
                            gamepad_name: "Analog".to_string(),
                        };
                        let _ = handle.emit("ynotv://gamepad", payload);
                    } else {
                        let held_duration = now.duration_since(dir_held_since).as_millis();
                        let since_last = now.duration_since(last_dir_time).as_millis();
                        if held_duration >= REPEAT_DELAY_MS && since_last >= REPEAT_INTERVAL_MS {
                            last_dir_time = now;
                            emit_debug("Analog", dir, "LeftStick", true, 0);
                            let payload = GamepadPayload {
                                action: dir.to_string(),
                                button: "LeftStick".to_string(),
                                pressed: true,
                                gamepad_id: 0,
                                gamepad_name: "Analog".to_string(),
                            };
                            let _ = handle.emit("ynotv://gamepad", payload);
                        }
                    }
                } else if active_dir.is_some() {
                    active_dir = None;
                }

                // Right analog stick → smooth page scrolling (ynotv://gamepad-stick),
                // emitted natively so XInput pads keep scrolling even after the
                // browser poller hands them off to the claimed native backend.
                let rmag = (stick_rx * stick_rx + stick_ry * stick_ry).sqrt();
                if rmag > 0.12 {
                    emit_stick_scroll(
                        &handle,
                        stick_rx,
                        stick_ry,
                        last_axis_id,
                        &last_axis_name,
                        &mut last_scroll_emit,
                    );
                }

                if !had_event {
                    thread::sleep(Duration::from_millis(10));
                }
            }

            info!("[gamepad] Background listener stopped.");
        })
        .expect("failed to spawn ynotv-gamepad thread");
}

pub fn shutdown() {
    RUNNING.store(false, Ordering::SeqCst);
}

fn map_button_or_code(btn: Button, code: gilrs::ev::Code) -> String {
    let mapped = map_button(btn);
    if !mapped.is_empty() {
        return mapped.to_string();
    }
    let raw = code.into_u32();
    match raw {
        // DirectInput / WGI / Linux evdev offsets for PlayStation & Bluetooth controllers
        0 | 304 => "south".to_string(), // Cross / A
        1 | 305 => "east".to_string(),  // Circle / B
        2 | 307 => "west".to_string(),  // Square / X
        3 | 308 => "north".to_string(), // Triangle / Y
        4 | 310 => "left_bumper".to_string(),  // L1
        5 | 311 => "right_bumper".to_string(), // R1
        6 | 312 => "left_trigger".to_string(), // L2
        7 | 313 => "right_trigger".to_string(), // R2
        8 | 314 => "select".to_string(), // Share / Create
        9 | 315 => "start".to_string(),  // Options / Menu
        10 | 317 => "left_stick_click".to_string(),  // L3
        11 | 318 => "right_stick_click".to_string(), // R3
        12 | 316 => "guide".to_string(), // PS Button
        13 => "touchpad".to_string(), // Touchpad Click
        14 => "dpad_up".to_string(),
        15 => "dpad_down".to_string(),
        16 => "dpad_left".to_string(),
        17 => "dpad_right".to_string(),
        _ => format!("button_{}", raw),
    }
}

fn map_button(btn: Button) -> &'static str {
    match btn {
        Button::South => "south",
        Button::East => "east",
        Button::North => "north",
        Button::West => "west",
        Button::DPadUp => "dpad_up",
        Button::DPadDown => "dpad_down",
        Button::DPadLeft => "dpad_left",
        Button::DPadRight => "dpad_right",
        Button::LeftTrigger => "left_bumper",
        Button::RightTrigger => "right_bumper",
        Button::LeftTrigger2 => "left_trigger",
        Button::RightTrigger2 => "right_trigger",
        Button::LeftThumb => "left_stick_click",
        Button::RightThumb => "right_stick_click",
        Button::Start => "start",
        Button::Select => "select",
        Button::Mode => "guide",
        _ => "",
    }
}
