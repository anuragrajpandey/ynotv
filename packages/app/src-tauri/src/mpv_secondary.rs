//! Secondary MPV instances for multiview slots 2, 3, and 4.
//! Supports both in-process libmpv instances and standalone sidecar mpv.exe processes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use serde_json::{json, Value};

#[cfg(target_os = "windows")]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(target_os = "windows")]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(target_os = "windows")]
use tauri_plugin_shell::ShellExt;
#[cfg(target_os = "windows")]
use tokio::io::AsyncWriteExt;
#[cfg(target_os = "windows")]
use tokio::net::windows::named_pipe::ClientOptions;

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub(crate) enum SecondarySlot {
    #[cfg(target_os = "windows")]
    Sidecar {
        pid: u32,
        hwnd: isize,
        ipc_tx: Option<tokio::sync::mpsc::Sender<String>>,
    },
    LibMpv {
        mpv: Arc<libmpv2::Mpv>,
        #[cfg(target_os = "windows")]
        hwnd: isize,
    },
}

pub struct SecondaryMpvState {
    slots: Mutex<HashMap<u8, SecondarySlot>>,
}

impl SecondaryMpvState {
    pub fn new() -> Self {
        SecondaryMpvState {
            slots: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn slot_socket_path(slot_id: u8) -> String {
    format!(r"\\.\pipe\mpv-secondary-{}-{}", slot_id, std::process::id())
}

#[cfg(target_os = "windows")]
fn get_parent_hwnd<R: Runtime>(app: &AppHandle<R>) -> Result<isize, String> {
    let window = app.get_webview_window("main")
        .ok_or("Main window not found")?;
    let handle = window.window_handle().map_err(|e| e.to_string())?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Ok(h.hwnd.get() as isize),
        _ => Err("Unsupported window handle".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn set_hwnd_rect(hwnd_raw: isize, x: i32, y: i32, w: u32, h: u32, bring_to_front: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOZORDER, SWP_NOACTIVATE, HWND_TOP};
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};

    let hwnd = HWND(hwnd_raw as _);
    unsafe {
        if bring_to_front {
            SetWindowPos(hwnd, HWND_TOP, x, y, w as i32, h as i32, SWP_NOACTIVATE)
                .map_err(|e| format!("SetWindowPos failed: {}", e))?;
        } else {
            SetWindowPos(hwnd, None, x, y, w as i32, h as i32, SWP_NOZORDER | SWP_NOACTIVATE)
                .map_err(|e| format!("SetWindowPos failed: {}", e))?;
        }

        let rgn = CreateRoundRectRgn(0, 0, w as i32 + 1, h as i32 + 1, 12, 12);
        if !rgn.is_invalid() {
            let _ = SetWindowRgn(hwnd, rgn, true);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn send_ipc(tx: &tokio::sync::mpsc::Sender<String>, command: &str, args: Vec<Value>) {
    let mut cmd_args = vec![Value::String(command.to_string())];
    cmd_args.extend(args);
    let msg = json!({ "command": cmd_args }).to_string();
    let _ = tx.send(msg).await;
}

#[cfg(target_os = "windows")]
async fn connect_ipc(socket_path: &str) -> Result<tokio::sync::mpsc::Sender<String>, String> {
    let stream = {
        let mut retries = 15;
        loop {
            match ClientOptions::new().open(socket_path) {
                Ok(s) => break Ok(s),
                Err(_) if retries > 0 => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    retries -= 1;
                }
                Err(e) => break Err(format!("Secondary IPC connect failed: {}", e)),
            }
        }
    }?;

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(16);

    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = writer.write_all(msg.as_bytes()).await;
            let _ = writer.write_all(b"\n").await;
            let _ = writer.flush().await;
        }
    });

    Ok(tx)
}

// ─── Spawning Instances ──────────────────────────────────────────────────────

pub async fn spawn_slot_libmpv<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    kill_slot(app, slot_id).await;

    #[cfg(target_os = "windows")]
    let parent_hwnd_raw = get_parent_hwnd(app)?;

    let slot_name = format!("ynotv-slot-{}", slot_id);
    let target_title = format!("YNOTV_MPV_SLOT_{}", slot_id);

    let mpv = libmpv2::Mpv::with_initializer(|init| {
        let _ = init.set_property("audio-client-name", slot_name.as_str());
        let _ = init.set_property("terminal", "no");
        let _ = init.set_property("keep-open", "yes");
        let _ = init.set_property("idle", "yes");
        let _ = init.set_property("input-default-bindings", "no");
        let _ = init.set_property("input-media-keys", "no");
        let _ = init.set_property("no-osc", "yes");
        let _ = init.set_property("no-osd-bar", "yes");
        let _ = init.set_property("osd-level", 0i64);
        let _ = init.set_property("volume", 80f64);
        let _ = init.set_property("mute", true);

        #[cfg(target_os = "windows")]
        {
            let _ = init.set_property("hwdec", "auto");
            let _ = init.set_property("force-window", "immediate");
            let _ = init.set_property("gpu-api", "d3d11");
            let _ = init.set_property("vo", "gpu-next");
            let _ = init.set_property("title", target_title.as_str());
            let _ = init.set_property("wid", parent_hwnd_raw as i64);
        }
        Ok(())
    })
    .map_err(|e| format!("Failed to initialize libmpv secondary slot {}: {:?}", slot_id, e))?;

    let mpv_arc = Arc::new(mpv);

    #[cfg(target_os = "windows")]
    {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let hwnd_raw = crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd_raw, &target_title).unwrap_or(0);
        if hwnd_raw != 0 {
            let _ = set_hwnd_rect(hwnd_raw, x, y, width, height, true);
        }
        let state = app.state::<SecondaryMpvState>();
        let mut slots = state.slots.lock().unwrap();
        slots.insert(slot_id, SecondarySlot::LibMpv { mpv: mpv_arc, hwnd: hwnd_raw });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, width, height);
        let state = app.state::<SecondaryMpvState>();
        let mut slots = state.slots.lock().unwrap();
        slots.insert(slot_id, SecondarySlot::LibMpv { mpv: mpv_arc });
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn spawn_slot_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    kill_slot(app, slot_id).await;

