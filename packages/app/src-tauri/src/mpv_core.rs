//! Unified libmpv player core for ynotv
//! Supporting in-process playback on macOS (via AppKit OpenGL) and Windows (via HWND wid / D3D11)

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libmpv2::{Mpv, MpvInitializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MpvGeometry {
    pub css_left: f64,
    pub css_top: f64,
    pub css_width: f64,
    pub css_height: f64,
    pub css_view_w: f64,
    pub css_view_h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct NativeMpvRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn map_css_geometry(
    css: &MpvGeometry,
    native_width: f64,
    native_height: f64,
) -> NativeMpvRect {
    let full_surface = NativeMpvRect {
        x: 0.0,
        y: 0.0,
        width: native_width,
        height: native_height,
    };
    if !css.css_left.is_finite()
        || !css.css_top.is_finite()
        || !css.css_width.is_finite()
        || !css.css_height.is_finite()
        || !css.css_view_w.is_finite()
        || !css.css_view_h.is_finite()
        || css.css_width <= 0.0
        || css.css_height <= 0.0
        || css.css_view_w <= 0.0
        || css.css_view_h <= 0.0
    {
        return full_surface;
    }

    let scale_x = native_width / css.css_view_w;
    let scale_y = native_height / css.css_view_h;
    let mut x = css.css_left * scale_x;
    let mut y = css.css_top * scale_y;
    let mut width = css.css_width * scale_x;
    let mut height = css.css_height * scale_y;

    if css.css_left.abs() <= 2.0 {
        width += x;
        x = 0.0;
    }
    if css.css_top.abs() <= 2.0 {
        height += y;
        y = 0.0;
    }
    if css.css_left + css.css_width >= css.css_view_w - 2.0 {
        width = native_width - x;
    }
    if css.css_top + css.css_height >= css.css_view_h - 2.0 {
        height = native_height - y;
    }

    x = x.clamp(0.0, (native_width - 1.0).max(0.0));
    y = y.clamp(0.0, (native_height - 1.0).max(0.0));
    width = width.clamp(1.0, (native_width - x).max(1.0));
    height = height.clamp(1.0, (native_height - y).max(1.0));

    NativeMpvRect {
        x,
        y,
        width,
        height,
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct MpvStatus {
    pub playing: bool,
    pub volume: f64,
    pub muted: bool,
    pub position: f64,
    pub duration: f64,
    #[serde(rename = "pausedForCache")]
    pub paused_for_cache: bool,
    #[serde(rename = "coreIdle")]
    pub core_idle: bool,
    #[serde(rename = "videoFormat")]
    pub video_format: Option<String>,
    #[serde(rename = "videoTrackId")]
    pub video_track_id: Option<Value>,
}

pub struct MpvCoreState {
    pub mpv: Arc<Mutex<Option<Arc<Mpv>>>>,
    pub current_url: Mutex<Option<String>>,
    pub is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
}

impl MpvCoreState {
    pub fn new() -> Self {
        MpvCoreState {
            mpv: Arc::new(Mutex::new(None)),
            current_url: Mutex::new(None),
            is_shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

fn apply_common_options(
    init: &MpvInitializer,
    custom_params: &[String],
    embed_hwnd: Option<i64>,
) -> Result<(), String> {
    let set = |k: &str, v: &str| {
        let _ = init.set_property(k, v);
    };

    set("audio-client-name", "ynotv");
    set("terminal", "no");
    set("keep-open", "yes");
    set("idle", "yes");
    set("input-default-bindings", "no");
    set("input-media-keys", "no");
    set("input-cursor", "no");
    let _ = init.set_property("osc", "no");
    set("osd-level", "0");
    set("volume-max", "600");
    let _ = init.set_property("background-color", "#000000");

    // Pass HTTP proxy if configured in environment
    if let Ok(proxy) = std::env::var("ALL_PROXY") {
        set("http-proxy", &proxy);
    }

    #[cfg(target_os = "macos")]
    {
        set("hwdec", "videotoolbox-copy");
        set("force-window", "no");
        set("video-timing-offset", "0");
        set("vo", "libmpv");
    }

    #[cfg(windows)]
    {
        set("hwdec", "auto");
        set("force-window", "immediate");
        set("gpu-api", "d3d11");
        set("vo", "gpu-next");

        if let Some(hwnd) = embed_hwnd {
            init.set_property("wid", hwnd)
                .map_err(|e| format!("set wid={}: {}", hwnd, e))?;
        }
    }

    // Apply custom parameters passed from settings
    for param in custom_params {
        let trimmed = param.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let clean = trimmed.trim_start_matches('-');
        if let Some((k, v)) = clean.split_once('=') {
            let _ = init.set_property(k.trim(), v.trim());
        } else if let Some((k, v)) = clean.split_once(' ') {
            let _ = init.set_property(k.trim(), v.trim());
        } else {
            let _ = init.set_property(clean, "yes");
        }
    }

    Ok(())
}

pub async fn init_mpv_with_params<R: Runtime>(
    app: AppHandle<R>,
    custom_params: Vec<String>,
) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();

    // Stop and teardown any existing MPV session
    kill_mpv(&app).await;

    let mut embed_hwnd: Option<i64> = None;
    #[cfg(windows)]
    {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(hwnd) = window.hwnd() {
                embed_hwnd = Some(hwnd.0 as i64);
            }
        }
    }

    let custom_params_clone = custom_params.clone();
    let init_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let init_err_cap = init_err.clone();

    let mpv = Mpv::with_initializer(move |init| {
        if let Err(e) = apply_common_options(&init, &custom_params_clone, embed_hwnd) {
            log::error!("[ynotv::mpv_core] pre-init error: {}", e);
            if let Ok(mut g) = init_err_cap.lock() {
                *g = Some(e);
            }
            return Err(libmpv2::Error::Raw(-1));
        }
        Ok(())
    })
    .map_err(|e| {
        if let Ok(g) = init_err.lock() {
            g.clone().unwrap_or_else(|| format!("mpv init: {}", e))
        } else {
            format!("mpv init: {}", e)
        }
    })?;

    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window missing for render API install".to_string())?;
        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("ns_window: {:?}", e))? as i64;
        let mpv_ctx_addr: usize = mpv.ctx.as_ptr() as usize;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let _ = app.run_on_main_thread(move || {
            let res = match std::ptr::NonNull::new(mpv_ctx_addr as *mut libmpv2_sys::mpv_handle) {
                Some(p) => crate::mpv_render_mac::install(p, ns_window_ptr, false),
                None => Err("null mpv ctx".into()),
            };
            let _ = tx.send(res);
        });
        match rx.recv_timeout(Duration::from_millis(3000)) {
            Ok(Ok(())) => log::info!("[ynotv::mpv_core] macOS render installed OK"),
            Ok(Err(e)) => {
                log::error!("[ynotv::mpv_core] macOS render install failed: {}", e);
                return Err(format!("mac render install: {}", e));
            }
            Err(e) => {
                log::error!("[ynotv::mpv_core] macOS render install timeout: {:?}", e);
                return Err("mac render install timeout".into());
            }
        }
    }

    let mpv_arc = Arc::new(mpv);
    {
        let mut guard = state.mpv.lock().unwrap();
        *guard = Some(mpv_arc.clone());
    }

    // Start background status and event monitor
    spawn_status_monitor(app.clone(), mpv_arc, state.is_shutting_down.clone());

    let _ = app.emit("mpv-ready", true);

    log::info!("[ynotv::mpv_core] libmpv initialized successfully");
    Ok(())
}

fn spawn_status_monitor<R: Runtime>(
    app: AppHandle<R>,
    mpv: Arc<Mpv>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let mut last_eof_reached = false;

        while !shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(300)).await;

            let pause: bool = mpv.get_property("pause").unwrap_or(true);
            let volume: f64 = mpv.get_property("volume").unwrap_or(100.0);
            let mute: bool = mpv.get_property("mute").unwrap_or(false);
            let position: f64 = mpv.get_property("time-pos").unwrap_or(0.0);
            let duration: f64 = mpv.get_property("duration").unwrap_or(0.0);
            let paused_for_cache: bool = mpv.get_property("paused-for-cache").unwrap_or(false);
            let core_idle: bool = mpv.get_property("core-idle").unwrap_or(true);
            let eof_reached: bool = mpv.get_property("eof-reached").unwrap_or(false);
            let video_format: Option<String> = mpv.get_property("video-format").ok();

            if eof_reached && !last_eof_reached {
                let _ = app.emit("mpv-end-file", json!({
                    "reason": "eof",
                    "position": position,
                    "duration": duration,
                }));
            }
            last_eof_reached = eof_reached;

            let status = MpvStatus {
                playing: !pause,
                volume,
                muted: mute,
                position,
                duration,
                paused_for_cache,
                core_idle,
                video_format,
                video_track_id: None,
            };

            let _ = app.emit("mpv-status", status);
        }
    });
}

