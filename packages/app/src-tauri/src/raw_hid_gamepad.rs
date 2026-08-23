//! Raw HID gamepad backend for DirectInput-only controllers.
//!
//! gilrs (XInput backend) covers standard pads — real Xbox controllers and
//! DualSense pads emulated as Xbox 360. But a *raw* DualSense / DualShock over
//! Bluetooth or USB is a HID device that XInput never sees, and Chromium's
//! Gamepad API refuses to expose gamepad data while the window is unfocused
//! (and is unreliable for these pads even when focused). To make those pads
//! emit input in the background, we read the HID input reports directly.
//!
//! The report layouts for DualSense and DualShock 4 are public and stable
//! (the same ones hid-playstation / DS4Windows / DualSenseX parse), so we
//! decode them without any Chromium in the loop and emit the exact same
//! `ynotv://gamepad` payloads as the gilrs backend — the frontend listener,
//! mapping, dedupe and focus gates apply unchanged.
//!
//! Device lifecycle: a scanner thread re-lists HID devices every few seconds
//! and opens any new target (gamepad-usage) Sony pads; each device gets its
//! own reader thread with a blocking `hid_read`. A read error means the pad
//! was unplugged (or the app is shutting down), so the thread cleans up and
//! the scanner re-opens it if it comes back.

use hidapi::{HidApi, HidDevice};
use log::{info, warn};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::gamepad::{emit_stick_scroll, GamepadInfo, GamepadPayload};

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Device paths currently open by a reader thread, so the scanner doesn't
/// open the same device twice.
static OPEN_PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn open_paths() -> &'static Mutex<HashSet<String>> {
    OPEN_PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

static DEBUG: OnceLock<bool> = OnceLock::new();