    let parent_hwnd_raw = get_parent_hwnd(app)?;
    let socket_path = slot_socket_path(slot_id);

    let mut args = vec![
        format!("--input-ipc-server={}", socket_path),
        format!("--wid={}", parent_hwnd_raw),
        format!("--title=YNOTV_MPV_SLOT_{}", slot_id),
        "--force-window=immediate".into(),
        "--idle=yes".into(),
        "--keep-open=yes".into(),
        "--no-osc".into(),
        "--no-osd-bar".into(),
        "--osd-level=0".into(),
        "--input-default-bindings=no".into(),
        "--no-input-cursor".into(),
        "--cursor-autohide=no".into(),
        "--no-terminal".into(),
        "--volume=80".into(),
        "--mute=yes".into(),
    ];

    if let Ok(proxy) = std::env::var("ALL_PROXY") {
        args.push(format!("--http-proxy={}", proxy));
    }

    let sidecar = app.shell().sidecar("mpv")
        .map_err(|e| format!("Sidecar error: {}", e))?;

    let (mut rx, child) = sidecar.args(&args).spawn()
        .map_err(|e| format!("Failed to spawn secondary MPV: {}", e))?;

    let pid = child.pid();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    eprintln!("[MPV-{}] {}", slot_id, String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });

    tokio::time::sleep(Duration::from_millis(1200)).await;

    let target_title = format!("YNOTV_MPV_SLOT_{}", slot_id);
    let hwnd_raw = crate::mpv_windows::find_mpv_hwnd_by_pid(parent_hwnd_raw, pid)
        .or_else(|| crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd_raw, &target_title))
        .unwrap_or(0);
    if hwnd_raw != 0 {
        let _ = set_hwnd_rect(hwnd_raw, x, y, width, height, true);
    }
    let ipc_tx = connect_ipc(&socket_path).await.ok();
    let state = app.state::<SecondaryMpvState>();
    let mut slots = state.slots.lock().unwrap();
    slots.insert(slot_id, SecondarySlot::Sidecar { pid, hwnd: hwnd_raw, ipc_tx });

    Ok(())
}

// ─── Public API ──────────────────────────────────────────────────────────────

pub async fn kill_slot<R: Runtime>(app: &AppHandle<R>, slot_id: u8) {
    let state = app.state::<SecondaryMpvState>();
    let removed = {
        let mut slots = state.slots.lock().unwrap();
        slots.remove(&slot_id)
    };

    match removed {
        Some(SecondarySlot::LibMpv { mpv, .. }) => {
            let _ = mpv.command("quit", &[]);
        }
        #[cfg(target_os = "windows")]
        Some(SecondarySlot::Sidecar { pid, .. }) => {
            use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
            unsafe {
                if let Ok(ph) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(ph, 0);
                }
            }
        }
        _ => {}
    }
}

pub async fn kill_all<R: Runtime>(app: &AppHandle<R>) {
    kill_slot(app, 2).await;
    kill_slot(app, 3).await;
    kill_slot(app, 4).await;
}