pub async fn load_file<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    let mpv = match mpv {
        Some(m) => m,
        None => {
            log::info!("[ynotv::mpv_core] MPV not initialized on load_file, auto-initializing...");
            init_mpv_with_params(app.clone(), Vec::new()).await?;
            let guard = state.mpv.lock().unwrap();
            guard.clone().ok_or("Failed to auto-initialize MPV")?
        }
    };

    mpv.command("loadfile", &[&url])
        .map_err(|e| format!("loadfile error: {:?}", e))?;

    let mut current = state.current_url.lock().unwrap();
    *current = Some(url);
    Ok(())
}

pub async fn play<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.set_property("pause", false)
            .map_err(|e| format!("set pause error: {:?}", e))?;
    }
    Ok(())
}

pub async fn pause<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.set_property("pause", true)
            .map_err(|e| format!("set pause error: {:?}", e))?;
    }
    Ok(())
}

pub async fn resume<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    play(app).await
}

pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("stop", &[])
            .map_err(|e| format!("stop error: {:?}", e))?;
    }
    Ok(())
}

pub async fn seek<R: Runtime>(app: &AppHandle<R>, seconds: f64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("seek", &[&seconds.to_string(), "absolute"])
            .map_err(|e| format!("seek error: {:?}", e))?;
    }
    Ok(())
}