/// Opt-in diagnostics via `YNOTV_HID_DEBUG=1`. When enabled, every raw report
/// (hex), the decoded state, and every emitted event is logged at info level
/// so phantom input can be traced to its exact byte-level source. Checked
/// once, so set the variable before the app starts.
pub fn debug_enabled() -> bool {
    *DEBUG.get_or_init(|| {
        std::env::var("YNOTV_HID_DEBUG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

fn hex_bytes(buf: &[u8]) -> String {
    buf.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ")
}

/// Median of the raw stick samples (robust to a few wiggles during the
/// calibration window). Falls back to the nominal 0x80 center when empty.
fn median_u8(values: &[u8]) -> f32 {
    if values.is_empty() {
        return 128.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2] as f32
    } else {
        (sorted[n / 2 - 1] as f32 + sorted[n / 2] as f32) / 2.0
    }
}

const SONY_VID: u16 = 0x054c;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Profile {
    DualSense,
    DualShock4,
}

impl Profile {
    fn parse(self, buf: &[u8]) -> Option<ReportState> {
        match self {
            Profile::DualSense => parse_dualsense(buf),
            Profile::DualShock4 => parse_ds4(buf),
        }
    }
}

fn profile_for(vid: u16, pid: u16) -> Option<Profile> {
    match (vid, pid) {
        // DualSense (standard) and DualSense Edge — the input report layout
        // differs between USB and Bluetooth (see parse_dualsense).
        (SONY_VID, 0x0ce6) | (SONY_VID, 0x0df2) => Some(Profile::DualSense),
        // DualShock 4 (USB) and DualShock 4 (Bluetooth).
        (SONY_VID, 0x0ba0) | (SONY_VID, 0x09cc) => Some(Profile::DualShock4),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Report decoding
// ---------------------------------------------------------------------------

/// Decoded snapshot of one input report.
///
/// The normalized stick fields are only consumed by the unit tests (the
/// reader works from the raw bytes so it can apply the measured center), so
/// silence the dead-code lint for non-test builds.
#[allow(dead_code)]
struct ReportState {
    /// Standard action bits — see the BIT_* constants below.
    buttons: u32,
    /// Left stick X, normalized to [-1, 1] (right positive), assuming the
    /// nominal 0x80 center. The reader re-normalizes with the device's
    /// measured center; this 0x80-relative value is what the unit tests assert.
    stick_x: f32,
    /// Left stick Y, normalized to [-1, 1] with UP positive, 0x80-relative.
    stick_y: f32,
    /// Raw left-stick X byte as read from the report (for auto-calibration).
    raw_x: u8,
    /// Raw left-stick Y byte as read from the report (for auto-calibration).
    raw_y: u8,
    /// Right stick X, normalized to [-1, 1] (right positive), 0x80-relative.
    rstick_x: f32,
    /// Right stick Y, normalized to [-1, 1] with UP positive, 0x80-relative.
    rstick_y: f32,
    /// Raw right-stick X byte as read from the report (for auto-calibration).
    raw_rx: u8,
    /// Raw right-stick Y byte as read from the report (for auto-calibration).
    raw_ry: u8,
}

/// Locate the report payload and validate the report ID.
///
/// On Windows, Bluetooth HID input reports are delivered with the HIDP data
/// header prepended: `[0]=0xA1, [1]=report ID, [2..]=data`. USB (and some
/// stacks) deliver just `[0]=report ID, [1..]=data`. Stripping the 0xA1
/// header and requiring a known report ID means a frame is only ever decoded
/// when it actually starts with one of the pad's real reports — a misread
/// frame can never produce phantom input. Returns the validated report ID
/// (callers need it to pick the connection-mode byte offsets) and the payload
/// slice after it.
fn extract_payload<'a>(buf: &'a [u8], known_ids: &[u8]) -> Option<(u8, &'a [u8])> {
    if buf.len() < 2 {
        return None;
    }
    let (id, payload) = if buf[0] == 0xA1 {
        if buf.len() < 3 {
            return None;
        }
        (buf[1], &buf[2..])
    } else {
        (buf[0], &buf[1..])
    };
    if !known_ids.contains(&id) {
        return None;
    }
    Some((id, payload))
}

const BIT_SOUTH: u32 = 1 << 0; // Cross
const BIT_EAST: u32 = 1 << 1; // Circle
const BIT_WEST: u32 = 1 << 2; // Square
const BIT_NORTH: u32 = 1 << 3; // Triangle
const BIT_LEFT_BUMPER: u32 = 1 << 4; // L1
const BIT_RIGHT_BUMPER: u32 = 1 << 5; // R1
const BIT_LEFT_TRIGGER: u32 = 1 << 6; // L2
const BIT_RIGHT_TRIGGER: u32 = 1 << 7; // R2
const BIT_SELECT: u32 = 1 << 8; // Share / Create
const BIT_START: u32 = 1 << 9; // Options
const BIT_LEFT_STICK: u32 = 1 << 10; // L3
const BIT_RIGHT_STICK: u32 = 1 << 11; // R3
const BIT_GUIDE: u32 = 1 << 12; // PS / Home
const BIT_TOUCHPAD: u32 = 1 << 13;
const BIT_DPAD_UP: u32 = 1 << 14;
const BIT_DPAD_RIGHT: u32 = 1 << 15;
const BIT_DPAD_DOWN: u32 = 1 << 16;
const BIT_DPAD_LEFT: u32 = 1 << 17;

/// (bit index, action name, raw button label) — emitted exactly like gilrs.
const BUTTONS: &[(u32, &str, &str)] = &[
    (0, "south", "Cross"),
    (1, "east", "Circle"),
    (2, "west", "Square"),
    (3, "north", "Triangle"),
    (4, "left_bumper", "L1"),
    (5, "right_bumper", "R1"),
    (6, "left_trigger", "L2"),
    (7, "right_trigger", "R2"),
    (8, "select", "Share"),
    (9, "start", "Options"),
    (10, "left_stick_click", "L3"),
    (11, "right_stick_click", "R3"),
    (12, "guide", "PS"),
    (13, "touchpad", "Touchpad"),
    (14, "dpad_up", "DpadUp"),
    (15, "dpad_right", "DpadRight"),
    (16, "dpad_down", "DpadDown"),
    (17, "dpad_left", "DpadLeft"),
];

/// DualSense input reports. The byte layout differs by connection mode — this
/// is the "tri-offset" system documented by SDL / hid-playstation / the Linux
/// kernel driver and the public DualSense docs:
///   USB report 0x01 (64 bytes):    [1]=LX [2]=LY [3]=RX [4]=RY [5]=L2 [6]=R2
///                                  [8]=hat+face [9]=shoulders+system [10]=PS/touch
///   BT simplified 0x01 (10 bytes): [1]=LX [2]=LY [3]=RX [4]=RY [5]=hat+face
///                                  [6]=shoulders+system [7]=PS/touch [8]=L2 [9]=R2
///   BT full 0x31 (78 bytes):       everything +1 — [1]=packet counter
///                                  [2]=LX [3]=LY [4]=RX [5]=RY [6]=L2 [7]=R2
///                                  [9]=hat+face [10]=shoulders+system [11]=PS/touch
/// The BT full report is what arrives over Bluetooth once the host has switched
/// the pad into full mode. Parsing it with the USB offsets reads the packet
/// counter as left-stick X (≈−0.99), which produced the phantom D-pad spam.
/// Button byte layouts (same for every mode):
///   hat+face byte: bits 3-0 = D-pad hat (0=up, 1=up-right, 2=right, 3=down-right,
///       4=down, 5=down-left, 6=left, 7=up-left, 8+=none); bit4=Square(west),
///       bit5=Cross(south), bit6=Circle(east), bit7=Triangle(north)
///   shoulders+system byte: L1=0x01, R1=0x02, L2=0x04, R2=0x08, Create=0x10,
///       Options=0x20, L3=0x40, R3=0x80
///   PS/touch byte: PS=0x01, touchpad=0x02, mute=0x04
fn parse_dualsense(buf: &[u8]) -> Option<ReportState> {
    let (id, p) = extract_payload(buf, &[0x01, 0x31])?;
    // Payload-index offset for sticks and the hat+face button byte per mode.
    let (stick_ofs, btn_ofs) = match id {
        0x31 => (1, 8),                       // BT full (78-byte) report
        0x01 if p.len() >= 62 => (0, 7),      // USB full (64-byte) report
        _ => (0, 4),                          // BT simplified (10-byte) report
    };
    if p.len() < btn_ofs + 3 {
        return None;
    }
    let mut buttons: u32 = 0;
    let b0 = p[btn_ofs]; // D-pad hat + face
    let b1 = p[btn_ofs + 1]; // shoulders + system
    let b2 = p[btn_ofs + 2]; // PS / touchpad / mute
    if b0 & 0x10 != 0 {
        buttons |= BIT_WEST;
    }
    if b0 & 0x20 != 0 {
        buttons |= BIT_SOUTH;
    }
    if b0 & 0x40 != 0 {
        buttons |= BIT_EAST;
    }
    if b0 & 0x80 != 0 {
        buttons |= BIT_NORTH;
    }
    if b1 & 0x01 != 0 {
        buttons |= BIT_LEFT_BUMPER;
    }
    if b1 & 0x02 != 0 {
        buttons |= BIT_RIGHT_BUMPER;
    }
    if b1 & 0x04 != 0 {
        buttons |= BIT_LEFT_TRIGGER;
    }
    if b1 & 0x08 != 0 {
        buttons |= BIT_RIGHT_TRIGGER;
    }
    if b1 & 0x10 != 0 {
        buttons |= BIT_SELECT;
    }
    if b1 & 0x20 != 0 {
        buttons |= BIT_START;
    }
    if b1 & 0x40 != 0 {
        buttons |= BIT_LEFT_STICK;
    }
    if b1 & 0x80 != 0 {
        buttons |= BIT_RIGHT_STICK;
    }
    if b2 & 0x01 != 0 {
        buttons |= BIT_GUIDE;
    }
    if b2 & 0x02 != 0 {
        buttons |= BIT_TOUCHPAD;
    }
    match b0 & 0x0f {
        0 => buttons |= BIT_DPAD_UP,
        1 => buttons |= BIT_DPAD_UP | BIT_DPAD_RIGHT,
        2 => buttons |= BIT_DPAD_RIGHT,
        3 => buttons |= BIT_DPAD_DOWN | BIT_DPAD_RIGHT,
        4 => buttons |= BIT_DPAD_DOWN,
        5 => buttons |= BIT_DPAD_DOWN | BIT_DPAD_LEFT,
        6 => buttons |= BIT_DPAD_LEFT,
        7 => buttons |= BIT_DPAD_UP | BIT_DPAD_LEFT,
        _ => {}
    }
    Some(ReportState {
        buttons,
        stick_x: (p[stick_ofs] as f32 - 128.0) / 128.0,
        stick_y: (128.0 - p[stick_ofs + 1] as f32) / 128.0,
        raw_x: p[stick_ofs],
        raw_y: p[stick_ofs + 1],
        rstick_x: (p[stick_ofs + 2] as f32 - 128.0) / 128.0,
        rstick_y: (128.0 - p[stick_ofs + 3] as f32) / 128.0,
        raw_rx: p[stick_ofs + 2],
        raw_ry: p[stick_ofs + 3],
    })
}

/// DualShock 4 input report. USB report 0x01 (64 bytes) and BT report 0x11
/// (78 bytes) — the BT report carries an extra header byte at [1], shifting
/// every field +1:
///   USB:  [1]=LX [2]=LY [3]=RX [4]=RY [5]=hat+face [6]=shoulders [7]=PS/touch
///         [8]=L2 analog [9]=R2 analog
///   BT:   [1]=header [2]=LX [3]=LY [4]=RX [5]=RY [6]=hat+face [7]=shoulders
///         [8]=PS/touch [9]=L2 analog [10]=R2 analog
///   hat+face byte: low nibble = D-pad rotation (0=up, 1=up-right, 2=right,
///       3=down-right, 4=down, 5=down-left, 6=left, 7=up-left, 8+=none);
///       Square=0x10, Cross=0x20, Circle=0x40, Triangle=0x80
///   shoulders byte: L1=0x01, R1=0x02, L2=0x04, R2=0x08, Share=0x10,
///       Options=0x20, L3=0x40, R3=0x80
///   PS/touch byte: PS=0x01, touchpad=0x02
fn parse_ds4(buf: &[u8]) -> Option<ReportState> {
    let (id, p) = extract_payload(buf, &[0x01, 0x11])?;
    let (stick_ofs, btn_ofs) = if id == 0x11 {
        (1, 5) // BT — header byte at data[1], everything +1
    } else {
        (0, 4) // USB
    };
    if p.len() < btn_ofs + 3 {
        return None;
    }
    let mut buttons: u32 = 0;
    let b5 = p[btn_ofs];
    let b6 = p[btn_ofs + 1];
    let b7 = p[btn_ofs + 2];
    if b5 & 0x10 != 0 {
        buttons |= BIT_WEST;
    }
    if b5 & 0x20 != 0 {
        buttons |= BIT_SOUTH;
    }
    if b5 & 0x40 != 0 {
        buttons |= BIT_EAST;
    }
    if b5 & 0x80 != 0 {
        buttons |= BIT_NORTH;
    }
    if b6 & 0x01 != 0 {
        buttons |= BIT_LEFT_BUMPER;
    }
    if b6 & 0x02 != 0 {
        buttons |= BIT_RIGHT_BUMPER;
    }
    if b6 & 0x04 != 0 {
        buttons |= BIT_LEFT_TRIGGER;
    }
    if b6 & 0x08 != 0 {
        buttons |= BIT_RIGHT_TRIGGER;
    }
    if b6 & 0x10 != 0 {
        buttons |= BIT_SELECT;
    }
    if b6 & 0x20 != 0 {
        buttons |= BIT_START;
    }
    if b6 & 0x40 != 0 {
        buttons |= BIT_LEFT_STICK;
    }
    if b6 & 0x80 != 0 {
        buttons |= BIT_RIGHT_STICK;
    }
    if b7 & 0x01 != 0 {
        buttons |= BIT_GUIDE;
    }
    if b7 & 0x02 != 0 {
        buttons |= BIT_TOUCHPAD;
    }
    match b5 & 0x0f {
        0 => buttons |= BIT_DPAD_UP,
        1 => buttons |= BIT_DPAD_UP | BIT_DPAD_RIGHT,
        2 => buttons |= BIT_DPAD_RIGHT,
        3 => buttons |= BIT_DPAD_DOWN | BIT_DPAD_RIGHT,
        4 => buttons |= BIT_DPAD_DOWN,
        5 => buttons |= BIT_DPAD_DOWN | BIT_DPAD_LEFT,
        6 => buttons |= BIT_DPAD_LEFT,
        7 => buttons |= BIT_DPAD_UP | BIT_DPAD_LEFT,
        _ => {}
    }
    Some(ReportState {
        buttons,
        stick_x: (p[stick_ofs] as f32 - 128.0) / 128.0,
        stick_y: (128.0 - p[stick_ofs + 1] as f32) / 128.0,
        raw_x: p[stick_ofs],
        raw_y: p[stick_ofs + 1],
        rstick_x: (p[stick_ofs + 2] as f32 - 128.0) / 128.0,
        rstick_y: (128.0 - p[stick_ofs + 3] as f32) / 128.0,
        raw_rx: p[stick_ofs + 2],
        raw_ry: p[stick_ofs + 3],
    })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

pub fn start(app_handle: &AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    let handle = app_handle.clone();
    thread::Builder::new()
        .name("ynotv-hid-gamepad".to_string())
        .spawn(move || {
            let api = match HidApi::new() {
                Ok(a) => a,
                Err(e) => {
                    warn!("[raw-hid] Failed to init HID API: {}", e);
                    RUNNING.store(false, Ordering::SeqCst);
                    return;
                }
            };

            if debug_enabled() {
                // Log every Sony HID node (not just gamepad-usage ones) once, so
                // the device topology is visible — a pad that exposes several
                // interfaces (audio, touchpad, …) can otherwise open twice.
                let mut found = false;
                for dev in api.device_list() {
                    if dev.vendor_id() == SONY_VID {
                        found = true;
                        info!(
                            "[raw-hid-debug] scan: Sony vid={:04x} pid={:04x} usage_page={:02x} usage={:02x} interface={:?} path={}",
                            dev.vendor_id(),
                            dev.product_id(),
                            dev.usage_page(),
                            dev.usage(),
                            dev.interface_number(),
                            dev.path().to_string_lossy()
                        );
                    }
                }
                if !found {
                    info!("[raw-hid-debug] scan: no Sony HID devices found");
                }
            }

            let mut next_id: usize = 100;
            while RUNNING.load(Ordering::Relaxed) {
                for dev in api.device_list() {
                    let Some(profile) = profile_for(dev.vendor_id(), dev.product_id()) else {
                        continue;
                    };
                    // Only the gamepad HID interface — Sony pads also expose
                    // audio/other interfaces that we must never read from.
                    if dev.usage_page() != 0x01 || dev.usage() != 0x05 {
                        continue;
                    }
                    let path = dev.path().to_string_lossy().to_string();
                    let already_open = open_paths().lock().map(|s| s.contains(&path)).unwrap_or(false);
                    if already_open {
                        continue;
                    }
                    let product = dev
                        .product_string()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "HID Gamepad".to_string());
                    // vid:pid in the name lets the frontend match this pad
                    // against the browser Gamepad API's device string (which
                    // contains "Vendor: 054c Product: 0ce6") so it can tell
                    // the two sources apart.
                    let name = format!(
                        "{} (HID {:04x}:{:04x})",
                        product,
                        dev.vendor_id(),
                        dev.product_id()
                    );
                    match api.open_path(dev.path()) {
                        Ok(device) => {
                            info!(
                                "[raw-hid] Opened {} (vid={:04x} pid={:04x})",
                                name,
                                dev.vendor_id(),
                                dev.product_id()
                            );
                            if let Ok(mut set) = open_paths().lock() {
                                set.insert(path.clone());
                            }
                            let id = next_id;
                            next_id += 1;
                            // Surface the pad in Settings → Controllers: gilrs
                            // never sees raw HID pads, so register it in the
                            // shared connected list and broadcast a status
                            // update like the gilrs backend does.
                            crate::gamepad::register_connected(GamepadInfo {
                                id,
                                name: name.clone(),
                                is_connected: true,
                                uuid: format!(
                                    "hid-{:04x}:{:04x}:{}",
                                    dev.vendor_id(),
                                    dev.product_id(),
                                    dev.path().to_string_lossy()
                                ),
                            });
                            crate::gamepad::broadcast_status(&handle);
                            let h = handle.clone();
                            thread::Builder::new()
                                .name(format!("ynotv-hid-reader-{}", id))
                                .spawn(move || run_reader(h, device, path, name, profile, id))
                                .expect("failed to spawn HID reader thread");
                        }
                        Err(e) => {
                            warn!("[raw-hid] Failed to open {}: {}", name, e);
                        }
                    }
                }
                thread::sleep(Duration::from_secs(5));
            }
            info!("[raw-hid] Listener stopped.");
        })
        .expect("failed to spawn ynotv-hid-gamepad thread");
}

pub fn shutdown() {
    RUNNING.store(false, Ordering::SeqCst);
    if let Ok(mut set) = open_paths().lock() {
        set.clear();
    }
}

// ---------------------------------------------------------------------------
// Per-device reader
// ---------------------------------------------------------------------------

const STICK_DEADZONE: f32 = 0.45;
const REPEAT_DELAY_MS: u128 = 280;
const REPEAT_INTERVAL_MS: u128 = 120;

fn run_reader(
    app: AppHandle,
    device: HidDevice,
    path: String,
    name: String,
    profile: Profile,
    gamepad_id: usize,
) {
    let mut buf = [0u8; 78];
    let mut prev_buttons: u32 = 0;
    let mut prev_sx: f32 = 0.0;
    let mut prev_sy: f32 = 0.0;
    let mut prev_rx: f32 = 0.0;
    let mut prev_ry: f32 = 0.0;
    let mut prev_dir: Option<&'static str> = None;
    let mut dir_held_since = Instant::now();
    let mut last_dir_time = Instant::now();
    let mut last_scroll_emit = Instant::now();
    let mut logged_first_report = false;

    // ── Stick auto-calibration ────────────────────────────────────────────
    // Sony pads rarely rest at exactly 0x80 — the DualSense measured here sits
    // at 0x82/0x7c, a few counts off-center. Normally the deadzone absorbs
    // that, but a worn or drifting stick can rest well past it and read as
    // constant phantom direction. So on connect we collect the raw stick bytes
    // for the first ~500ms (or 100 reports) and use the median as the device's
    // zero point for its whole lifetime — re-measured fresh on every connect,
    // so a stored value can never go stale.
    const CALIB_MAX_SAMPLES: usize = 100;
    const CALIB_WINDOW_MS: u128 = 500;
    let calib_start = Instant::now();
    let mut calib_x: Vec<u8> = Vec::new();
    let mut calib_y: Vec<u8> = Vec::new();
    let mut calib_rx: Vec<u8> = Vec::new();
    let mut calib_ry: Vec<u8> = Vec::new();
    let mut calibrated = false;
    let mut center_x: f32 = 128.0;
    let mut center_y: f32 = 128.0;
    let mut center_rx: f32 = 128.0;
    let mut center_ry: f32 = 128.0;

    loop {
        match device.read(&mut buf) {
            Ok(n) => {
                let dbg = debug_enabled();
                if dbg {
                    info!(
                        "[raw-hid-debug] {} report {}B: {}",
                        name,
                        n,
                        hex_bytes(&buf[..n])
                    );
                }
                if !logged_first_report {
                    logged_first_report = true;
                    info!(
                        "[raw-hid] {} first report: {} bytes: {}",
                        name,
                        n,
                        hex_bytes(&buf[..n])
                    );
                }
                let Some(state) = profile.parse(&buf[..n]) else {
                    if dbg {
                        warn!(
                            "[raw-hid-debug] {} UNPARSED report {}B: {}",
                            name,
                            n,
                            hex_bytes(&buf[..n])
                        );
                    }
                    continue;
                };

                // Feed the calibration window until it fills or times out,
                // then lock in the measured center for this device.
                if !calibrated {
                    if calib_x.len() < CALIB_MAX_SAMPLES
                        && calib_start.elapsed().as_millis() < CALIB_WINDOW_MS
                    {
                        calib_x.push(state.raw_x);
                        calib_y.push(state.raw_y);
                        calib_rx.push(state.raw_rx);
                        calib_ry.push(state.raw_ry);
                    } else if !calib_x.is_empty() {
                        center_x = median_u8(&calib_x);
                        center_y = median_u8(&calib_y);
                        center_rx = median_u8(&calib_rx);
                        center_ry = median_u8(&calib_ry);
                        calibrated = true;
                        info!(
                            "[raw-hid] {} stick center calibrated: L=({:.0},{:.0}) R=({:.0},{:.0}) ({} samples)",
                            name,
                            center_x,
                            center_y,
                            center_rx,
                            center_ry,
                            calib_x.len()
                        );
                    } else {
                        // No samples arrived; keep the nominal 0x80 center.
                        calibrated = true;
                    }
                }

                // Effective stick position relative to the measured center.
                let eff_x = ((state.raw_x as f32 - center_x) / 128.0).clamp(-1.0, 1.0);
                let eff_y = ((center_y - state.raw_y as f32) / 128.0).clamp(-1.0, 1.0);
                let eff_rx = ((state.raw_rx as f32 - center_rx) / 128.0).clamp(-1.0, 1.0);
                let eff_ry = ((center_ry - state.raw_ry as f32) / 128.0).clamp(-1.0, 1.0);
                if dbg
                    && (state.buttons != prev_buttons
                        || (eff_x - prev_sx).abs() > 0.01
                        || (eff_y - prev_sy).abs() > 0.01
                        || (eff_rx - prev_rx).abs() > 0.01
                        || (eff_ry - prev_ry).abs() > 0.01)
                {
                    info!(
                        "[raw-hid-debug] {} state: raw=({},{},{},{}) L=({:.3},{:.3}) R=({:.3},{:.3}) buttons={:08x}",
                        name,
                        state.raw_x,
                        state.raw_y,
                        state.raw_rx,
                        state.raw_ry,
                        eff_x,
                        eff_y,
                        eff_rx,
                        eff_ry,
                        state.buttons
                    );
                }
                prev_sx = eff_x;
                prev_sy = eff_y;
                prev_rx = eff_rx;
                prev_ry = eff_ry;

                // Button edge events (rising and falling edges — the frontend
                // only acts on presses, but releases keep the monitor honest).
                let changed = state.buttons ^ prev_buttons;
                if changed != 0 {
                    for (bit, action, label) in BUTTONS {
                        if changed & (1 << bit) != 0 {
                            let pressed = state.buttons & (1 << bit) != 0;
                            if dbg {
                                info!(
                                    "[raw-hid-debug] {} emit {} ({}) pressed={} id={}",
                                    name, action, label, pressed, gamepad_id
                                );
                            }
                            let _ = app.emit(
                                "ynotv://gamepad",
                                GamepadPayload {
                                    action: (*action).to_string(),
                                    button: (*label).to_string(),
                                    pressed,
                                    gamepad_id,
                                    gamepad_name: name.clone(),
                                },
                            );
                        }
                    }
                }
                prev_buttons = state.buttons;

                // Left stick → D-pad direction, with the same deadzone and
                // repeat timing as the gilrs backend (using the calibrated
                // effective values).
                let dir = if eff_y > STICK_DEADZONE {
                    Some("dpad_up")
                } else if eff_y < -STICK_DEADZONE {
                    Some("dpad_down")
                } else if eff_x < -STICK_DEADZONE {
                    Some("dpad_left")
                } else if eff_x > STICK_DEADZONE {
                    Some("dpad_right")
                } else {
                    None
                };

                let now = Instant::now();
                if let Some(d) = dir {
                    if prev_dir != Some(d) {
                        prev_dir = Some(d);
                        dir_held_since = now;
                        last_dir_time = now;
                        emit_stick_dir(&app, d, gamepad_id, &name);
                    } else {
                        let held = now.duration_since(dir_held_since).as_millis();
                        let since_last = now.duration_since(last_dir_time).as_millis();
                        if held >= REPEAT_DELAY_MS && since_last >= REPEAT_INTERVAL_MS {
                            last_dir_time = now;
                            emit_stick_dir(&app, d, gamepad_id, &name);
                        }
                    }
                } else if prev_dir.is_some() {
                    prev_dir = None;
                }

                // Right analog stick → smooth page scrolling (ynotv://gamepad-stick),
                // from the calibrated raw bytes. This backend drives claimed pads
                // (the browser poller only scrolls pads the native side hasn't
                // claimed), so the right stick has to be emitted here.
                let rmag = (eff_rx * eff_rx + eff_ry * eff_ry).sqrt();
                if rmag > 0.12 {
                    if dbg {
                        info!(
                            "[raw-hid-debug] {} emit right_stick_scroll x={:.3} y={:.3} id={}",
                            name, eff_rx, eff_ry, gamepad_id
                        );
                    }
                    emit_stick_scroll(&app, eff_rx, eff_ry, gamepad_id, &name, &mut last_scroll_emit);
                }
            }
            Err(e) => {
                // Blocking read returns an error when the pad is unplugged,
                // disabled, or the app is shutting down.
                warn!("[raw-hid] {} read error/disconnect: {}", name, e);
                break;
            }
        }
    }

    if let Ok(mut set) = open_paths().lock() {
        set.remove(&path);
    }
    // The pad left (unplugged, disabled, or app shutdown) — drop it from the
    // connected list so Settings → Controllers reflects reality.
    crate::gamepad::unregister_connected(gamepad_id);
    crate::gamepad::broadcast_status(&app);
    info!("[raw-hid] {} closed", name);
}

fn emit_stick_dir(app: &AppHandle, action: &str, gamepad_id: usize, name: &str) {
    if debug_enabled() {
        info!(
            "[raw-hid-debug] {} emit {} (LeftStick) pressed=true id={}",
            name, action, gamepad_id
        );
    }
    let _ = app.emit(
        "ynotv://gamepad",
        GamepadPayload {
            action: action.to_string(),
            button: "LeftStick".to_string(),
            pressed: true,
            gamepad_id,
            gamepad_name: name.to_string(),
        },
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a report where `data` starts right after the report ID at [1].
    /// Used for the USB layouts (DualSense / DS4 USB and DS4-BT-like shapes).
    fn report(id: u8, data: &[u8]) -> Vec<u8> {
        let mut buf = vec![0u8; 78];
        buf[0] = id;
        for (i, &v) in data.iter().take(77).enumerate() {
            buf[1 + i] = v;
        }
        buf
    }

    /// Build a DualSense full Bluetooth report (0x31): [0]=0x31,
    /// [1]=packet counter, then `data` starting at [2].
    fn report_bt31(counter: u8, data: &[u8]) -> Vec<u8> {
        let mut buf = vec![0u8; 78];
        buf[0] = 0x31;
        buf[1] = counter;
        for (i, &v) in data.iter().take(76).enumerate() {
            buf[2 + i] = v;
        }
        buf
    }

    #[test]
    fn dualsense_usb_layout() {
        // USB report: data[0..4]=sticks, data[7]=hat+face, data[8]=shoulders+system,
        // data[9]=PS/touch. hat+face 0x20 = cross + dpad nibble 0 (up);
        // shoulders 0x41 = L1 + L3; PS/touch 0x01 = PS button.
        let r = report(0x01, &[128, 128, 128, 128, 0, 0, 0, 0x20, 0x41, 0x01]);
        let s = parse_dualsense(&r).unwrap();
        assert_ne!(s.buttons & BIT_SOUTH, 0);
        assert_ne!(s.buttons & BIT_DPAD_UP, 0);
        assert_ne!(s.buttons & BIT_LEFT_BUMPER, 0);
        assert_ne!(s.buttons & BIT_LEFT_STICK, 0);
        assert_ne!(s.buttons & BIT_GUIDE, 0);
        assert_eq!(s.buttons & BIT_EAST, 0);
        assert_eq!(s.buttons & BIT_RIGHT_BUMPER, 0);
        assert_eq!(s.buttons & BIT_TOUCHPAD, 0);
    }

    #[test]
    fn dualsense_bt31_counter_is_not_a_stick() {
        // Regression test for the phantom D-pad spam: the full BT report has a
        // packet counter at [1]. Parsing it with the USB layout read that
        // counter as left-stick X — 0xf1 normalized to ≈−0.88 (right) and 0x01
        // to ≈−0.99 (left), alternating as the counter advanced. With the
        // correct BT offset, a resting pad must decode to centered sticks and
        // no direction regardless of the counter value.
        let resting = [128, 128, 128, 128, 0, 0, 0, 0x08, 0, 0]; // hat nibble 8 = neutral
        for counter in [0xf1u8, 0x01, 0x11, 0x21, 0x31] {
            let s = parse_dualsense(&report_bt31(counter, &resting)).unwrap();
            assert!(
                s.stick_x.abs() < 0.05,
                "counter 0x{:02x} leaked into stick_x: {}",
                counter,
                s.stick_x
            );
            assert!(s.stick_y.abs() < 0.05);
            assert!(s.rstick_x.abs() < 0.05);
            assert!(s.rstick_y.abs() < 0.05);
            assert_eq!(s.buttons & (BIT_DPAD_LEFT | BIT_DPAD_RIGHT | BIT_DPAD_UP | BIT_DPAD_DOWN), 0);
            assert_eq!(s.buttons & (BIT_WEST | BIT_SOUTH | BIT_EAST | BIT_NORTH), 0);
        }
    }

    #[test]
    fn dualsense_right_stick_offsets() {
        // Right stick sits at RX/RY = data[3]/data[4] (after the left stick).
        // USB: data[3]=0 → rstick_x = −1 (full left); data[4]=255 → rstick_y = −1
        // (full down). The BT full report shifts everything +1, so RX=0/RY=255
        // at data[4]/data[5] must decode identically.
        let usb = report(0x01, &[128, 128, 0, 255, 0, 0, 0, 0x08, 0, 0]);
        let s = parse_dualsense(&usb).unwrap();
        assert!(s.rstick_x < -0.9, "RX=0 should be full right-stick left, got {}", s.rstick_x);
        assert!(s.rstick_y < -0.9, "RY=255 should be full down, got {}", s.rstick_y);
        assert!(s.stick_x.abs() < 0.05, "left stick must stay centered");
        assert!(s.stick_y.abs() < 0.05);

        let bt = report_bt31(0x10, &[128, 128, 0, 255, 0, 0, 0, 0x08, 0, 0]);
        let s = parse_dualsense(&bt).unwrap();
        assert!(s.rstick_x < -0.9, "BT RX=0 should be full right-stick left, got {}", s.rstick_x);
        assert!(s.rstick_y < -0.9, "BT RY=255 should be full down, got {}", s.rstick_y);
        assert!(s.stick_x.abs() < 0.05);
        assert!(s.stick_y.abs() < 0.05);

        // DS4 BT report 0x11: header at [1], sticks at [2..6] — RX=0/RY=255
        // at [4]/[5].
        let mut ds4bt = vec![0u8; 78];
        ds4bt[0] = 0x11;
        ds4bt[1] = 0x80;
        ds4bt[2] = 128;
        ds4bt[3] = 128;
        ds4bt[4] = 0;
        ds4bt[5] = 255;
        ds4bt[6] = 0x08;
        let s = parse_ds4(&ds4bt).unwrap();
        assert!(s.rstick_x < -0.9, "DS4 BT RX=0 should be full right-stick left, got {}", s.rstick_x);
        assert!(s.rstick_y < -0.9, "DS4 BT RY=255 should be full down, got {}", s.rstick_y);
        assert!(s.stick_x.abs() < 0.05);
        assert!(s.stick_y.abs() < 0.05);
    }

    #[test]
    fn ds4_usb_right_stick_offsets() {
        // DS4 USB: sticks at data[0..4] — RX=0 at data[2], RY=255 at data[3].
        let r = report(0x01, &[128, 128, 0, 255, 0x08, 0, 0]);
        let s = parse_ds4(&r).unwrap();
        assert!(s.rstick_x < -0.9);
        assert!(s.rstick_y < -0.9);
        assert!(s.stick_x.abs() < 0.05);
        assert!(s.stick_y.abs() < 0.05);
    }

    #[test]
    fn dualsense_bt31_layout() {
        // Full BT report with the +1 offsets: data[0..4]=sticks, data[7]=hat+face,
        // data[8]=shoulders+system, data[9]=PS/touch. LX=0 → full left;
        // LY=255 → full down; hat+face 0x42 = circle (0x40) + dpad nibble 2
        // (right); shoulders 0x06 = R1 + L2; PS/touch 0x02 = touchpad.
        let r = report_bt31(
            0x10,
            &[0, 255, 128, 128, 0, 0, 0, 0x42, 0x06, 0x02],
        );
        let s = parse_dualsense(&r).unwrap();
        assert!(s.stick_x < -0.9, "LX=0 should be full left, got {}", s.stick_x);
        assert!(s.stick_y < -0.9, "LY=255 should be full down, got {}", s.stick_y);
        assert!(s.rstick_x.abs() < 0.05, "right stick should stay centered");
        assert!(s.rstick_y.abs() < 0.05);
        assert_ne!(s.buttons & BIT_EAST, 0); // circle
        assert_ne!(s.buttons & BIT_DPAD_RIGHT, 0);
        assert_ne!(s.buttons & BIT_RIGHT_BUMPER, 0);
        assert_ne!(s.buttons & BIT_LEFT_TRIGGER, 0);
        assert_ne!(s.buttons & BIT_TOUCHPAD, 0);
        assert_eq!(s.buttons & BIT_SOUTH, 0);
        assert_eq!(s.buttons & BIT_GUIDE, 0);
    }

    #[test]
    fn dualsense_bt31_with_data_header() {
        // Windows Bluetooth HID can prepend the 0xA1 HIDP data header:
        // [0]=0xA1 [1]=0x31 [2]=counter [3..]=data. The decode must match the
        // headerless form exactly.
        let headerless = report_bt31(0x20, &[128, 128, 128, 128, 0, 0, 0, 0x28, 0x04, 0x01]);
        let mut with_header = vec![0xA1u8];
        with_header.extend_from_slice(&headerless);
        let a = parse_dualsense(&headerless).unwrap();
        let b = parse_dualsense(&with_header).unwrap();
        assert_eq!(a.buttons, b.buttons);
        assert_eq!(a.stick_x, b.stick_x);
        assert_eq!(a.stick_y, b.stick_y);
        // cross + dpad nibble 8 (none) + L2 + PS.
        assert_ne!(a.buttons & BIT_SOUTH, 0);
        assert_ne!(a.buttons & BIT_LEFT_TRIGGER, 0);
        assert_ne!(a.buttons & BIT_GUIDE, 0);
        assert_eq!(a.buttons & (BIT_DPAD_LEFT | BIT_DPAD_RIGHT | BIT_DPAD_UP | BIT_DPAD_DOWN), 0);
    }

    #[test]
    fn dualsense_stick_up_is_positive_y() {
        // USB: LY = 0 (top of range) → stick_y ≈ +1; LX = 255 → stick_x ≈ +1.
        let r = report(0x01, &[128, 0, 128, 128, 0, 0, 0, 0, 0, 0]);
        let s = parse_dualsense(&r).unwrap();
        assert!(s.stick_y > 0.9);
        let r2 = report(0x01, &[255, 128, 128, 128, 0, 0, 0, 0, 0, 0]);
        let s2 = parse_dualsense(&r2).unwrap();
        assert!(s2.stick_x > 0.9);
    }

    #[test]
    fn ds4_usb_dpad_rotation_decodes() {
        // D-pad up (nibble 0) + cross (0x20).
        let up = report(0x01, &[128, 128, 128, 128, 0x20, 0, 0]);
        let s = parse_ds4(&up).unwrap();
        assert_ne!(s.buttons & BIT_DPAD_UP, 0);
        assert_ne!(s.buttons & BIT_SOUTH, 0);
        // D-pad down (nibble 4).
        let down = report(0x01, &[128, 128, 128, 128, 0x04, 0, 0]);
        let s = parse_ds4(&down).unwrap();
        assert_ne!(s.buttons & BIT_DPAD_DOWN, 0);
        assert_eq!(s.buttons & BIT_DPAD_UP, 0);
        // D-pad up-left (nibble 7).
        let up_left = report(0x01, &[128, 128, 128, 128, 0x07, 0, 0]);
        let s = parse_ds4(&up_left).unwrap();
        assert_ne!(s.buttons & BIT_DPAD_UP, 0);
        assert_ne!(s.buttons & BIT_DPAD_LEFT, 0);
        // None (nibble 15).
        let none = report(0x01, &[128, 128, 128, 128, 0x0f, 0, 0]);
        let s = parse_ds4(&none).unwrap();
        assert_eq!(s.buttons & (BIT_DPAD_UP | BIT_DPAD_DOWN | BIT_DPAD_LEFT | BIT_DPAD_RIGHT), 0);
    }

    #[test]
    fn ds4_bt_11_has_header_byte() {
        // DS4 BT report 0x11 carries a header byte at [1]; the sticks start at
        // [2]. A resting report (header 0x80, sticks centered, hat neutral)
        // must decode as neutral, and LX=0 at [2] must read full left — not
        // the header byte at [1].
        let mut bt = vec![0u8; 78];
        bt[0] = 0x11;
        bt[1] = 0x80; // header
        bt[2] = 128;
        bt[3] = 128;
        bt[4] = 128;
        bt[5] = 128;
        bt[6] = 0x08; // dpad nibble 8 = none
        bt[7] = 0x00;
        bt[8] = 0x00;
        let s = parse_ds4(&bt).unwrap();
        assert!(s.stick_x.abs() < 0.05);
        assert!(s.stick_y.abs() < 0.05);
        assert_eq!(s.buttons & (BIT_DPAD_LEFT | BIT_DPAD_RIGHT | BIT_DPAD_UP | BIT_DPAD_DOWN), 0);

        bt[2] = 0; // LX = full left
        let s = parse_ds4(&bt).unwrap();
        assert!(s.stick_x < -0.9, "header byte leaked into stick_x: {}", s.stick_x);
    }

    #[test]
    fn ds4_shoulders_and_ps_button() {
        // USB DS4: L1(0x01) + R2(0x08) + options(0x20) in shoulders; PS(0x01) in PS/touch.
        let r = report(0x01, &[128, 128, 128, 128, 0x00, 0x29, 0x01]);
        let s = parse_ds4(&r).unwrap();
        assert_ne!(s.buttons & BIT_LEFT_BUMPER, 0);
        assert_ne!(s.buttons & BIT_RIGHT_TRIGGER, 0);
        assert_ne!(s.buttons & BIT_START, 0);
        assert_ne!(s.buttons & BIT_GUIDE, 0);
    }

    #[test]
    fn median_handles_odd_even_and_empty() {
        assert_eq!(median_u8(&[130, 124, 126, 124, 127]), 126.0); // odd → middle
        assert_eq!(median_u8(&[130, 124, 126, 124]), 125.0); // even → average of middles
        assert_eq!(median_u8(&[0x82, 0x7c, 0x82, 0x82]), 0x82 as f32); // resting DualSense LX
        assert_eq!(median_u8(&[]), 128.0); // fallback center
        // Robust to a few outliers (a couple of wiggles during calibration):
        // sorted [0, 124, 126, 128, 128, 129, 130, 255] → 128.
        let wiggly = [0, 255, 128, 130, 124, 126, 128, 129];
        assert_eq!(median_u8(&wiggly), 128.0);
    }

    #[test]
    fn short_reports_are_rejected() {
        assert!(parse_dualsense(&[0u8; 5]).is_none());
        assert!(parse_ds4(&[0u8; 9]).is_none());
    }

    #[test]
    fn unknown_report_ids_are_rejected() {
        assert!(parse_dualsense(&[0x42, 128, 128, 128, 128, 0, 0, 0, 0, 0, 0]).is_none());
        assert!(parse_ds4(&[0x42, 128, 128, 128, 128, 0, 0, 0]).is_none());
        // And the 0xA1-header form with a bad id.
        assert!(parse_dualsense(&[0xA1, 0x42, 128, 128, 128, 128, 0, 0, 0, 0, 0, 0]).is_none());
    }
}