pub async fn load_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let engine = crate::get_player_engine(app).await;

    #[cfg(target_os = "windows")]
    if engine == crate::PlayerEngine::Sidecar {
        let has_slot = {
            let state = app.state::<SecondaryMpvState>();
            let slots = state.slots.lock().unwrap();
            slots.contains_key(&slot_id)
        };

        if !has_slot {
            spawn_slot_sidecar(app, slot_id, x, y, width, height).await?;
        } else {
            reposition_slot(app, slot_id, x, y, width, height).await?;
        }

        let tx = {
            let state = app.state::<SecondaryMpvState>();
            let slots = state.slots.lock().unwrap();
            match slots.get(&slot_id) {
                Some(SecondarySlot::Sidecar { ipc_tx, .. }) => ipc_tx.clone(),
                _ => None,
            }
        };

        if let Some(tx) = tx {
            send_ipc(&tx, "loadfile", vec![json!(url)]).await;
        }
        return Ok(());
    }

    // LibMpv path
    let has_slot = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        slots.contains_key(&slot_id)
    };

    if !has_slot {
        spawn_slot_libmpv(app, slot_id, x, y, width, height).await?;
    } else {
        reposition_slot(app, slot_id, x, y, width, height).await?;
    }

    let mpv = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        match slots.get(&slot_id) {
            Some(SecondarySlot::LibMpv { mpv, .. }) => Some(mpv.clone()),
            _ => None,
        }
    };

    if let Some(mpv) = mpv {
        mpv.command("loadfile", &[&url])
            .map_err(|e| format!("Slot {} loadfile error: {:?}", slot_id, e))?;
    }
    Ok(())
}

pub async fn stop_slot<R: Runtime>(app: &AppHandle<R>, slot_id: u8) -> Result<(), String> {
    let state = app.state::<SecondaryMpvState>();
    let slot = {
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).cloned()
    };
    match slot {
        Some(SecondarySlot::LibMpv { mpv, .. }) => {
            let _ = mpv.command("stop", &[]);
        }
        #[cfg(target_os = "windows")]
        Some(SecondarySlot::Sidecar { ipc_tx: Some(ref tx), .. }) => {
            send_ipc(tx, "stop", vec![]).await;
        }
        _ => {}
    }
    Ok(())
}

pub async fn set_property_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    property: &str,
    value: Value,
) -> Result<(), String> {
    let state = app.state::<SecondaryMpvState>();
    let slot = {
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).cloned()
    };
    match slot {
        Some(SecondarySlot::LibMpv { mpv, .. }) => {
            match value {
                Value::Bool(b) => { let _ = mpv.set_property(property, b); },
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        let _ = mpv.set_property(property, i);
                    } else if let Some(f) = n.as_f64() {
                        let _ = mpv.set_property(property, f);
                    }
                },
                Value::String(s) => { let _ = mpv.set_property(property, s.as_str()); },
                _ => {},
            }
        }
        #[cfg(target_os = "windows")]
        Some(SecondarySlot::Sidecar { ipc_tx: Some(ref tx), .. }) => {
            send_ipc(tx, "set_property", vec![json!(property), value]).await;
        }
        _ => {}
    }
    Ok(())
}

pub async fn reposition_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let slot_entry = {
            let state = app.state::<SecondaryMpvState>();
            let slots = state.slots.lock().unwrap();
            match slots.get(&slot_id) {
                Some(SecondarySlot::LibMpv { hwnd, .. }) => Some(*hwnd),
                Some(SecondarySlot::Sidecar { hwnd, .. }) => Some(*hwnd),
                None => None,
            }
        };

        if let Some(mut hwnd) = slot_entry {
            if hwnd == 0 {
                if let Ok(parent_hwnd_raw) = get_parent_hwnd(app) {
                    let target_title = format!("YNOTV_MPV_SLOT_{}", slot_id);
                    let found_hwnd = {
                        let state = app.state::<SecondaryMpvState>();
                        let slots = state.slots.lock().unwrap();
                        match slots.get(&slot_id) {
                            Some(SecondarySlot::Sidecar { pid, .. }) => {
                                crate::mpv_windows::find_mpv_hwnd_by_pid(parent_hwnd_raw, *pid)
                                    .or_else(|| crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd_raw, &target_title))
                            }
                            _ => crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd_raw, &target_title),
                        }
                    };
                    if let Some(found) = found_hwnd {
                        hwnd = found;
                        let state = app.state::<SecondaryMpvState>();
                        let mut slots = state.slots.lock().unwrap();
                        if let Some(slot) = slots.get_mut(&slot_id) {
                            match slot {
                                SecondarySlot::LibMpv { hwnd: ref mut h, .. } => *h = found,
                                SecondarySlot::Sidecar { hwnd: ref mut h, .. } => *h = found,
                            }
                        }
                    }
                }
            }

            if hwnd != 0 {
                set_hwnd_rect(hwnd, x, y, width, height, true)?;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, slot_id, x, y, width, height);
    }
    Ok(())
}