pub async fn set_volume<R: Runtime>(app: &AppHandle<R>, volume: f64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.set_property("volume", volume)
            .map_err(|e| format!("set volume error: {:?}", e))?;
    }
    Ok(())
}

pub async fn toggle_mute<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("cycle", &["mute"])
            .map_err(|e| format!("toggle mute error: {:?}", e))?;
    }
    Ok(())
}

pub async fn cycle_audio<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("cycle", &["audio"])
            .map_err(|e| format!("cycle audio error: {:?}", e))?;
    }
    Ok(())
}

pub async fn cycle_sub<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("cycle", &["sub"])
            .map_err(|e| format!("cycle sub error: {:?}", e))?;
    }
    Ok(())
}

pub async fn get_track_list<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    let res = get_property(app, "track-list".to_string()).await?;
    if res.is_null() {
        Ok(json!([]))
    } else {
        Ok(res)
    }
}

pub async fn set_audio_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        if id == 0 {
            mpv.set_property("aid", "no")
        } else {
            mpv.set_property("aid", id)
        }
        .map_err(|e| format!("set aid error: {:?}", e))?;
    }
    Ok(())
}

pub async fn set_subtitle_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        if id == 0 {
            mpv.set_property("sid", "no")
        } else {
            mpv.set_property("sid", id)
        }
        .map_err(|e| format!("set sid error: {:?}", e))?;
    }
    Ok(())
}

pub async fn add_subtitle_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: String,
    flag: Option<String>,
) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        let f = flag.unwrap_or_else(|| "select".to_string());
        mpv.command("sub-add", &[&file_path, &f])
            .map_err(|e| format!("sub-add error: {:?}", e))?;
    }
    Ok(())
}

pub async fn remove_subtitle_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: String,
) -> Result<(), String> {
    let tracks = get_track_list(app).await?;
    if let Some(arr) = tracks.as_array() {
        for t in arr {
            if t.get("type").and_then(|v| v.as_str()) == Some("sub")
                && t.get("external").and_then(|v| v.as_bool()) == Some(true)
                && t.get("external-filename").and_then(|v| v.as_str()) == Some(&file_path)
            {
                if let Some(id) = t.get("id").and_then(|v| v.as_i64()) {
                    let state = app.state::<MpvCoreState>();
                    let mpv = {
                        let guard = state.mpv.lock().unwrap();
                        guard.clone()
                    };
                    if let Some(mpv) = mpv {
                        return mpv
                            .command("sub-remove", &[&id.to_string()])
                            .map_err(|e| format!("sub-remove error: {:?}", e));
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn set_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
    value: Value,
) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    let Some(mpv) = mpv else {
        return Ok(());
    };
    match value {
        Value::Bool(b) => mpv.set_property(&name, b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                mpv.set_property(&name, i)
            } else if let Some(f) = n.as_f64() {
                mpv.set_property(&name, f)
            } else {
                mpv.set_property(&name, n.to_string().as_str())
            }
        }
        Value::String(s) => mpv.set_property(&name, s.as_str()),
        _ => mpv.set_property(&name, value.to_string().as_str()),
    }
    .map_err(|e| format!("set_property {} error: {:?}", name, e))
}

pub async fn set_properties<R: Runtime>(
    app: &AppHandle<R>,
    properties: HashMap<String, Value>,
) -> Result<(), String> {
    for (k, v) in properties {
        set_property(app, k, v).await?;
    }
    Ok(())
}

pub async fn get_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
) -> Result<Value, String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    let Some(mpv) = mpv else {
        return Ok(Value::Null);
    };

    if let Ok(s) = mpv.get_property::<String>(&name) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
            return Ok(parsed);
        }
        return Ok(Value::String(s));
    }
    if let Ok(b) = mpv.get_property::<bool>(&name) {
        return Ok(Value::Bool(b));
    }
    if let Ok(f) = mpv.get_property::<f64>(&name) {
        return Ok(json!(f));
    }
    if let Ok(i) = mpv.get_property::<i64>(&name) {
        return Ok(json!(i));
    }

    Ok(Value::Null)
}

pub async fn toggle_stats<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        let _ = mpv.command("script-binding", &["stats/display-stats-toggle"]);
    }
    Ok(())
}

pub async fn sync_window<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = _app.get_webview_window("main") {
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let geom = MpvGeometry {
                css_left: 0.0,
                css_top: 0.0,
                css_width: size.width as f64,
                css_height: size.height as f64,
                css_view_w: size.width as f64,
                css_view_h: size.height as f64,
            };
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let _ = _app.run_on_main_thread(move || {
                let _ = tx.send(crate::mpv_render_mac::resize_to(geom));
            });
            let _ = rx.recv_timeout(Duration::from_millis(300));
        }
    }
    Ok(())
}

pub async fn set_geometry<R: Runtime>(
    _app: &AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = _app.get_webview_window("main") {
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let geom = MpvGeometry {
                css_left: x as f64,
                css_top: y as f64,
                css_width: width as f64,
                css_height: height as f64,
                css_view_w: size.width as f64,
                css_view_h: size.height as f64,
            };
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let _ = _app.run_on_main_thread(move || {
                let _ = tx.send(crate::mpv_render_mac::resize_to(geom));
            });
            let _ = rx.recv_timeout(Duration::from_millis(300));
        }
    }
    #[cfg(windows)]
    {
        let _ = (x, y, width, height);
    }
    Ok(())
}

pub async fn kill_mpv<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MpvCoreState>();
    state.is_shutting_down.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("mpv-ready", false);

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
        let _ = app.run_on_main_thread(move || {
            let _ = crate::mpv_render_mac::uninstall();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_millis(1000));
    }

    let prev = {
        let mut guard = state.mpv.lock().unwrap();
        guard.take()
    };

    if let Some(mpv) = prev {
        let _ = mpv.command("quit", &[]);
    }

    state.is_shutting_down.store(false, std::sync::atomic::Ordering::Relaxed);
}
