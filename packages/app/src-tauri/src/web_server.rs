use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};
use uuid::Uuid;

/// Close code sent when a remote client presents no (or an invalid) pairing
/// token. The served remote page shows a "pair with the app" message on this.
const WS_CLOSE_NOT_PAIRED: u16 = 4001;

pub const DEFAULT_REMOTE_PORT: u16 = 11470;

static RUNNING: AtomicBool = AtomicBool::new(false);
static ACTIVE_PORT: Mutex<u16> = Mutex::new(DEFAULT_REMOTE_PORT);
static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

/// Random pairing token embedded in the QR/link shown by the desktop app; the
/// remote page and WebSocket require it, so discovering the port alone is not
/// enough to control the app. Persisted in the app data dir so phones stay
/// paired across app launches instead of needing a fresh QR scan every run.
fn pairing_token(app: &AppHandle) -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| load_or_create_token(app))
}

fn token_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("remote_pairing_token.txt")
}

fn load_or_create_token(app: &AppHandle) -> String {
    let path = token_path(app);
    if let Ok(contents) = std::fs::read_to_string(&path) {
        let existing = contents.trim().to_string();
        if !existing.is_empty() {
            return existing;
        }
    }
    let token = Uuid::new_v4().simple().to_string();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, &token);
    token
}

#[derive(Clone)]
struct ServeState {
    app: AppHandle,
    outbound: broadcast::Sender<String>,
    clients: Arc<AsyncMutex<HashSet<u64>>>,
    /// Broadcast fired by `web_serve_stop` so active remote WebSocket handlers
    /// exit immediately. Without this, axum's graceful shutdown waits for open
    /// WebSocket connections (hyper's default 30s timeout), keeping the port
    /// bound — so a quick off→on toggle fails to re-bind with AddrInUse.
    conn_shutdown: broadcast::Sender<()>,
}

fn shutdown_slot() -> &'static Mutex<Option<oneshot::Sender<()>>> {
    static S: OnceLock<Mutex<Option<oneshot::Sender<()>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn serve_state_slot() -> &'static Mutex<Option<ServeState>> {
    static S: OnceLock<Mutex<Option<ServeState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Handles of every spawned axum server task. `web_serve_stop` aborts ALL of
/// them so the listener(s) are dropped and the port is released
/// *deterministically* — never dependent on hyper's graceful-shutdown drain
/// timing (which can wait on connections for up to its 30s default timeout).
///
/// A VEC, not an Option: if a duplicate task ever exists (e.g. a Windows
/// concurrent-bind race slips a second listener through), its handle must not
/// overwrite the first — the overwritten task would become an untracked
/// zombie whose listener survives every stop and holds the port forever.
fn server_task_slot() -> &'static Mutex<Vec<tokio::task::JoinHandle<()>>> {
    static S: OnceLock<Mutex<Vec<tokio::task::JoinHandle<()>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Vec::new()))
}

/// Monotonic id for each spawned server task, so logs can say which task
/// bound/exited and a stop can name the tasks it is tearing down.
static SPAWN_COUNT: AtomicU64 = AtomicU64::new(0);

/// Serializes `web_serve_start` so concurrent invocations can never both bind
/// the same port. At launch, THREE callers race: the lib.rs setup spawn plus
/// the Controllers tab mount effect (React StrictMode double-invokes it).
/// Windows has a race where two simultaneous bind() calls to the same
/// address:port can BOTH succeed (verified: 2/20 concurrent binds in a
/// repro). The losing-but-still-bound listener spawned a second server task
/// that was never tracked, so `web_serve_stop` could not kill it — it held
/// the port forever and every restart failed with AddrInUse.
fn start_lock() -> &'static AsyncMutex<()> {
    static L: OnceLock<AsyncMutex<()>> = OnceLock::new();
    L.get_or_init(|| AsyncMutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServeStatus {
    pub running: bool,
    pub port: u16,
    pub local_ip: String,
    pub remote_url: String,
    pub all_urls: Vec<String>,
    pub connected_clients: usize,
    /// Pairing token embedded in `remote_url`/`all_urls`. Required by the
    /// remote page and WebSocket; re-generated on every app launch.
    pub token: String,
}

pub fn get_local_lan_ip() -> String {
    // Try multiple routes to determine the active local LAN interface IP
    let probe_targets = ["8.8.8.8:80", "1.1.1.1:80", "192.168.1.1:80", "10.0.0.1:80", "172.16.0.1:80"];
    for target in probe_targets {
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect(target).is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    let ip = addr.ip().to_string();
                    if ip != "0.0.0.0" && ip != "127.0.0.1" {
                        return ip;
                    }
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

pub fn get_all_local_ips() -> Vec<String> {
    let mut ips = Vec::new();
    let primary = get_local_lan_ip();
    if primary != "127.0.0.1" {
        ips.push(primary);
    }
    ips.push("127.0.0.1".to_string());
    ips
}

#[tauri::command]
pub fn web_serve_status(app: AppHandle) -> WebServeStatus {
    let running = RUNNING.load(Ordering::Relaxed);
    let port = *ACTIVE_PORT.lock().unwrap_or_else(|e| e.into_inner());
    let token = pairing_token(&app);
    let ip = get_local_lan_ip();
    let remote_url = format!("http://{}:{}/remote?token={}", ip, port, token);
    let all_urls = get_all_local_ips()
        .into_iter()
        .map(|i| format!("http://{}:{}/remote?token={}", i, port, token))
        .collect();
    WebServeStatus {
        running,
        port,
        local_ip: ip,
        remote_url,
        all_urls,
        connected_clients: 0,
        token: token.to_string(),
    }
}

#[tauri::command]
pub async fn web_serve_start(app: AppHandle, port: Option<u16>) -> Result<WebServeStatus, String> {
    let target_port = port.unwrap_or(DEFAULT_REMOTE_PORT);

    // Serialize concurrent starts (launch race above). The second caller
    // waits here, then sees RUNNING=true and no-ops instead of binding.
    let _start_guard = start_lock().lock().await;

    let already = RUNNING.load(Ordering::SeqCst);
    let cur_port = *ACTIVE_PORT.lock().unwrap_or_else(|e| e.into_inner());
    info!(
        "[remote-server] start requested: port={} running={} active_port={}",
        target_port, already, cur_port
    );

    if already {
        if cur_port == target_port {
            return Ok(web_serve_status(app));
        }
        web_serve_stop();
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], target_port));
    // Retry briefly: a just-stopped server releases the port asynchronously
    // (graceful drain + the 2s stop grace window), so an immediate restart can
    // transiently hit AddrInUse. 30 × 100ms covers the full stop window.
    let listener = match bind_with_retry(addr, 30).await {
        Ok(l) => l,
        Err(e) => {
            // Is OUR tracked task still alive? That distinguishes "our own
            // task didn't die" from "another process holds the port".
            let tracked = server_task_slot().lock().unwrap_or_else(|e| e.into_inner());
            let alive_count = tracked.iter().filter(|h| !h.is_finished()).count();
            let spawned_total = SPAWN_COUNT.load(Ordering::SeqCst);
            let holder = if alive_count > 0 {
                "our own still-running server task(s)"
            } else {
                "another process or an untracked server task"
            };
            let msg_extra = format!(
                " (spawned_total={} tracked_alive={})",
                spawned_total, alive_count
            );
            let msg = format!(
                "Failed to bind port {}: {} (holder: {}){}",
                target_port, e, holder, msg_extra
            );
            warn!("[remote-server] {}", msg);
            return Err(msg);
        }
    };

    let (outbound_tx, _) = broadcast::channel::<String>(128);
    let (conn_shutdown_tx, _) = broadcast::channel::<()>(8);
    let clients = Arc::new(AsyncMutex::new(HashSet::new()));

    let state = ServeState {
        app: app.clone(),
        outbound: outbound_tx,
        clients,
        conn_shutdown: conn_shutdown_tx,
    };

    if let Ok(mut slot) = serve_state_slot().lock() {
        *slot = Some(state.clone());
    }

    let router = Router::new()
        .route("/", get(serve_remote_html))
        .route("/remote", get(serve_remote_html))
        .route("/api/remote", get(remote_ws_handler))
        .with_state(state);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    if let Ok(mut slot) = shutdown_slot().lock() {
        *slot = Some(shutdown_tx);
    }

    if let Ok(mut p) = ACTIVE_PORT.lock() {
        *p = target_port;
    }
    RUNNING.store(true, Ordering::SeqCst);

    let gen = SPAWN_COUNT.fetch_add(1, Ordering::SeqCst);
    info!("[remote-server] spawning server task #{} on {}", gen, addr);
    let handle = tokio::spawn(async move {
        info!("[remote-server] server task #{} listening on {}", gen, addr);
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        {
            error!("[remote-server] Server task #{} error: {}", gen, e);
        }
        RUNNING.store(false, Ordering::SeqCst);
        info!("[remote-server] server task #{} stopped", gen);
    });
    if let Ok(mut slot) = server_task_slot().lock() {
        slot.push(handle);
    }

    Ok(web_serve_status(app))
}

#[tauri::command]
pub fn web_serve_stop() {
    // 1. Close active remote WebSocket connections so clients see a clean
    //    disconnect instead of a hanging socket.
    if let Ok(slot) = serve_state_slot().lock() {
        if let Some(state) = slot.as_ref() {
            let _ = state.conn_shutdown.send(());
        }
    }
    // 2. Signal graceful shutdown — this is what actually closes the open
    //    connections (hyper drains them).
    if let Ok(mut slot) = shutdown_slot().lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
    }
    // 3. Give graceful shutdown a short window to drain, then force-abort
    //    EVERY tracked task as a safety net, then VERIFY the port is free.
    //    Aborting all handles (not just the latest) is what guarantees no
    //    duplicate task can survive a stop as an untracked zombie.
    if let Ok(mut slot) = server_task_slot().lock() {
        let handles: Vec<_> = slot.drain(..).collect();
        let port = *ACTIVE_PORT.lock().unwrap_or_else(|e| e.into_inner());
        if handles.is_empty() {
            info!("[remote-server] stop: no server tasks tracked");
        } else {
            info!("[remote-server] stop: draining {} tracked server task(s)", handles.len());
        }
        tauri::async_runtime::spawn(async move {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(2000);
            for handle in &handles {
                while !handle.is_finished() && tokio::time::Instant::now() < deadline {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            }
            let survivors: Vec<_> = handles.iter().filter(|h| !h.is_finished()).collect();
            if !survivors.is_empty() {
                warn!(
                    "[remote-server] graceful shutdown did not finish in 2s ({} task(s) alive); aborting",
                    survivors.len()
                );
                for handle in survivors {
                    handle.abort();
                }
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
            // Verify the port actually released — this catches untracked
            // tasks or foreign processes holding the port. Uses the same
            // SO_REUSEADDR bind as the real listener so TIME_WAIT from the
            // just-closed connections does not produce a false positive.
            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            match bind_reuseaddr(addr).await {
                Ok(_probe) => {
                    info!("[remote-server] stop verified: port {} is free", port);
                }
                Err(e) => {
                    warn!(
                        "[remote-server] stop VERIFY FAILED: port {} still held after shutdown: {}. An untracked server task or another process is holding it.",
                        port, e
                    );
                }
            }
        });
    }
    if let Ok(mut slot) = serve_state_slot().lock() {
        *slot = None;
    }
    RUNNING.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn remote_ws_broadcast(payload: String) -> Result<(), String> {
    if let Ok(slot) = serve_state_slot().lock() {
        if let Some(state) = slot.as_ref() {
            let _ = state.outbound.send(payload);
            return Ok(());
        }
    }
    Ok(())
}

async fn remote_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<ServeState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let presented = params.get("token").map(|s| s.as_str()).unwrap_or("");
    let authorized = !presented.is_empty() && presented == pairing_token(&state.app);
    ws.on_upgrade(move |socket| handle_remote_socket(socket, state, authorized))
}

async fn handle_remote_socket(socket: WebSocket, state: ServeState, authorized: bool) {
    if !authorized {
        // Reject unpaired clients with a distinct close code so the remote
        // page can surface "pair from the app" instead of reconnecting.
        let (mut sender, _receiver) = socket.split();
        let _ = sender
            .send(Message::Close(Some(CloseFrame {
                code: WS_CLOSE_NOT_PAIRED,
                reason: "not paired".into(),
            })))
            .await;
        return;
    }

    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    {
        let mut set = state.clients.lock().await;
        set.insert(client_id);
    }
    let _ = state.app.emit("remote://client", serde_json::json!({
        "event": "connected",
        "clientId": client_id,
    }));

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.outbound.subscribe();
    let mut shutdown_rx = state.conn_shutdown.subscribe();

    let write_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    let app_handle = state.app.clone();
    let read_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                    let _ = app_handle.emit("remote://cmd", json);
                }
            }
        }
    });

    tokio::select! {
        _ = write_task => {},
        _ = read_task => {},
        // Server is stopping — exit so the WebSocket drops and graceful
        // shutdown can finish releasing the port.
        _ = shutdown_rx.recv() => {},
    }

    {
        let mut set = state.clients.lock().await;
        set.remove(&client_id);
    }
    let _ = state.app.emit("remote://client", serde_json::json!({
        "event": "disconnected",
        "clientId": client_id,
    }));
}

/// Bind a listener with SO_REUSEADDR set. On Windows this is REQUIRED to
/// re-bind a port whose previous listener's connections are still draining in
/// TIME_WAIT (2×MSL, minutes) — without it, every toggle-off→on fails with
/// WSAEADDRINUSE even though no listener exists anymore. Rust/tokio's default
/// `TcpListener::bind` does not set it on Windows. tokio's TcpSocket also
/// serializes the bind via start_lock, so the permissive Windows SO_REUSEADDR
/// (which allows duplicate binds) cannot bite.
async fn bind_reuseaddr(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let socket = if addr.is_ipv4() {
        tokio::net::TcpSocket::new_v4()?
    } else {
        tokio::net::TcpSocket::new_v6()?
    };
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    socket.listen(128)
}

async fn bind_with_retry(addr: SocketAddr, max_attempts: u32) -> std::io::Result<TcpListener> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..max_attempts {
        match bind_reuseaddr(addr).await {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                if attempt == 0 || attempt == max_attempts - 1 {
                    warn!("[remote-server] bind {} failed (attempt {}): {}", addr, attempt + 1, e);
                }
                last_err = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::AddrInUse, "bind failed")
    }))
}

async fn serve_remote_html() -> impl IntoResponse {
    let html = r###"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#07090e">
  <title>YNOTV Remote & Companion</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    :root {
      --bg-deep: #07090e;
      --bg-surface: rgba(18, 22, 34, 0.72);
      --bg-surface-elevated: rgba(26, 32, 48, 0.75);
      --bg-card: rgba(255, 255, 255, 0.04);
      --bg-card-hover: rgba(255, 255, 255, 0.07);
      --border-glass: rgba(255, 255, 255, 0.08);
      --border-glass-bright: rgba(255, 255, 255, 0.16);
      --glass-filter: blur(22px) saturate(180%);
      --glass-filter-modal: blur(28px) saturate(190%);
      --glass-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 -1px 0 rgba(255, 255, 255, 0.02), 0 8px 32px rgba(0, 0, 0, 0.4);
      --glass-card-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 4px 18px rgba(0, 0, 0, 0.25);
      
      --accent-cyan: #38bdf8;
      --accent-cyan-bright: #00d4ff;
      --accent-purple: #818cf8;
      --accent-violet: #a855f7;
      --accent-gradient: linear-gradient(135deg, #38bdf8 0%, #818cf8 55%, #a855f7 100%);
      --accent-gradient-subtle: linear-gradient(135deg, rgba(56, 189, 248, 0.15) 0%, rgba(129, 140, 248, 0.15) 100%);
      --accent-glow: 0 0 16px rgba(56, 189, 248, 0.35);
      --accent-glow-subtle: 0 0 10px rgba(56, 189, 248, 0.2);
      
      --text-primary: #f8fafc;
      --text-secondary: #cbd5e1;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      
      --live-red: #ef4444;
      --live-red-glow: 0 0 10px rgba(239, 68, 68, 0.6);
      --live-green: #10b981;
      --live-green-glow: 0 0 10px rgba(16, 185, 129, 0.6);
    }
    
    html, body {
      background: var(--bg-deep);
      background-image: 
        radial-gradient(ellipse 90% 60% at 50% -10%, rgba(99, 102, 241, 0.18), transparent 70%),
        radial-gradient(ellipse 70% 50% at 90% 90%, rgba(56, 189, 248, 0.12), transparent 70%),
        radial-gradient(ellipse 60% 40% at 10% 80%, rgba(168, 85, 247, 0.08), transparent 70%);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', Helvetica, Arial, sans-serif;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      touch-action: manipulation;
      overscroll-behavior: none;
    }

    button, input, select, a, .dpad, .dpad-btn, .dpad-center, .action-btn, .media-btn, .header-menu-btn, .dest-card, .nav-tab-btn, .tree-item, .folder-item, .channel-card, .team-link-pill, .mv-layout-btn {
      touch-action: manipulation;
      font-family: inherit;
    }
    .dpad, .dpad-btn, .dpad-center {
      touch-action: none !important;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 999px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--accent-cyan);
    }

    /* ── SKINS & THEMES ── */
    body[data-skin="oled"] {
      --bg-deep: #000000;
      --bg-surface: rgba(14, 14, 14, 0.95);
      --bg-surface-elevated: rgba(22, 22, 22, 0.95);
      --bg-card: rgba(255, 255, 255, 0.05);
      --border-glass: rgba(255, 255, 255, 0.16);
      --border-glass-bright: rgba(255, 255, 255, 0.3);
      --glass-filter: none;
      --glass-filter-modal: none;
      --glass-shadow: 0 4px 16px rgba(0, 0, 0, 0.8);
      --accent-cyan: #00e5ff;
      --accent-cyan-bright: #33ecff;
      --accent-gradient: linear-gradient(135deg, #00e5ff 0%, #ffffff 100%);
      background: #000000;
      background-image: none;
    }
    body[data-skin="cyberpunk"] {
      --bg-deep: #09030e;
      --bg-surface: rgba(22, 10, 32, 0.85);
      --bg-surface-elevated: rgba(36, 14, 52, 0.9);
      --bg-card: rgba(255, 0, 127, 0.06);
      --border-glass: rgba(255, 0, 127, 0.25);
      --border-glass-bright: rgba(0, 240, 255, 0.4);
      --accent-cyan: #00f0ff;
      --accent-cyan-bright: #33f3ff;
      --accent-purple: #ff007f;
      --accent-violet: #d946ef;
      --accent-gradient: linear-gradient(135deg, #ff007f 0%, #a855f7 50%, #00f0ff 100%);
      --accent-glow: 0 0 18px rgba(255, 0, 127, 0.45);
      background: #09030e;
      background-image: radial-gradient(ellipse 80% 50% at 50% 0%, rgba(255, 0, 127, 0.22), transparent 70%),
                        radial-gradient(ellipse 70% 50% at 100% 100%, rgba(0, 240, 255, 0.18), transparent 70%);
    }
    body[data-skin="midnight"] {
      --bg-deep: #050b16;
      --bg-surface: rgba(10, 20, 40, 0.82);
      --bg-surface-elevated: rgba(16, 32, 64, 0.88);
      --border-glass: rgba(56, 189, 248, 0.16);
      --accent-cyan: #38bdf8;
      --accent-gradient: linear-gradient(135deg, #38bdf8 0%, #2563eb 100%);
      background: #050b16;
      background-image: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(37, 99, 235, 0.22), transparent 70%);
    }
    body[data-skin="sunset"] {
      --bg-deep: #14050d;
      --bg-surface: rgba(35, 12, 24, 0.82);
      --bg-surface-elevated: rgba(52, 16, 34, 0.88);
      --border-glass: rgba(249, 115, 22, 0.18);
      --accent-cyan: #f97316;
      --accent-gradient: linear-gradient(135deg, #f97316 0%, #e11d48 55%, #9333ea 100%);
      background: #14050d;
      background-image: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(249, 115, 22, 0.2), transparent 70%),
                        radial-gradient(ellipse 60% 50% at 90% 90%, rgba(225, 29, 72, 0.18), transparent 70%);
    }
    body[data-skin="forest"] {
      --bg-deep: #041009;
      --bg-surface: rgba(8, 28, 18, 0.82);
      --bg-surface-elevated: rgba(12, 44, 28, 0.88);
      --border-glass: rgba(16, 185, 129, 0.18);
      --accent-cyan: #10b981;
      --accent-gradient: linear-gradient(135deg, #10b981 0%, #059669 50%, #34d399 100%);
      background: #041009;
      background-image: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(16, 185, 129, 0.2), transparent 70%);
    }
    body[data-skin="crimson"] {
      --bg-deep: #100305;
      --bg-surface: rgba(30, 8, 12, 0.82);
      --bg-surface-elevated: rgba(48, 12, 18, 0.88);
      --border-glass: rgba(239, 68, 68, 0.2);
      --accent-cyan: #ef4444;
      --accent-gradient: linear-gradient(135deg, #ef4444 0%, #b91c1c 55%, #f43f5e 100%);
      background: #100305;
      background-image: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(239, 68, 68, 0.2), transparent 70%);
    }
    body[data-skin="retro"] {
      --bg-deep: #18191f;
      --bg-surface: #22242b;
      --bg-surface-elevated: #2a2c35;
      --bg-card: rgba(255, 255, 255, 0.05);
      --border-glass: #333642;
      --border-glass-bright: #474a5a;
      --accent-cyan: #f59e0b;
      --accent-gradient: linear-gradient(135deg, #f59e0b 0%, #ef4444 50%, #3b82f6 100%);
      --glass-filter: none;
      --glass-filter-modal: none;
      background: #18191f;
      background-image: none;
    }

    /* Size scaling */
    body[data-size="compact"] .dpad-wrapper { transform: scale(0.88); margin-bottom: -12px; }
    body[data-size="compact"] .middle-cluster { transform: scale(0.9); }
    body[data-size="large"] .dpad-wrapper { transform: scale(1.08); margin-top: 6px; }
    body[data-size="large"] .middle-cluster { transform: scale(1.06); }

    /* Quick Action Grid */
    .remote-qa-grid {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 7px;
      width: 100%;
      max-width: 330px;
      margin: 10px auto 0;
      padding: 0 8px;
    }
    .remote-qa-btn {
      padding: 7px 11px;
      border-radius: 10px;
      background: var(--bg-card);
      border: 1px solid var(--border-glass-bright);
      color: var(--text-primary);
      font-size: 11px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      box-shadow: var(--glass-card-shadow);
      transition: all 0.15s ease;
      touch-action: manipulation;
    }
    .remote-qa-btn:active {
      transform: scale(0.92);
      background: var(--accent-cyan);
      color: #04101c;
    }

    /* Middle Center Stack Sizing */
    body[data-center-size="compact"] .cluster-center-stack .center-action-btn {
      height: 38px;
      font-size: 11px;
      border-radius: 12px;
      padding: 0 8px;
    }
    body[data-center-size="compact"] .cluster-center-stack .center-action-btn svg {
      width: 14px;
      height: 14px;
    }
    body[data-center-size="normal"] .cluster-center-stack .center-action-btn {
      height: 52px;
      font-size: 13px;
      border-radius: 16px;
    }
    body[data-center-size="normal"] .cluster-center-stack .center-action-btn svg {
      width: 17px;
      height: 17px;
    }
    body[data-center-size="large"] .cluster-center-stack .center-action-btn {
      height: 68px;
      font-size: 14.5px;
      border-radius: 18px;
    }
    body[data-center-size="large"] .cluster-center-stack .center-action-btn svg {
      width: 20px;
      height: 20px;
    }
    body[data-center-size="expanded"] .cluster-center-stack .center-action-btn {
      height: 86px;
      font-size: 16px;
      border-radius: 20px;
    }
    body[data-center-size="expanded"] .cluster-center-stack .center-action-btn svg {
      width: 23px;
      height: 23px;
    }

    /* On-phone Settings Header Button & Modal */
    .header-settings-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 50%;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
      margin-left: 6px;
    }
    .header-settings-btn:active {
      transform: scale(0.92);
      color: var(--accent-cyan);
    }
    .header-settings-btn svg {
      width: 15px;
      height: 15px;
    }
    .phone-skin-picker-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .phone-skin-option {
      padding: 10px 8px;
      border-radius: 10px;
      border: 1px solid var(--border-glass);
      background: var(--bg-card);
      color: var(--text-primary);
      font-size: 11px;
      font-weight: 700;
      text-align: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .phone-skin-option.active {
      border-color: var(--accent-cyan);
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent-cyan);
      box-shadow: var(--accent-glow-subtle);
    }

    /* Header */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: calc(env(safe-area-inset-top, 0px) + 10px) 16px 10px;
      background: rgba(11, 14, 23, 0.8);
      backdrop-filter: var(--glass-filter);
      -webkit-backdrop-filter: var(--glass-filter);
      border-bottom: 1px solid var(--border-glass);
      flex-shrink: 0;
      z-index: 30;
    }
    .logo-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .logo-icon-svg {
      width: 22px;
      height: 22px;
      color: var(--accent-cyan);
      filter: drop-shadow(0 0 6px rgba(56, 189, 248, 0.4));
    }
    .logo {
      font-size: 17px;
      font-weight: 800;
      letter-spacing: -0.4px;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .logo-badge {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--accent-cyan);
    }
    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .status-dot { 
      width: 7px; 
      height: 7px; 
      border-radius: 50%; 
      background: var(--live-red); 
      box-shadow: var(--live-red-glow);
    }
    .status-badge.connected .status-dot { 
      background: var(--live-green); 
      box-shadow: var(--live-green-glow); 
      animation: pulseGreen 2.2s infinite;
    }
    .status-badge.connected { 
      color: #6ee7b7; 
      background: rgba(16, 185, 129, 0.12); 
      border-color: rgba(16, 185, 129, 0.25); 
    }
    @keyframes pulseGreen {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.8; }
    }

    /* Floating Now Playing Mini Capsule */
    .now-playing-banner {
      background: rgba(22, 27, 44, 0.65);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 14px;
      margin: 8px 12px 4px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      animation: slideDownFade 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes slideDownFade {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .np-logo {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      object-fit: contain;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }
    .np-logo-fallback {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.2);
      color: var(--accent-cyan);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 11px;
      flex-shrink: 0;
    }
    .np-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .np-channel {
      font-size: 12.5px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .np-title {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .np-progress-bar {
      width: 100%;
      height: 3px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
      margin-top: 3px;
    }
    .np-progress-fill {
      height: 100%;
      background: var(--accent-gradient);
      width: 0%;
      transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .np-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .np-btn {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass-bright);
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .np-btn svg { width: 14px; height: 14px; }
    .np-btn:active { 
      background: var(--accent-cyan); 
      color: #04101c; 
      transform: scale(0.92);
      box-shadow: var(--accent-glow);
    }

    /* Tab Container */
    .tab-content-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    .tab-pane {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      overflow: hidden;
    }
    .tab-pane.active { display: flex; }

    /* Bottom Navigation Dock */
    nav.bottom-nav {
      height: calc(58px + env(safe-area-inset-bottom, 0px));
      background: rgba(11, 14, 23, 0.85);
      backdrop-filter: var(--glass-filter);
      -webkit-backdrop-filter: var(--glass-filter);
      border-top: 1px solid var(--border-glass);
      display: flex;
      align-items: flex-start;
      justify-content: space-around;
      flex-shrink: 0;
      z-index: 30;
      padding-top: 4px;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .nav-tab-btn {
      flex: 1;
      height: 50px;
      background: transparent;
      border: none;
      color: var(--text-dim);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }
    .nav-tab-btn .nav-icon-svg { 
      width: 20px; 
      height: 20px; 
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .nav-tab-btn .nav-label { 
      font-size: 10px; 
      font-weight: 700; 
      letter-spacing: 0.3px; 
      transition: color 0.2s;
    }
    .nav-tab-btn:active { transform: scale(0.92); }
    .nav-tab-btn.active { color: var(--accent-cyan); }
    .nav-tab-btn.active .nav-icon-svg { 
      transform: translateY(-2px); 
      filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.5));
    }
    /* Desktop-view indicator dot */
    .nav-tab-btn.view-active::after {
      content: '';
      position: absolute;
      top: 4px;
      right: calc(50% - 16px);
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent-cyan);
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.9);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .header-menu-btn {
      height: 29px;
      padding: 0 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass-bright);
      border-radius: 999px;
      color: #e2e8f0;
      font-size: 11.5px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .header-menu-btn svg { width: 13px; height: 13px; color: var(--accent-cyan); }
    .header-menu-btn:active {
      background: rgba(56, 189, 248, 0.2);
      border-color: var(--accent-cyan);
      transform: scale(0.94);
    }

    /* ================= SECTIONS SHEET / APP LAUNCHER MODAL ================= */
    .sections-overlay {
      position: fixed;
      inset: 0;
      z-index: 90;
      background: rgba(4, 7, 14, 0.72);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: none;
      align-items: flex-end;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .sections-overlay.open {
      display: flex;
      opacity: 1;
    }
    .sections-sheet {
      width: 100%;
      max-width: 480px;
      max-height: 85vh;
      background: rgba(15, 19, 32, 0.96);
      backdrop-filter: var(--glass-filter-modal);
      -webkit-backdrop-filter: var(--glass-filter-modal);
      border: 1px solid var(--border-glass-bright);
      border-bottom: none;
      border-radius: 24px 24px 0 0;
      padding: 14px 16px calc(24px + env(safe-area-inset-bottom, 0px));
      box-shadow: 0 -10px 40px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.15);
      display: flex;
      flex-direction: column;
      gap: 14px;
      transform: translateY(100%);
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      overflow-y: auto;
    }
    .sections-overlay.open .sections-sheet {
      transform: translateY(0);
    }
    .sheet-handle {
      width: 36px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.22);
      margin: 0 auto -2px;
      cursor: pointer;
    }
    .sheet-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 2px 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .sheet-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sheet-title-wrap svg {
      width: 17px;
      height: 17px;
      color: var(--accent-cyan);
    }
    .sheet-title {
      font-size: 15px;
      font-weight: 800;
      color: #fff;
      letter-spacing: 0.3px;
    }
    .sheet-close-btn {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .sheet-close-btn svg { width: 13px; height: 13px; }
    .sheet-close-btn:active {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
      transform: scale(0.92);
    }

    /* 2-Column Grid of Destinations */
    .destinations-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .dest-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 14px;
      padding: 11px 12px;
      display: flex;
      align-items: center;
      gap: 11px;
      cursor: pointer;
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      overflow: hidden;
    }
    .dest-card:active {
      background: rgba(56, 189, 248, 0.15);
      border-color: var(--accent-cyan);
      transform: scale(0.96);
    }
    .dest-card.active {
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.4);
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.2);
    }
    .dest-card.active::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3.5px;
      background: var(--accent-cyan);
    }
    .dest-icon-box {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .dest-icon-box svg {
      width: 19px;
      height: 19px;
    }
    .dest-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .dest-name {
      font-size: 12.5px;
      font-weight: 700;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dest-sub {
      font-size: 10px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dest-card.active .dest-name {
      color: var(--accent-cyan);
    }

    .pad-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      gap: 12px;
    }
    
    /* D-Pad Section with 4 Corner Satellite Controls */
    .dpad-wrapper {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      max-width: 320px;
      margin: 4px 0;
    }
    .dpad-corner-btn {
      position: absolute;
      width: 44px;
      height: 44px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-secondary);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
      z-index: 5;
    }
    .dpad-corner-btn svg {
      width: 17px;
      height: 17px;
    }
    .dpad-corner-btn .corner-btn-sub {
      font-size: 9px;
      font-weight: 700;
      color: var(--text-dim);
      letter-spacing: 0.2px;
      line-height: 1;
    }
    .dpad-corner-btn:active {
      background: rgba(56, 189, 248, 0.22);
      border-color: var(--accent-cyan);
      color: #fff;
      transform: scale(0.92);
    }
    .dpad-corner-btn:active .corner-btn-sub {
      color: var(--accent-cyan);
    }
    .dpad-corner-top-left {
      top: 2px;
      left: 6px;
    }
    .dpad-corner-top-right {
      top: 2px;
      right: 6px;
    }
    .dpad-corner-bottom-left {
      bottom: 2px;
      left: 6px;
    }
    .dpad-corner-bottom-right {
      bottom: 2px;
      right: 6px;
    }

    /* Futuristic Extra-Large D-Pad Dial */
    .dpad {
      width: 236px;
      height: 236px;
      max-width: 76vw;
      max-height: 76vw;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 50%, #1a2032 0%, #0e121e 100%);
      border: 2px solid rgba(255, 255, 255, 0.12);
      position: relative;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), inset 0 2px 6px rgba(255, 255, 255, 0.15);
      flex-shrink: 0;
    }
    .dpad-btn {
      position: absolute;
      background: transparent;
      border: none;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.12s ease;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    }
    .dpad-btn svg {
      width: 26px;
      height: 26px;
      transition: transform 0.12s ease;
    }
    .dpad-btn:active { 
      color: var(--accent-cyan); 
      background: radial-gradient(circle, rgba(56, 189, 248, 0.28) 0%, transparent 80%);
    }
    .dpad-btn:active svg { transform: scale(1.15); filter: drop-shadow(0 0 10px rgba(56, 189, 248, 0.9)); }
    .dpad-up { top: 0; left: 68px; width: 100px; height: 68px; border-radius: 118px 118px 0 0; }
    .dpad-down { bottom: 0; left: 68px; width: 100px; height: 68px; border-radius: 0 0 118px 118px; }
    .dpad-left { left: 0; top: 68px; width: 68px; height: 100px; border-radius: 118px 0 0 118px; }
    .dpad-right { right: 0; top: 68px; width: 68px; height: 100px; border-radius: 0 118px 118px 0; }
    
    .dpad-center {
      position: absolute;
      top: 68px; left: 68px;
      width: 100px; height: 100px;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 30%, #2a3652 0%, #151b2c 100%);
      border: 2px solid rgba(255, 255, 255, 0.18);
      color: #fff;
      font-weight: 800;
      font-size: 17px;
      letter-spacing: 0.6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45), inset 0 1px 3px rgba(255, 255, 255, 0.3);
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    }
    .dpad-center:active { 
      background: var(--accent-gradient); 
      color: #04101c; 
      border-color: #7dd3fc;
      box-shadow: 0 0 24px rgba(56, 189, 248, 0.7);
      transform: scale(0.94);
    }

    /* Middle 3-Column Cluster (Volume, [Back & Play/Pause], Channel) */
    .middle-cluster {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      max-width: 320px;
      gap: 12px;
      min-height: 136px;
    }
    .cluster-pillar {
      width: 52px;
      height: 136px;
      background: radial-gradient(circle at 50% 30%, #1a2032 0%, #0e121e 100%);
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5), inset 0 2px 4px rgba(255, 255, 255, 0.12);
      padding: 3px;
      box-sizing: border-box;
      flex-shrink: 0;
    }
    .cluster-center-stack {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 10px;
      min-width: 0;
    }
    .center-action-btn {
      width: 100%;
      flex: none;
      height: 52px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 16px;
      color: var(--text-primary);
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      cursor: pointer;
      box-shadow: var(--glass-card-shadow);
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    }
    .center-action-btn svg { width: 17px; height: 17px; }
    .center-action-btn.back-btn:active {
      background: rgba(239, 68, 68, 0.2);
      border-color: var(--live-red);
      color: #fff;
      transform: scale(0.95);
    }
    .center-action-btn.play-btn {
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.15) 0%, rgba(37, 99, 235, 0.1) 100%);
      border-color: rgba(56, 189, 248, 0.35);
      color: #f8fafc;
    }
    .center-action-btn.play-btn svg {
      color: var(--accent-cyan);
    }
    .center-action-btn.play-btn:active {
      background: var(--accent-cyan);
      color: #04101c;
      border-color: #7dd3fc;
      transform: scale(0.95);
    }
    .center-action-btn.play-btn:active svg {
      color: #04101c;
    }

    .rocker-btn {
      width: 100%;
      flex: 1;
      background: transparent;
      border: none;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 18px;
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
      -webkit-user-select: none;
    }
    .rocker-btn svg {
      width: 20px;
      height: 20px;
      transition: transform 0.12s ease;
    }
    .rocker-btn:active {
      color: var(--accent-cyan);
      background: radial-gradient(circle, rgba(56, 189, 248, 0.25) 0%, transparent 80%);
      transform: scale(0.92);
    }
    .rocker-btn:active svg {
      transform: scale(1.18);
      filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.8));
    }
    .rocker-btn-mute {
      flex: 0 0 38px;
      height: 38px;
      border-radius: 50%;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .rocker-btn-mute.active {
      color: #ef4444;
    }
    .rocker-btn-mute:active {
      color: #ef4444;
      background: radial-gradient(circle, rgba(239, 68, 68, 0.3) 0%, transparent 80%);
    }
    .rocker-label {
      flex: 0 0 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 800;
      color: var(--text-dim);
      letter-spacing: 0.8px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      width: 100%;
      pointer-events: none;
      user-select: none;
    }


    .remote-search {
      display: flex;
      width: 100%;
      max-width: 320px;
      gap: 8px;
    }
    .remote-search-input-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .remote-search-input {
      width: 100%;
      height: 36px;
      min-width: 0;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      color: var(--text-primary);
      padding: 0 36px 0 10px;
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .remote-search-input:focus {
      border-color: var(--accent-cyan);
    }
    .remote-search-status {
      position: absolute;
      right: 34px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--accent-cyan);
      font-size: 13px;
      font-weight: 700;
      pointer-events: none;
      display: none;
      animation: remoteSearchPulse 1s ease-in-out infinite;
    }
    @keyframes remoteSearchPulse {
      0%, 100% { opacity: 0.25; }
      50% { opacity: 1; }
    }
    .remote-search-clear {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      width: 24px;
      height: 24px;
      display: none;
      align-items: center;
      justify-content: center;
      border: none;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-secondary);
      border-radius: 50%;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .remote-search-clear:active {
      background: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    /* Type-into-field modal (search box activated from the remote) */
    .remote-type-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      align-items: center;
      justify-content: center;
      z-index: 500;
      padding: 20px;
    }
    .remote-type-box {
      width: 100%;
      max-width: 360px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-glass);
      border-radius: 16px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: var(--glass-shadow);
    }
    .remote-type-label {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .remote-type-input {
      height: 44px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      color: var(--text-primary);
      padding: 0 12px;
      font-size: 16px;
      outline: none;
    }
    .remote-type-input:focus {
      border-color: var(--accent-cyan);
    }
    .remote-type-actions {
      display: flex;
      gap: 8px;
    }
    .remote-type-btn {
      flex: 1;
      height: 42px;
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.12s ease;
    }
    .remote-type-ok {
      background: var(--accent-cyan);
      color: #04101c;
      border-color: transparent;
    }
    .remote-type-cancel:active,
    .remote-type-ok:active {
      transform: scale(0.96);
    }
    .remote-search-go {
      width: 40px;
      height: 36px;
      flex-shrink: 0;
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      color: var(--accent-cyan);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .remote-search-go svg { width: 15px; height: 15px; }
    .remote-search-go:active {
      background: rgba(56, 189, 248, 0.25);
      transform: scale(0.94);
    }

    /* ================= TAB 2: LIVE GUIDE 2-PANE ================= */
    .guide-header-controls {
      padding: 8px 12px;
      background: rgba(11, 14, 23, 0.7);
      backdrop-filter: var(--glass-filter);
      -webkit-backdrop-filter: var(--glass-filter);
      border-bottom: 1px solid var(--border-glass);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .sidebar-toggle-btn {
      height: 38px;
      padding: 0 11px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      color: #cbd5e1;
      font-size: 12px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .sidebar-toggle-btn svg { width: 15px; height: 15px; }
    .sidebar-toggle-btn:active { 
      background: var(--accent-cyan); 
      color: #04101c; 
      transform: scale(0.95);
    }
    .search-input-box {
      position: relative;
      flex: 1;
    }
    .search-icon-svg {
      position: absolute;
      left: 10px;
      top: 11px;
      width: 15px;
      height: 15px;
      color: var(--text-dim);
      pointer-events: none;
    }
    .search-input {
      width: 100%;
      height: 38px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      padding: 0 32px 0 32px;
      color: #f8fafc;
      font-size: 13px;
      outline: none;
      transition: all 0.2s ease;
    }
    .search-input:focus { 
      border-color: var(--accent-cyan); 
      background: rgba(255, 255, 255, 0.07);
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.18);
    }
    .search-clear-btn {
      position: absolute;
      right: 8px;
      top: 8px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #94a3b8;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    .guide-split-body {
      flex: 1;
      display: flex;
      overflow: hidden;
      width: 100%;
    }

    /* Left Sidebar */
    .guide-sidebar {
      width: 150px;
      flex-shrink: 0;
      background: rgba(9, 11, 18, 0.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-right: 1px solid var(--border-glass);
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      display: flex;
      flex-direction: column;
      transition: width 0.2s, margin-left 0.2s;
    }
    .guide-sidebar.collapsed {
      margin-left: -150px;
    }
    .sidebar-tree {
      padding: 6px 6px 20px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .tree-header {
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #64748b;
      padding: 8px 6px 2px;
      margin-top: 4px;
    }
    .tree-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 8px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
      cursor: pointer;
      line-height: 1.2;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .tree-item:active { background: rgba(255, 255, 255, 0.08); color: #fff; }
    .tree-item.active {
      background: rgba(56, 189, 248, 0.14);
      color: var(--accent-cyan);
      font-weight: 700;
      border-left: 3px solid var(--accent-cyan);
    }
    .tree-item-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .tree-badge {
      font-size: 9.5px;
      color: #64748b;
      font-weight: 600;
      flex-shrink: 0;
      background: rgba(255, 255, 255, 0.04);
      padding: 1px 5px;
      border-radius: 999px;
    }
    .tree-source-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 7px 6px;
      border-radius: 7px;
      font-size: 11.5px;
      font-weight: 700;
      color: #cbd5e1;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.04);
      margin-top: 4px;
    }
    .tree-source-row:active { background: rgba(255, 255, 255, 0.08); }
    .tree-folder-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 6px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #94a3b8;
      cursor: pointer;
      margin-left: 4px;
    }
    .tree-folder-row:active { background: rgba(255, 255, 255, 0.06); color: #fff; }
    .tree-chevron {
      font-size: 8px;
      width: 10px;
      display: inline-block;
      transition: transform 0.15s;
    }
    .tree-chevron.open { transform: rotate(90deg); }
    .tree-folder-contents {
      padding-left: 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* Right Main Channel List */
    .guide-channel-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      background: transparent;
    }
    .guide-cat-banner {
      padding: 9px 14px;
      background: rgba(14, 18, 28, 0.6);
      border-bottom: 1px solid var(--border-glass);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    /* Failover playback toggle (synced from the desktop app). Compact bar so
       tuning from the phone follows the same Always Play Primary setting. */
    .failover-guide-bar {
      display: none;
      align-items: center;
      padding: 6px 14px;
      background: rgba(14, 18, 28, 0.4);
      border-bottom: 1px solid var(--border-glass);
      flex-shrink: 0;
      gap: 8px;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
    }
    .failover-guide-bar input {
      accent-color: var(--accent-cyan);
      width: 15px;
      height: 15px;
      cursor: pointer;
    }
    .failover-guide-bar label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .guide-cat-title {
      font-size: 13px;
      font-weight: 800;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .guide-pick-indicator {
      font-size: 10px;
      font-weight: 800;
      color: #04101c;
      background: var(--accent-cyan);
      border-radius: 999px;
      padding: 2px 8px;
      margin-left: 8px;
      flex-shrink: 0;
      white-space: nowrap;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
    }
    .guide-cat-count {
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      margin-left: 8px;
      flex-shrink: 0;
    }
    .guide-channel-list {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .guide-card {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid var(--border-glass);
      border-radius: 14px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      box-shadow: var(--glass-card-shadow);
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }
    /* Now-viewing highlight: the channel the user is watching (or the keep-view
       anchor when failover redirects tuning to a group primary). */
    .guide-card.is-view {
      border-color: rgba(56, 189, 248, 0.7);
      background: rgba(56, 189, 248, 0.14);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.25);
    }
    .guide-card.is-view .guide-card-ch-name {
      color: #7dd3fc;
    }
    .guide-card:active {
      background: rgba(56, 189, 248, 0.12);
      border-color: var(--accent-cyan);
      transform: scale(0.985);
    }
    .guide-logo {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      object-fit: contain;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }
    .guide-logo-fallback {
      width: 44px;
      height: 44px;
      border-radius: 10px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.2);
      color: var(--accent-cyan);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 13px;
      flex-shrink: 0;
    }
    .guide-card-content {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .guide-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .guide-card-ch-name {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .guide-card-prog-title {
      font-size: 13.5px;
      font-weight: 700;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .guide-prog-time {
      font-size: 11px;
      color: #64748b;
      margin-top: 1px;
    }
    .guide-card-next {
      font-size: 11px;
      color: #64748b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 1px;
    }

    /* ================= TAB 3: LIVE SPORTS ================= */
    .sports-container {
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
    }
    .sports-card {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid var(--border-glass);
      border-radius: 16px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: var(--glass-card-shadow);
    }
    .sports-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sports-league-tag {
      font-size: 10.5px;
      font-weight: 800;
      color: var(--accent-cyan);
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.25);
      padding: 2px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .sports-clock-badge {
      font-size: 11.5px;
      font-weight: 700;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .sports-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--live-red);
      box-shadow: var(--live-red-glow);
      animation: pulseRed 1.8s infinite;
    }
    @keyframes pulseRed {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.7; }
    }
    .sports-team-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .sports-team-left {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }
    .sports-team-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      width: 100%;
    }
    .sports-team-logo {
      width: 30px;
      height: 30px;
      border-radius: 7px;
      object-fit: contain;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.08);
      flex-shrink: 0;
    }
    .sports-team-fallback {
      width: 30px;
      height: 30px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
      font-weight: 700;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .sports-team-name {
      font-size: 14.5px;
      font-weight: 700;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sports-team-score {
      font-size: 20px;
      font-weight: 800;
      color: #f8fafc;
      font-variant-numeric: tabular-nums;
    }
    .sports-team-link-pill {
      font-size: 11px;
      font-weight: 700;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--accent-cyan);
      padding: 4px 10px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .sports-team-link-pill:active { 
      background: var(--accent-cyan); 
      color: #04101c; 
      transform: scale(0.95);
    }

    .sports-streams-accordion {
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sports-streams-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      padding: 4px 0;
    }
    .sports-streams-toggle:active { color: var(--accent-cyan); }
    .sports-streams-toggle .chev {
      font-size: 9px;
      color: #64748b;
      transition: transform 0.15s;
    }
    .sports-streams-toggle.open .chev { transform: rotate(90deg); }
    .sports-streams-title {
      font-size: 11px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .sports-team-links {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      max-width: 100%;
    }
    .sports-link-dropdown {
      font-size: 11px;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: #94a3b8;
      padding: 4px 8px;
      border-radius: 8px;
      max-width: 120px;
      cursor: pointer;
      outline: none;
    }
    .sports-stream-item {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .sports-stream-name {
      font-size: 12.5px;
      font-weight: 600;
      color: #cbd5e1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sports-stream-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .sports-stream-btn {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 7px;
      background: linear-gradient(135deg, #2563eb, #3b82f6);
      color: #fff;
      border: none;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .sports-stream-btn:active { 
      transform: scale(0.94); 
      background: #1d4ed8; 
    }

    /* ================= TAB 4: MULTIVIEW ================= */
    .mv-container {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
    }
    .mv-layout-row {
      display: flex;
      gap: 8px;
    }
    .mv-layout-btn {
      flex: 1;
      height: 42px;
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      color: #cbd5e1;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: var(--glass-card-shadow);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .mv-layout-btn:active { transform: scale(0.95); }
    .mv-layout-btn.active {
      background: var(--accent-gradient);
      color: #04101c;
      border-color: transparent;
      box-shadow: 0 0 14px rgba(56, 189, 248, 0.35);
    }
    .mv-grid-preview {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .mv-slot-card {
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid var(--border-glass);
      border-radius: 14px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 94px;
      min-width: 0;
      cursor: pointer;
      box-shadow: var(--glass-card-shadow);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .mv-slot-card:active { transform: scale(0.98); }
    .mv-slot-card.picking {
      border-color: var(--accent-cyan);
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.4), 0 0 16px rgba(56, 189, 248, 0.25);
      animation: pulsePick 1.6s infinite;
    }
    @keyframes pulsePick {
      0%, 100% { border-color: var(--accent-cyan); }
      50% { border-color: var(--accent-purple); }
    }
    .mv-slot-card.mv-main-card { 
      cursor: default; 
      border-color: rgba(16, 185, 129, 0.25);
      background: rgba(16, 185, 129, 0.05);
    }
    .mv-pick-pill {
      font-size: 10px;
      font-weight: 800;
      color: #04101c;
      background: var(--accent-cyan);
      border-radius: 999px;
      padding: 2px 8px;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.6);
    }
    .mv-pick-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(22, 35, 58, 0.85);
      backdrop-filter: var(--glass-filter);
      -webkit-backdrop-filter: var(--glass-filter);
      border-bottom: 1px solid rgba(56, 189, 248, 0.3);
      padding: 10px 14px;
      font-size: 12.5px;
      font-weight: 600;
      color: #dbeafe;
      flex-shrink: 0;
      z-index: 25;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .mv-pick-cancel {
      flex-shrink: 0;
      font-size: 11.5px;
      font-weight: 700;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 8px;
      padding: 5px 12px;
      cursor: pointer;
    }
    .mv-pick-cancel:active { background: #e11d48; color: #fff; }
    .mv-slot-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .mv-slot-num {
      font-size: 11px;
      font-weight: 800;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .mv-slot-channel {
      font-size: 13px;
      font-weight: 700;
      color: #f8fafc;
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.3;
    }
    .mv-audio-pill {
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    /* Toast */
    .toast {
      position: fixed;
      top: 66px;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(56, 189, 248, 0.4);
      color: #f8fafc;
      font-size: 12.5px;
      font-weight: 600;
      padding: 8px 18px;
      border-radius: 999px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 100;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5), 0 0 16px rgba(56, 189, 248, 0.2);
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* Pairing Screen */
    .app-root[hidden], .pair-screen[hidden] { display: none !important; }
    .pair-screen {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg-deep);
      background-image: radial-gradient(circle at 50% 30%, rgba(99, 102, 241, 0.2), transparent 70%);
    }
    .pair-card {
      max-width: 400px;
      width: 100%;
      background: rgba(18, 22, 34, 0.85);
      backdrop-filter: var(--glass-filter-modal);
      -webkit-backdrop-filter: var(--glass-filter-modal);
      border: 1px solid var(--border-glass-bright);
      border-radius: 24px;
      padding: 32px 24px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.15);
    }
    .pair-icon { 
      width: 48px;
      height: 48px;
      margin: 0 auto 16px;
      color: var(--accent-cyan);
      filter: drop-shadow(0 0 12px rgba(56, 189, 248, 0.5));
    }
    .pair-title { 
      font-size: 22px; 
      font-weight: 800; 
      margin-bottom: 8px; 
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .pair-desc { font-size: 13.5px; line-height: 1.5; color: var(--text-muted); margin-bottom: 20px; }
    .pair-steps {
      text-align: left;
      margin: 0 auto 22px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .pair-step-item {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .pair-step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--accent-gradient);
      color: #04101c;
      font-weight: 800;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .pair-retry {
      display: block;
      width: 100%;
      height: 46px;
      background: var(--accent-gradient);
      border: none;
      border-radius: 12px;
      color: #04101c;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.3px;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(56, 189, 248, 0.4);
      transition: all 0.15s ease;
    }
    .pair-retry:active { transform: scale(0.97); opacity: 0.9; }
  </style>
</head>
<body>
  <div id="app-root" style="display:flex; flex-direction:column; height:100dvh; overflow:hidden;">
    <header>
      <div class="logo-container">
        <svg class="logo-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="7" width="20" height="15" rx="3"></rect>
          <polyline points="17 2 12 7 7 2"></polyline>
        </svg>
        <span class="logo">YNOTV</span>
        <span class="logo-badge">Remote</span>
      </div>
      <div class="header-right" style="display:flex; align-items:center; gap:6px;">
        <div id="status" class="status-badge">
          <span class="status-dot"></span>
          <span id="status-text">Connecting...</span>
        </div>
        <button class="header-settings-btn" onclick="openPhoneSettingsModal()" title="Remote Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </div>
    </header>

    <!-- Now Playing Floating Capsule -->
    <div id="now-playing-banner" class="now-playing-banner" style="display:none;">
      <div id="np-logo-box"></div>
      <div class="np-info">
        <span id="np-channel" class="np-channel"></span>
        <span id="np-title" class="np-title"></span>
        <div class="np-progress-bar">
          <div id="np-progress-fill" class="np-progress-fill"></div>
        </div>
      </div>
      <div class="np-controls">
        <button class="np-btn" onpointerdown="sendAction('play_pause', event)" title="Play / Pause">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </button>
        <button class="np-btn" onpointerdown="sendAction('toggle_mute', event)" title="Mute">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <line x1="23" y1="9" x2="17" y2="15"></line>
            <line x1="17" y1="9" x2="23" y2="15"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- Tab Container -->
    <div class="tab-content-container">
      <!-- 1. REMOTE TAB -->
      <div id="tab-remote" class="tab-pane active" style="overflow-y:auto;">
        <div class="pad-container">
          <!-- D-Pad Dial with 4 Corner Satellite Controls -->
          <div class="dpad-wrapper">
            <!-- Top-Left Corner Button -->
            <button id="corner-top-left" class="dpad-corner-btn dpad-corner-top-left" onpointerdown="onCornerBtnClick('topLeft', event)" title="App Destinations" aria-label="Open">
              <span id="corner-icon-top-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
              </span>
              <span id="corner-label-top-left" class="corner-btn-sub">Open</span>
            </button>

            <!-- Top-Right Corner Button -->
            <button id="corner-top-right" class="dpad-corner-btn dpad-corner-top-right" onpointerdown="onCornerBtnClick('topRight', event)" title="Toggle Fullscreen" aria-label="Fullscreen">
              <span id="corner-icon-top-right">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <polyline points="9 21 3 21 3 15"></polyline>
                  <line x1="21" y1="3" x2="14" y2="10"></line>
                  <line x1="3" y1="21" x2="10" y2="14"></line>
                </svg>
              </span>
              <span id="corner-label-top-right" class="corner-btn-sub">Screen</span>
            </button>

            <!-- Bottom-Left Corner Button -->
            <button id="corner-bottom-left" class="dpad-corner-btn dpad-corner-bottom-left" onpointerdown="onCornerBtnClick('bottomLeft', event)" title="Rewind 10s" aria-label="Rewind 10s">
              <span id="corner-icon-bottom-left">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 19 2 12 11 5 11 19"></polygon>
                  <polygon points="22 19 13 12 22 5 22 19"></polygon>
                </svg>
              </span>
              <span id="corner-label-bottom-left" class="corner-btn-sub">10s</span>
            </button>

            <!-- Bottom-Right Corner Button -->
            <button id="corner-bottom-right" class="dpad-corner-btn dpad-corner-bottom-right" onpointerdown="onCornerBtnClick('bottomRight', event)" title="Forward 10s" aria-label="Forward 10s">
              <span id="corner-icon-bottom-right">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="13 19 22 12 13 5 13 19"></polygon>
                  <polygon points="2 19 11 12 2 5 2 19"></polygon>
                </svg>
              </span>
              <span id="corner-label-bottom-right" class="corner-btn-sub">10s</span>
            </button>

            <!-- Center Large D-Pad -->
            <div class="dpad">
              <button class="dpad-btn dpad-up" onpointerdown="startNavRepeat('up', event)" onpointerup="stopNavRepeat()" onpointerleave="stopNavRepeat()" onpointercancel="stopNavRepeat()" oncontextmenu="return false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </button>
              <button class="dpad-btn dpad-down" onpointerdown="startNavRepeat('down', event)" onpointerup="stopNavRepeat()" onpointerleave="stopNavRepeat()" onpointercancel="stopNavRepeat()" oncontextmenu="return false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
              <button class="dpad-btn dpad-left" onpointerdown="startNavRepeat('left', event)" onpointerup="stopNavRepeat()" onpointerleave="stopNavRepeat()" onpointercancel="stopNavRepeat()" oncontextmenu="return false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
              <button class="dpad-btn dpad-right" onpointerdown="startNavRepeat('right', event)" onpointerup="stopNavRepeat()" onpointerleave="stopNavRepeat()" onpointercancel="stopNavRepeat()" oncontextmenu="return false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              </button>
              <button class="dpad-center" onpointerdown="sendNav('select', event)">OK</button>
            </div>
          </div>

          <!-- Middle Cluster (Vol Rocker, [Back & Play/Pause], Channel Rocker) -->
          <div id="middle-cluster" class="middle-cluster">
            <!-- Left Pillar: Volume Up, Mute, Volume Down -->
            <div id="vol-pillar" class="cluster-pillar">
              <button class="rocker-btn" onpointerdown="sendVolumeStep(5, event)" title="Volume Up" aria-label="Volume Up">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
              <button class="rocker-btn rocker-btn-mute" id="mute-btn" onpointerdown="sendAction('toggle_mute', event)" title="Mute" aria-label="Mute">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <line x1="23" y1="9" x2="17" y2="15"></line>
                  <line x1="17" y1="9" x2="23" y2="15"></line>
                </svg>
              </button>
              <button class="rocker-btn" onpointerdown="sendVolumeStep(-5, event)" title="Volume Down" aria-label="Volume Down">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </button>
            </div>

            <!-- Middle Column: Dynamic Top and Bottom Action Buttons Stack -->
            <div id="center-stack" class="cluster-center-stack">
              <button id="center-btn-top" class="center-action-btn back-btn" onpointerdown="onCenterBtnClick('top', event)" title="Back">
                <span id="center-icon-top">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 14 4 9 9 4"></polyline>
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
                  </svg>
                </span>
                <span id="center-label-top">Back</span>
              </button>
              <button id="center-btn-bottom" class="center-action-btn play-btn" onpointerdown="onCenterBtnClick('bottom', event)" title="Play / Pause">
                <span id="center-icon-bottom">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                </span>
                <span id="center-label-bottom">Play / Pause</span>
              </button>
            </div>

            <!-- Right Pillar: Channel Up, CH Label, Channel Down -->
            <div id="ch-pillar" class="cluster-pillar">
              <button class="rocker-btn" onpointerdown="sendAction('next_channel', event)" title="Channel Up" aria-label="Channel Up">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </button>
              <div class="rocker-label">CH</div>
              <button class="rocker-btn" onpointerdown="sendAction('prev_channel', event)" title="Channel Down" aria-label="Channel Down">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            </div>
          </div>

          <!-- Quick Actions Grid Container -->
          <div id="remote-quick-actions" class="remote-qa-grid"></div>

          <!-- Remote Search (types with the phone's own keyboard) -->
          <div id="remote-search-wrap" class="remote-search">
            <div class="remote-search-input-wrap">
              <input
                type="text"
                id="remote-search-input"
                class="remote-search-input"
                placeholder="Search channels / EPG…"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                inputmode="search"
                oninput="onRemoteSearchInput()"
                onkeydown="if(event.key==='Enter'){ event.preventDefault(); submitRemoteSearch(); }"
              />
              <span class="remote-search-status" id="remote-search-status" title="Searching…">…</span>
              <button
                class="remote-search-clear"
                id="remote-search-clear"
                onpointerdown="clearRemoteSearch(event)"
                title="Clear search"
              >✕</button>
            </div>
            <button
              class="remote-search-go"
              onpointerdown="submitRemoteSearch(event)"
              title="Search"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 2. LIVE GUIDE TAB (2-PANE SIDEBAR TREE) -->
      <div id="tab-guide" class="tab-pane">
        <div class="guide-header-controls">
          <button id="sidebar-toggle" class="sidebar-toggle-btn" onclick="toggleSidebar()">
            <svg id="sidebar-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
            Categories
          </button>
          <div class="search-input-box">
            <svg class="search-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" id="guide-search" class="search-input" placeholder="Search channels..." oninput="onSearchInput(this.value)">
            <button id="guide-search-clear" class="search-clear-btn" style="display:none;" onclick="clearSearch()">✕</button>
          </div>
        </div>

        <div class="guide-split-body">
          <!-- Left Sidebar -->
          <aside id="guide-sidebar" class="guide-sidebar">
            <div id="guide-sidebar-tree" class="sidebar-tree">
              <div style="text-align:center; padding:20px; color:#64748b; font-size:11px;">Loading categories...</div>
            </div>
          </aside>

          <!-- Right Channel List -->
          <main class="guide-channel-main">
            <div class="guide-cat-banner">
              <div style="display:flex; align-items:center; min-width:0;">
                <span id="guide-cat-title" class="guide-cat-title">⭐ Favorites</span>
                <span id="guide-pick-indicator" class="guide-pick-indicator" style="display:none;"></span>
              </div>
              <span id="guide-cat-count" class="guide-cat-count"></span>
            </div>
            <!-- Failover playback toggle: synced with the desktop setting so
                 tuning from the phone behaves the same as tuning on the app. -->
            <div id="failover-guide-bar" class="failover-guide-bar">
              <label>
                <input type="checkbox" id="failover-primary-toggle" onchange="onFailoverPrimaryToggle(this.checked)" />
                <span>Always Play Primary</span>
              </label>
              <label style="margin-left:6px; padding-left:10px; border-left:1px solid var(--border-glass);">
                <input type="checkbox" id="failover-keepview-toggle" onchange="onFailoverKeepViewToggle(this.checked)" />
                <span>Keep View on Selected Channel</span>
              </label>
            </div>
            <div id="guide-list" class="guide-channel-list">
              <div style="text-align:center; padding:30px; color:#64748b;">Loading channels...</div>
            </div>
          </main>
        </div>
      </div>

      <!-- 3. LIVE SPORTS TAB -->
      <div id="tab-sports" class="tab-pane" style="overflow-y:auto;">
        <div style="padding:12px 14px 4px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:13px; font-weight:800; color:#f1f5f9; letter-spacing:0.2px;">Live & Upcoming Games</span>
          <button class="header-menu-btn" onclick="requestSports()" style="height:28px; padding:0 10px;">
            <svg style="width:12px; height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
            </svg>
            Refresh
          </button>
        </div>
        <div id="sports-list" class="sports-container">
          <div style="text-align:center; padding:30px; color:#64748b;">Loading live scores...</div>
        </div>
      </div>

      <!-- 4. MULTIVIEW TAB -->
      <div id="tab-multiview" class="tab-pane" style="overflow-y:auto;">
        <div class="mv-container">
          <span style="font-size:13px; font-weight:800; color:#f1f5f9; letter-spacing:0.2px;">Multiview Engine</span>
          <div class="mv-layout-row">
            <button class="mv-layout-btn mv-engine-btn" data-engine="hls" onclick="setMultiviewEngine('hls')">HLS</button>
            <button class="mv-layout-btn mv-engine-btn" data-engine="mpv_canvas" onclick="setMultiviewEngine('mpv_canvas')">MPV</button>
          </div>
          <span style="font-size:13px; font-weight:800; color:#f1f5f9; letter-spacing:0.2px; margin-top:8px;">Multiview Layout</span>
          <div class="mv-layout-row">
            <button class="mv-layout-btn" data-layout="single" onclick="switchLayout('single')">Single</button>
            <button class="mv-layout-btn" data-layout="split" onclick="switchLayout('split')">Split</button>
            <button class="mv-layout-btn" data-layout="quad" onclick="switchLayout('quad')">2x2 Quad</button>
            <button class="mv-layout-btn" data-layout="triple" onclick="switchLayout('triple')">3-Up</button>
          </div>
          <span style="font-size:13px; font-weight:800; color:#f1f5f9; letter-spacing:0.2px; margin-top:8px;">Screen Slots</span>
          <div id="mv-grid" class="mv-grid-preview"></div>
        </div>
      </div>

      <!-- 5. DESTINATIONS DIRECT TAB -->
      <div id="tab-destinations" class="tab-pane" style="overflow-y:auto;">
        <div style="padding:14px;">
          <span style="font-size:13px; font-weight:800; color:#f1f5f9; letter-spacing:0.2px; display:block; margin-bottom:12px;">App Destinations</span>
          <div class="destinations-grid">
            <div class="dest-card" data-view="livetv" onclick="selectDestination('livetv', event)">
              <div class="dest-icon-box" style="background: rgba(56, 189, 248, 0.12); color: #38bdf8;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="3"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Live TV</span><span class="dest-sub">Channels & Guide</span></div>
            </div>
            <div class="dest-card" data-view="movies" onclick="selectDestination('movies', event)">
              <div class="dest-icon-box" style="background: rgba(168, 85, 247, 0.12); color: #a855f7;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                  <line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Movies</span><span class="dest-sub">VOD Cinema</span></div>
            </div>
            <div class="dest-card" data-view="series" onclick="selectDestination('series', event)">
              <div class="dest-icon-box" style="background: rgba(236, 72, 153, 0.12); color: #ec4899;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Series</span><span class="dest-sub">TV Shows</span></div>
            </div>
            <div class="dest-card" data-view="sports" onclick="selectDestination('sports', event)">
              <div class="dest-icon-box" style="background: rgba(16, 185, 129, 0.12); color: #10b981;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Sports</span><span class="dest-sub">Live & Upcoming</span></div>
            </div>
            <div class="dest-card" data-view="stremio" onclick="selectDestination('stremio', event)">
              <div class="dest-icon-box" style="background: rgba(99, 102, 241, 0.12); color: #818cf8;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Stremio</span><span class="dest-sub">Addon Catalogs</span></div>
            </div>
            <div class="dest-card" data-view="nuvio" onclick="selectDestination('nuvio', event)">
              <div class="dest-icon-box" style="background: rgba(14, 165, 233, 0.12); color: #38bdf8;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Nuvio</span><span class="dest-sub">Cloud Streams</span></div>
            </div>
            <div class="dest-card" data-view="dvr" onclick="selectDestination('dvr', event)">
              <div class="dest-icon-box" style="background: rgba(245, 158, 11, 0.12); color: #f59e0b;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">DVR</span><span class="dest-sub">Recordings</span></div>
            </div>
            <div class="dest-card" data-view="settings" onclick="selectDestination('settings', event)">
              <div class="dest-icon-box" style="background: rgba(148, 163, 184, 0.12); color: #cbd5e1;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
              </div>
              <div class="dest-text"><span class="dest-name">Settings</span><span class="dest-sub">Options & Setup</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom Navigation Bar -->
    <nav class="bottom-nav">
      <button id="nav-remote" class="nav-tab-btn active" onclick="switchTab('remote')">
        <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="4"></rect>
          <line x1="6" y1="12" x2="10" y2="12"></line>
          <line x1="8" y1="10" x2="8" y2="14"></line>
          <circle cx="15" cy="12" r="1" fill="currentColor"></circle>
          <circle cx="18" cy="12" r="1" fill="currentColor"></circle>
        </svg>
        <span class="nav-label">Remote</span>
      </button>
      <button id="nav-guide" class="nav-tab-btn" onclick="switchTab('guide')">
        <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="7" width="20" height="15" rx="3"></rect>
          <polyline points="17 2 12 7 7 2"></polyline>
        </svg>
        <span class="nav-label">Live Guide</span>
      </button>
      <button id="nav-sports" class="nav-tab-btn" onclick="switchTab('sports')">
        <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
          <path d="M2 12h20"></path>
        </svg>
        <span class="nav-label">Sports</span>
      </button>
      <button id="nav-multiview" class="nav-tab-btn" onclick="switchTab('multiview')">
        <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1"></rect>
          <rect x="14" y="3" width="7" height="7" rx="1"></rect>
          <rect x="14" y="14" width="7" height="7" rx="1"></rect>
          <rect x="3" y="14" width="7" height="7" rx="1"></rect>
        </svg>
        <span class="nav-label">Multiview</span>
      </button>
      <button id="nav-destinations" class="nav-tab-btn" style="display:none;" onclick="switchTab('destinations')">
        <svg class="nav-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>
        </svg>
        <span class="nav-label">Sections</span>
      </button>
    </nav>
  </div>

  <!-- On-Phone Settings Modal Sheet -->
  <div id="phone-settings-overlay" class="sections-overlay" onclick="closePhoneSettingsModal(event)">
    <div class="sections-sheet" onclick="event.stopPropagation()">
      <div class="sheet-handle" onclick="closePhoneSettingsModal()"></div>
      <div class="sheet-header">
        <div class="sheet-title-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          <span class="sheet-title">Remote Settings</span>
        </div>
        <button class="sheet-close-btn" onclick="closePhoneSettingsModal()" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div style="padding:16px; display:flex; flex-direction:column; gap:16px;">
        <div>
          <span style="font-size:12px; font-weight:800; color:var(--text-secondary); display:block; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">Theme & Skin</span>
          <div id="phone-skin-picker" class="phone-skin-picker-grid"></div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px solid var(--border-glass);">
          <div>
            <span style="font-size:13px; font-weight:700; display:block;">Button Sizing</span>
            <span style="font-size:11px; color:var(--text-muted);">Overall remote scaling</span>
          </div>
          <select id="phone-size-select" onchange="setPhoneButtonSize(this.value)" style="background:var(--bg-surface-elevated); color:var(--text-primary); border:1px solid var(--border-glass); border-radius:8px; padding:6px 10px; font-size:12px; font-weight:700;">
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="large">Large</option>
          </select>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px solid var(--border-glass);">
          <div>
            <span style="font-size:13px; font-weight:700; display:block;">Middle Buttons Size</span>
            <span style="font-size:11px; color:var(--text-muted);">Height of Back / Play stack</span>
          </div>
          <select id="phone-center-size-select" onchange="setPhoneCenterSize(this.value)" style="background:var(--bg-surface-elevated); color:var(--text-primary); border:1px solid var(--border-glass); border-radius:8px; padding:6px 10px; font-size:12px; font-weight:700;">
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="large">Large</option>
            <option value="expanded">Expanded</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- Launch Shortcuts / Destinations Bottom Sheet Modal -->
  <div id="sections-overlay" class="sections-overlay" onclick="onOverlayClick(event)">
    <div class="sections-sheet" onclick="event.stopPropagation()">
      <div class="sheet-handle" onclick="closeSectionsMenu()"></div>
      <div class="sheet-header">
        <div class="sheet-title-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
          <span class="sheet-title">Jump to Destination</span>
        </div>
        <button class="sheet-close-btn" onclick="closeSectionsMenu()" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="destinations-grid">
        <!-- 1. Live TV -->
        <div class="dest-card" data-view="livetv" onclick="selectDestination('livetv', event)">
          <div class="dest-icon-box" style="background: rgba(56, 189, 248, 0.12); color: #38bdf8;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="7" width="20" height="15" rx="3"></rect>
              <polyline points="17 2 12 7 7 2"></polyline>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Live TV</span>
            <span class="dest-sub">Channels & Guide</span>
          </div>
        </div>

        <!-- 2. Movies -->
        <div class="dest-card" data-view="movies" onclick="selectDestination('movies', event)">
          <div class="dest-icon-box" style="background: rgba(168, 85, 247, 0.12); color: #a855f7;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
              <line x1="7" y1="2" x2="7" y2="22"></line>
              <line x1="17" y1="2" x2="17" y2="22"></line>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <line x1="2" y1="7" x2="7" y2="7"></line>
              <line x1="2" y1="17" x2="7" y2="17"></line>
              <line x1="17" y1="17" x2="22" y2="17"></line>
              <line x1="17" y1="7" x2="22" y2="7"></line>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Movies</span>
            <span class="dest-sub">VOD & Cinema</span>
          </div>
        </div>

        <!-- 3. Series -->
        <div class="dest-card" data-view="series" onclick="selectDestination('series', event)">
          <div class="dest-icon-box" style="background: rgba(236, 72, 153, 0.12); color: #ec4899;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Series</span>
            <span class="dest-sub">Shows & Episodes</span>
          </div>
        </div>

        <!-- 4. Sports -->
        <div class="dest-card" data-view="sports" onclick="selectDestination('sports', event)">
          <div class="dest-icon-box" style="background: rgba(34, 197, 94, 0.12); color: #22c55e;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
              <path d="M2 12h20"></path>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Sports</span>
            <span class="dest-sub">Scores & Games</span>
          </div>
        </div>

        <!-- 5. Stremio -->
        <div class="dest-card" data-view="stremio" onclick="selectDestination('stremio', event)">
          <div class="dest-icon-box" style="background: rgba(99, 102, 241, 0.12); color: #818cf8;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polygon points="10 8 16 12 10 16 10 8"></polygon>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Stremio</span>
            <span class="dest-sub">Addon Catalogs</span>
          </div>
        </div>

        <!-- 6. Nuvio -->
        <div class="dest-card" data-view="nuvio" onclick="selectDestination('nuvio', event)">
          <div class="dest-icon-box" style="background: rgba(14, 165, 233, 0.12); color: #38bdf8;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Nuvio</span>
            <span class="dest-sub">Cloud Streams</span>
          </div>
        </div>

        <!-- 7. DVR -->
        <div class="dest-card" data-view="dvr" onclick="selectDestination('dvr', event)">
          <div class="dest-icon-box" style="background: rgba(245, 158, 11, 0.12); color: #f59e0b;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">DVR</span>
            <span class="dest-sub">Recordings</span>
          </div>
        </div>

        <!-- 8. Settings -->
        <div class="dest-card" data-view="settings" onclick="selectDestination('settings', event)">
          <div class="dest-icon-box" style="background: rgba(148, 163, 184, 0.12); color: #cbd5e1;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </div>
          <div class="dest-text">
            <span class="dest-name">Settings</span>
            <span class="dest-sub">Options & Setup</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <!-- Multiview pick-mode banner: visible across tabs while picking a channel for a slot -->
  <div id="mv-pick-banner" class="mv-pick-banner" style="display:none;">
    <span id="mv-pick-text"></span>
    <button id="mv-pick-cancel" class="mv-pick-cancel">Cancel</button>
  </div>

  <!-- Not-paired overlay -->
  <div id="pair-screen" class="pair-screen" hidden>
    <div class="pair-card">
      <svg class="pair-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      <h1 class="pair-title" id="pair-title">Pair with YNOTV</h1>
      <p class="pair-desc" id="pair-desc">Scan the QR code on your computer to connect this phone remote companion.</p>
      <div class="pair-steps">
        <div class="pair-step-item">
          <span class="pair-step-num">1</span>
          <span>Open <strong>YNOTV</strong> on your computer</span>
        </div>
        <div class="pair-step-item">
          <span class="pair-step-num">2</span>
          <span>Go to <strong>Settings → Controllers</strong></span>
        </div>
        <div class="pair-step-item">
          <span class="pair-step-num">3</span>
          <span>Enable <strong>Virtual Phone Remote</strong></span>
        </div>
        <div class="pair-step-item">
          <span class="pair-step-num">4</span>
          <span>Scan the <strong>QR code</strong> with this phone</span>
        </div>
      </div>
      <button class="pair-retry" id="pair-retry">Try Connecting Again</button>
    </div>
  </div>

  <script>
    // Disable double-click and pinch zooming
    document.addEventListener('dblclick', (e) => {
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
      }
    }, { passive: false });

    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

    let ws = null;
    let currentCategoryId = '__favorites__';
    let currentCategoryName = 'Favorites';
    let currentSearchTerm = '';
    let searchDebounceTimer = null;
    let categoryTreeData = null;
    let expandedSources = new Set();
    let expandedFolders = new Set();

    // Restore saved source/folder expansion state so the tree remembers what
    // the user had collapsed/expanded across page reloads and reconnects.
    function loadTreeState() {
      try {
        const raw = localStorage.getItem('phoneRemote_guideTreeState');
        if (!raw) return;
        const st = JSON.parse(raw);
        if (Array.isArray(st.sources)) expandedSources = new Set(st.sources);
        if (Array.isArray(st.folders)) expandedFolders = new Set(st.folders);
      } catch (e) { /* ignore corrupt/stale state */ }
    }
    function saveTreeState() {
      try {
        localStorage.setItem('phoneRemote_guideTreeState', JSON.stringify({
          sources: Array.from(expandedSources),
          folders: Array.from(expandedFolders)
        }));
      } catch (e) { /* storage unavailable */ }
    }
    loadTreeState();

    let sidebarOpen = true;
    let lastSportsEvents = null;
    let expandedStreams = new Set();
    let pickSlot = null;        // app slot id (2|3|4) awaiting a channel from the guide
    let lastNowPlaying = null;
    let lastMultiview = null;

    const statusEl = document.getElementById('status');
    const statusTextEl = document.getElementById('status-text');
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const appRoot = document.getElementById('app-root');
    const pairScreen = document.getElementById('pair-screen');
    const pairRetry = document.getElementById('pair-retry');
    const toastEl = document.getElementById('toast');

    function showToast(msg) {
      toastEl.innerText = msg;
      toastEl.classList.add('show');
      setTimeout(() => toastEl.classList.remove('show'), 2000);
    }

    // Escape a value for safe interpolation into HTML text/attribute context.
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Escape a value for embedding inside a single-quoted JS string literal that
    // lives in an HTML attribute (e.g. onclick="fn('...')").
    function escAttr(s) {
      return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function showPairScreen(kind) {
      pairScreen.hidden = false;
      appRoot.hidden = true;
    }

    function showApp() {
      pairScreen.hidden = true;
      appRoot.hidden = false;
    }

    function toggleSidebar() {
      sidebarOpen = !sidebarOpen;
      const sb = document.getElementById('guide-sidebar');
      if (sidebarOpen) {
        sb.classList.remove('collapsed');
      } else {
        sb.classList.add('collapsed');
      }
    }

    function switchTab(tabId) {
      if (navigator.vibrate) navigator.vibrate(15);
      document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
      
      const targetNav = document.getElementById(`nav-${tabId}`);
      const targetPane = document.getElementById(`tab-${tabId}`);
      if (targetNav) targetNav.classList.add('active');
      if (targetPane) targetPane.classList.add('active');

      if (tabId === 'guide') {
        requestGuide(currentCategoryId, currentSearchTerm);
      } else if (tabId === 'sports') {
        requestSports();
      }
    }

    function connect() {
      const loc = window.location;
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProto}//${loc.host}/api/remote?token=${encodeURIComponent(token)}`;
      
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        showApp();
        statusEl.className = 'status-badge connected';
        statusTextEl.innerText = 'Connected';
        send({ action: 'getInitialState' });
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          handleIncomingData(data);
        } catch (e) {}
      };

      ws.onclose = (ev) => {
        statusEl.className = 'status-badge';
        if (ev.code === 4001) {
          showPairScreen('invalid');
        } else {
          statusTextEl.innerText = 'Reconnecting...';
          setTimeout(connect, 1500);
        }
      };

      ws.onerror = () => { ws.close(); };
    }

    function send(msg) {
      if (navigator.vibrate) navigator.vibrate(12);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }

    function sendNav(key, e) {
      if (e && e.cancelable) e.preventDefault();
      send({ action: 'nav', key });
    }

    // ── D-pad hold-to-repeat ────────────────────────────────────────────────
    const NAV_REPEAT_HOLD_MS = 350;   // delay before repeating starts
    const NAV_REPEAT_START_MS = 220;  // initial repeat interval (slow)
    const NAV_REPEAT_STEP_MS = 15;    // interval shrinks by this each repeat
    const NAV_REPEAT_MIN_MS = 60;     // fastest allowed repeat rate
    let navRepeatTimer = null;
    let navRepeatInterval = null;

    function startNavRepeat(key, e) {
      if (e && e.cancelable) e.preventDefault();
      stopNavRepeat();
      send({ action: 'nav', key }); // initial press
      navRepeatTimer = setTimeout(() => {
        let intervalMs = NAV_REPEAT_START_MS;
        const tick = () => {
          send({ action: 'nav', key });
          intervalMs = Math.max(NAV_REPEAT_MIN_MS, intervalMs - NAV_REPEAT_STEP_MS);
          navRepeatInterval = setTimeout(tick, intervalMs);
        };
        tick();
      }, NAV_REPEAT_HOLD_MS);
    }

    function stopNavRepeat() {
      if (navRepeatTimer) { clearTimeout(navRepeatTimer); navRepeatTimer = null; }
      if (navRepeatInterval) { clearTimeout(navRepeatInterval); navRepeatInterval = null; }
    }
    function sendAction(action, e) {
      if (e && e.cancelable) e.preventDefault();
      if (action === 'open_sections' || action === 'toggle_sections') {
        toggleSectionsMenu(e);
        return;
      }
      if (action === 'back') {
        sendNav('back', e);
        return;
      }
      send({ action });
    }

    // ── Remote Customization & Skin Engine ──────────────────────────────────
    const DEFAULT_PHONE_REMOTE_CONFIG = {
      skin: 'modern',
      enabledTabs: ['remote', 'guide', 'sports', 'multiview'],
      cornerButtons: {
        topLeft: { enabled: true, action: 'open_sections', customLabel: 'Open' },
        topRight: { enabled: true, action: 'toggle_fullscreen', customLabel: 'Screen' },
        bottomLeft: { enabled: true, action: 'seek_backward', customLabel: '10s' },
        bottomRight: { enabled: true, action: 'seek_forward', customLabel: '10s' },
      },
      centerButtons: {
        top: { enabled: true, action: 'back', customLabel: 'Back' },
        bottom: { enabled: true, action: 'play_pause', customLabel: 'Play / Pause' },
        size: 'normal',
      },
      quickActions: [],
      layout: {
        buttonSize: 'normal',
        showNowPlaying: true,
        showVolumeRocker: true,
        showChannelRocker: true,
        showCenterStack: true,
        showSearch: true,
        showQuickActions: true,
      },
    };

    const ACTION_ICONS = {
      back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>`,
      open_sections: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
      toggle_sections: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
      toggle_fullscreen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`,
      toggle_live_game_sidebar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path></svg>`,
      search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
      subtitles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><line x1="7" y1="15" x2="9" y2="15"></line><line x1="11" y1="15" x2="17" y2="15"></line></svg>`,
      toggle_overlay: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line></svg>`,
      toggle_transparent_overlay: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
      play_pause: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
      seek_backward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon></svg>`,
      seek_forward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 5 2 19"></polygon></svg>`,
      seek_backward_30: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>`,
      seek_forward_30: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>`,
      toggle_mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`,
      volume_up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
      volume_down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
      next_channel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
      prev_channel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
      epg_shift_forward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`,
      epg_shift_backward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`,
      toggle_livetv: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="3"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>`,
      open_movies: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line></svg>`,
      open_series: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>`,
      open_sports: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path></svg>`,
      toggle_stremio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`,
      toggle_nuvio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>`,
      open_settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
    };

    const ACTION_NAMES = {
      back: 'Back',
      open_sections: 'Destinations',
      toggle_sections: 'Destinations',
      toggle_fullscreen: 'Fullscreen',
      seek_backward: 'Rewind 10s',
      seek_forward: 'Forward 10s',
      seek_backward_30: 'Rewind 30s',
      seek_forward_30: 'Forward 30s',
      toggle_mute: 'Mute',
      volume_up: 'Vol +',
      volume_down: 'Vol -',
      search: 'Search',
      subtitles: 'Subtitles',
      toggle_livetv: 'Live TV',
      toggle_stremio: 'Stremio',
      toggle_nuvio: 'Nuvio',
      toggle_overlay: 'EPG Overlay',
      toggle_transparent_overlay: 'Quick Guide',
      open_movies: 'Movies',
      open_series: 'Series',
      open_sports: 'Sports',
      open_settings: 'Settings',
      toggle_live_game_sidebar: 'Scores',
      play_pause: 'Play/Pause',
      next_channel: 'Next CH',
      prev_channel: 'Prev CH',
      epg_shift_forward: 'EPG +2h',
      epg_shift_backward: 'EPG -2h',
    };

    let phoneRemoteConfig = null;

    function loadPhoneRemoteConfig() {
      try {
        const raw = localStorage.getItem('phoneRemote_config');
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            ...DEFAULT_PHONE_REMOTE_CONFIG,
            ...parsed,
            cornerButtons: { ...DEFAULT_PHONE_REMOTE_CONFIG.cornerButtons, ...(parsed.cornerButtons || {}) },
            centerButtons: { ...DEFAULT_PHONE_REMOTE_CONFIG.centerButtons, ...(parsed.centerButtons || {}) },
            layout: { ...DEFAULT_PHONE_REMOTE_CONFIG.layout, ...(parsed.layout || {}) }
          };
        }
      } catch (e) {}
      return { ...DEFAULT_PHONE_REMOTE_CONFIG };
    }

    function savePhoneRemoteConfig(config) {
      try {
        localStorage.setItem('phoneRemote_config', JSON.stringify(config));
      } catch (e) {}
    }

    function onCornerBtnClick(cornerKey, e) {
      if (e && e.cancelable) e.preventDefault();
      if (!phoneRemoteConfig || !phoneRemoteConfig.cornerButtons) {
        if (cornerKey === 'topLeft') toggleSectionsMenu(e);
        else if (cornerKey === 'topRight') sendAction('toggle_fullscreen', e);
        else if (cornerKey === 'bottomLeft') sendAction('seek_backward', e);
        else if (cornerKey === 'bottomRight') sendAction('seek_forward', e);
        return;
      }
      const corner = phoneRemoteConfig.cornerButtons[cornerKey];
      if (!corner || corner.enabled === false || !corner.action || corner.action === 'none') return;
      if (corner.action === 'open_sections' || corner.action === 'toggle_sections') {
        toggleSectionsMenu(e);
      } else if (corner.action === 'back') {
        sendNav('back', e);
      } else {
        sendAction(corner.action, e);
      }
    }

    function onCenterBtnClick(pos, e) {
      if (e && e.cancelable) e.preventDefault();
      if (!phoneRemoteConfig || !phoneRemoteConfig.centerButtons) {
        if (pos === 'top') sendNav('back', e);
        else sendAction('play_pause', e);
        return;
      }
      const btn = phoneRemoteConfig.centerButtons[pos];
      if (!btn || btn.enabled === false || !btn.action || btn.action === 'none') return;
      if (btn.action === 'back') {
        sendNav('back', e);
      } else if (btn.action === 'open_sections' || btn.action === 'toggle_sections') {
        toggleSectionsMenu(e);
      } else {
        sendAction(btn.action, e);
      }
    }

    function applyPhoneRemoteConfig(config) {
      if (!config) return;
      phoneRemoteConfig = config;
      savePhoneRemoteConfig(config);

      // 1. Skin Theme & Sizing
      document.body.dataset.skin = config.skin || 'modern';
      document.body.dataset.size = config.layout?.buttonSize || 'normal';
      document.body.dataset.centerSize = config.centerButtons?.size || 'normal';

      // 2. Corner Satellite Buttons
      const corners = config.cornerButtons || DEFAULT_PHONE_REMOTE_CONFIG.cornerButtons;
      const mapCorner = (domId, cornerObj) => {
        const cornerEl = document.getElementById(`corner-${domId}`);
        const iconEl = document.getElementById(`corner-icon-${domId}`);
        const labelEl = document.getElementById(`corner-label-${domId}`);
        if (!cornerEl) return;
        if (!cornerObj || cornerObj.enabled === false || cornerObj.action === 'none') {
          cornerEl.style.visibility = 'hidden';
          return;
        }
        cornerEl.style.visibility = 'visible';
        const labelText = cornerObj.customLabel || cornerObj.label || ACTION_NAMES[cornerObj.action] || (domId === 'top-left' ? 'Open' : domId === 'top-right' ? 'Screen' : '10s');
        cornerEl.title = labelText;
        if (labelEl) labelEl.innerText = labelText;
        if (iconEl) iconEl.innerHTML = ACTION_ICONS[cornerObj.action] || (domId === 'top-left' ? ACTION_ICONS.open_sections : ACTION_ICONS.toggle_fullscreen);
      };
      mapCorner('top-left', corners.topLeft);
      mapCorner('top-right', corners.topRight);
      mapCorner('bottom-left', corners.bottomLeft);
      mapCorner('bottom-right', corners.bottomRight);

      // 3. Center Stack Buttons (Top / Bottom)
      const centerBtns = config.centerButtons || DEFAULT_PHONE_REMOTE_CONFIG.centerButtons;
      const mapCenterBtn = (pos, btnObj) => {
        const btnEl = document.getElementById(`center-btn-${pos}`);
        const iconEl = document.getElementById(`center-icon-${pos}`);
        const labelEl = document.getElementById(`center-label-${pos}`);
        if (!btnEl) return;
        if (!btnObj || btnObj.enabled === false || btnObj.action === 'none') {
          btnEl.style.display = 'none';
          return;
        }
        btnEl.style.display = 'flex';
        const labelText = btnObj.customLabel || ACTION_NAMES[btnObj.action] || (pos === 'top' ? 'Back' : 'Play / Pause');
        btnEl.title = labelText;
        if (labelEl) labelEl.innerText = labelText;
        if (iconEl) iconEl.innerHTML = ACTION_ICONS[btnObj.action] || (pos === 'top' ? ACTION_ICONS.back : ACTION_ICONS.play_pause);
      };
      mapCenterBtn('top', centerBtns.top);
      mapCenterBtn('bottom', centerBtns.bottom);

      // 4. Quick Actions
      const qaContainer = document.getElementById('remote-quick-actions');
      if (qaContainer) {
        if (config.layout?.showQuickActions !== false && Array.isArray(config.quickActions) && config.quickActions.length > 0) {
          qaContainer.style.display = 'flex';
          qaContainer.innerHTML = config.quickActions.map(actId => {
            const icon = ACTION_ICONS[actId] || '';
            const name = ACTION_NAMES[actId] || actId;
            return `<button class="remote-qa-btn" onpointerdown="sendAction('${escAttr(actId)}', event)">${icon}<span>${esc(name)}</span></button>`;
          }).join('');
        } else {
          qaContainer.style.display = 'none';
        }
      }

      // 5. Layout elements
      const npBanner = document.getElementById('now-playing-banner');
      if (npBanner && config.layout?.showNowPlaying === false) {
        npBanner.style.setProperty('display', 'none', 'important');
      }

      const searchWrap = document.getElementById('remote-search-wrap');
      if (searchWrap) searchWrap.style.display = config.layout?.showSearch !== false ? 'flex' : 'none';

      const volPillar = document.getElementById('vol-pillar');
      if (volPillar) volPillar.style.display = config.layout?.showVolumeRocker !== false ? 'flex' : 'none';

      const chPillar = document.getElementById('ch-pillar');
      if (chPillar) chPillar.style.display = config.layout?.showChannelRocker !== false ? 'flex' : 'none';

      const centerStack = document.getElementById('center-stack');
      if (centerStack) centerStack.style.display = config.layout?.showCenterStack !== false ? 'flex' : 'none';

      // 6. Tabs display
      const enabledTabs = new Set(config.enabledTabs || ['remote', 'guide', 'sports', 'multiview']);
      ['remote', 'guide', 'sports', 'multiview', 'destinations'].forEach(tabId => {
        const navBtn = document.getElementById(`nav-${tabId}`);
        if (navBtn) {
          navBtn.style.display = enabledTabs.has(tabId) ? 'flex' : 'none';
        }
      });

      // Update phone settings modal controls if open
      const sizeSelect = document.getElementById('phone-size-select');
      if (sizeSelect) sizeSelect.value = config.layout?.buttonSize || 'normal';
      const centerSizeSelect = document.getElementById('phone-center-size-select');
      if (centerSizeSelect) centerSizeSelect.value = config.centerButtons?.size || 'normal';
      renderPhoneSkinPicker();
    }

    // ── On-Phone Remote Settings Modal ───────────────────────────────────────
    const ALL_SKINS = [
      { id: 'modern', name: 'Modern' },
      { id: 'oled', name: 'OLED' },
      { id: 'cyberpunk', name: 'Cyber' },
      { id: 'midnight', name: 'Midnight' },
      { id: 'sunset', name: 'Sunset' },
      { id: 'forest', name: 'Emerald' },
      { id: 'crimson', name: 'Crimson' },
      { id: 'retro', name: 'Arcade' },
    ];

    function openPhoneSettingsModal() {
      const modal = document.getElementById('phone-settings-overlay');
      if (modal) modal.classList.add('open');
      renderPhoneSkinPicker();
    }
    function closePhoneSettingsModal(e) {
      if (e && e.target && e.target.id !== 'phone-settings-overlay' && !e.target.closest('.sheet-close-btn') && !e.target.classList.contains('sheet-handle')) return;
      const modal = document.getElementById('phone-settings-overlay');
      if (modal) modal.classList.remove('open');
    }
    function renderPhoneSkinPicker() {
      const picker = document.getElementById('phone-skin-picker');
      if (!picker || !phoneRemoteConfig) return;
      const curSkin = phoneRemoteConfig.skin || 'modern';
      picker.innerHTML = ALL_SKINS.map(s => `
        <button class="phone-skin-option ${s.id === curSkin ? 'active' : ''}" onclick="selectPhoneSkin('${s.id}')">
          ${esc(s.name)}
        </button>
      `).join('');
    }
    function selectPhoneSkin(skinId) {
      if (!phoneRemoteConfig) return;
      phoneRemoteConfig.skin = skinId;
      applyPhoneRemoteConfig(phoneRemoteConfig);
      send({ action: 'setRemoteConfig', config: phoneRemoteConfig });
    }
    function setPhoneButtonSize(size) {
      if (!phoneRemoteConfig) return;
      if (!phoneRemoteConfig.layout) phoneRemoteConfig.layout = {};
      phoneRemoteConfig.layout.buttonSize = size;
      applyPhoneRemoteConfig(phoneRemoteConfig);
      send({ action: 'setRemoteConfig', config: phoneRemoteConfig });
    }
    function setPhoneCenterSize(size) {
      if (!phoneRemoteConfig) return;
      if (!phoneRemoteConfig.centerButtons) phoneRemoteConfig.centerButtons = { ...DEFAULT_PHONE_REMOTE_CONFIG.centerButtons };
      phoneRemoteConfig.centerButtons.size = size;
      applyPhoneRemoteConfig(phoneRemoteConfig);
      send({ action: 'setRemoteConfig', config: phoneRemoteConfig });
    }

    // Apply saved or default config immediately
    applyPhoneRemoteConfig(loadPhoneRemoteConfig());

    // ── Remote search box ────────────────────────────────────────────────────
    // Typing on the phone sends the query to the app (debounced) so the app
    // searches live, just like the titlebar search box. Enter or the Go button
    // also commits the query into search history. Clearing the box clears the
    // app's search. The app echoes the query back (two-way sync), so the "…"
    // searching indicator shows while the app hasn't caught up yet.
    let remoteSearchDebounce = null;
    let lastSyncedRemoteQuery = '';
    function currentRemoteSearchQuery() {
      const input = document.getElementById('remote-search-input');
      return input ? input.value : '';
    }
    function updateRemoteSearchUi() {
      const input = document.getElementById('remote-search-input');
      const clear = document.getElementById('remote-search-clear');
      const status = document.getElementById('remote-search-status');
      const q = input ? input.value : '';
      if (clear) clear.style.display = q ? 'flex' : 'none';
      if (status) status.style.display = (q && q !== lastSyncedRemoteQuery) ? 'flex' : 'none';
    }
    function onRemoteSearchInput() {
      updateRemoteSearchUi();
      clearTimeout(remoteSearchDebounce);
      remoteSearchDebounce = setTimeout(() => {
        send({ action: 'searchQuery', query: currentRemoteSearchQuery(), commit: false });
      }, 350);
    }
    function submitRemoteSearch(e) {
      if (e && e.cancelable) e.preventDefault();
      clearTimeout(remoteSearchDebounce);
      send({ action: 'searchQuery', query: currentRemoteSearchQuery(), commit: true });
    }
    function clearRemoteSearch(e) {
      if (e && e.cancelable) e.preventDefault();
      const input = document.getElementById('remote-search-input');
      if (input) input.value = '';
      lastSyncedRemoteQuery = '';
      updateRemoteSearchUi();
      send({ action: 'searchQuery', query: '', commit: false });
    }

    // ── Type-into-field (search box activated from the remote) ──────────────
    // When the user navigates to a VOD/Stremio/Nuvio search box and presses
    // select from the phone remote, the app asks this page to show a query
    // box. Typing here streams the text back to the focused field.
    let remoteTypeFieldId = null;
    let remoteTypeDebounce = null;
    function showRemoteTypeModal(fieldId, value, label) {
      remoteTypeFieldId = fieldId;
      const modal = document.getElementById('remote-type-modal');
      const input = document.getElementById('remote-type-input');
      const labelEl = document.getElementById('remote-type-label');
      if (labelEl) labelEl.innerText = label || 'Type your search';
      if (input) {
        input.value = value || '';
        input.focus();
      }
      if (modal) modal.style.display = 'flex';
    }
    function hideRemoteTypeModal() {
      remoteTypeFieldId = null;
      const modal = document.getElementById('remote-type-modal');
      if (modal) modal.style.display = 'none';
    }
    function remoteTypeInputChanged() {
      clearTimeout(remoteTypeDebounce);
      remoteTypeDebounce = setTimeout(() => {
        if (!remoteTypeFieldId) return;
        const input = document.getElementById('remote-type-input');
        send({ action: 'textInput', fieldId: remoteTypeFieldId, text: input ? input.value : '', commit: false });
      }, 300);
    }
    function remoteTypeOk(e) {
      if (e && e.cancelable) e.preventDefault();
      const input = document.getElementById('remote-type-input');
      send({ action: 'textInput', fieldId: remoteTypeFieldId, text: input ? input.value : '', commit: true });
      hideRemoteTypeModal();
    }
    function remoteTypeCancel(e) {
      if (e && e.cancelable) e.preventDefault();
      send({ action: 'textInput', fieldId: remoteTypeFieldId, text: '', cancel: true });
      hideRemoteTypeModal();
    }
    function sendView(view, e) {
      if (e && e.cancelable) e.preventDefault();
      send({ action: 'openView', view });
    }

    let currentVolume = 100;
    let isMutedState = false;

    function renderVolume(vol, muted) {
      if (typeof vol === 'number') {
        currentVolume = Math.max(0, Math.min(200, vol));
        const slider = document.getElementById('vol-slider');
        const badge = document.getElementById('vol-badge');
        if (slider) slider.value = currentVolume;
        if (badge) badge.innerText = `${currentVolume}%`;
      }
      if (typeof muted === 'boolean') {
        isMutedState = muted;
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
          muteBtn.classList.toggle('active', muted);
          muteBtn.style.color = muted ? '#ef4444' : '';
        }
      }
    }

    function onVolumeSliderInput(val) {
      const vol = parseInt(val, 10);
      const badge = document.getElementById('vol-badge');
      if (badge) badge.innerText = `${vol}%`;
    }

    function onVolumeSliderChange(val) {
      const vol = parseInt(val, 10);
      send({ action: 'setVolume', volume: vol });
    }

    function sendVolumeStep(delta, e) {
      if (e && e.cancelable) e.preventDefault();
      if (navigator.vibrate) navigator.vibrate(10);
      send({ action: 'volumeStep', delta });
    }

    let lastSectionsOpenTime = 0;

    function toggleSectionsMenu(e) {
      if (e) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }
      const overlay = document.getElementById('sections-overlay');
      if (!overlay) return;
      if (overlay.classList.contains('open')) {
        closeSectionsMenu();
      } else {
        openSectionsMenu();
      }
    }

    function openSectionsMenu() {
      lastSectionsOpenTime = Date.now();
      if (navigator.vibrate) navigator.vibrate(10);
      const overlay = document.getElementById('sections-overlay');
      if (overlay) overlay.classList.add('open');
    }

    function closeSectionsMenu() {
      const overlay = document.getElementById('sections-overlay');
      if (overlay) overlay.classList.remove('open');
    }

    function onOverlayClick(e) {
      if (Date.now() - lastSectionsOpenTime < 250) return;
      if (e.target && e.target.id === 'sections-overlay') {
        closeSectionsMenu();
      }
    }

    function selectDestination(view, e) {
      if (e) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
      }
      sendView(view, e);
      closeSectionsMenu();
    }

    function updateSections(view) {
      document.querySelectorAll('.dest-card[data-view]').forEach(card => {
        const matches =
          card.dataset.view === view ||
          ((view === 'guide' || view === 'livetv') && card.dataset.view === 'livetv');
        card.classList.toggle('active', matches);
      });

      const navMap = { guide: 'guide', livetv: 'guide', sports: 'sports' };
      const navId = navMap[view] || null;
      document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.classList.toggle('view-active', btn.id === `nav-${navId}`);
      });
    }

    // Failover playback settings mirrored from the desktop app (Always Play
    // Primary + keep-view). Tuning from the phone goes through the same desktop
    // wrapper, so this bar only surfaces the current toggle state and lets the
    // user flip it from the phone. viewChannel is the channel to highlight in
    // the guide list as now-viewing (keep-view anchor when active).
    let failoverSettings = { failoverAlwaysPlayPrimary: false, failoverKeepView: false };
    let viewChannelStreamId = null;
    function updateGuideViewHighlight() {
      const cards = document.querySelectorAll('#guide-list .guide-card');
      cards.forEach(card => {
        card.classList.toggle('is-view', card.dataset.streamId === viewChannelStreamId);
      });
    }
    function applyFailoverSettings(s) {
      if (!s) return;
      failoverSettings = Object.assign({}, failoverSettings, s);
      if (s.viewChannel) viewChannelStreamId = s.viewChannel.stream_id || null;
      const bar = document.getElementById('failover-guide-bar');
      if (bar) bar.style.display = 'flex';
      const cb = document.getElementById('failover-primary-toggle');
      if (cb) cb.checked = !!failoverSettings.failoverAlwaysPlayPrimary;
      const kv = document.getElementById('failover-keepview-toggle');
      if (kv) kv.checked = !!failoverSettings.failoverKeepView;
      updateGuideViewHighlight();
    }
    function onFailoverPrimaryToggle(enabled) {
      send({ action: 'setFailoverAlwaysPlayPrimary', enabled });
    }
    function onFailoverKeepViewToggle(enabled) {
      send({ action: 'setFailoverKeepView', enabled });
    }

    function handleIncomingData(data) {
      if (data.type === 'initialState') {
        if (data.phoneRemoteConfig) applyPhoneRemoteConfig(data.phoneRemoteConfig);
        if (data.failoverSettings) applyFailoverSettings(data.failoverSettings);
        if (data.nowPlaying !== undefined) renderNowPlaying(data.nowPlaying);
        if (data.categoryTree) renderCategoryTree(data.categoryTree);
        if (data.multiview) renderMultiview(data.multiview);
        if (data.activeView !== undefined) updateSections(data.activeView);
        if (data.volume !== undefined || data.muted !== undefined) renderVolume(data.volume, data.muted);
        if (data.searchQuery !== undefined) {
          lastSyncedRemoteQuery = data.searchQuery || '';
          const searchInput = document.getElementById('remote-search-input');
          if (searchInput) searchInput.value = lastSyncedRemoteQuery;
          updateRemoteSearchUi();
        }
      } else if (data.type === 'remoteConfig') {
        if (data.config) applyPhoneRemoteConfig(data.config);
      } else if (data.type === 'failoverSettings') {
        applyFailoverSettings(data);
      } else if (data.type === 'volume') {
        renderVolume(data.volume, data.muted);
      } else if (data.type === 'view') {
        updateSections(data.view);
      } else if (data.type === 'nowPlaying') {
        renderNowPlaying(data.nowPlaying);
      } else if (data.categoryTree) {
        renderCategoryTree(data.categoryTree);
      } else if (data.type === 'guideData') {
        renderGuideChannels(data.channels, data.categoryId);
      } else if (data.type === 'sportsData') {
        renderSports(data.events);
      } else if (data.type === 'multiview') {
        renderMultiview(data.multiview);
      } else if (data.type === 'searchQuery') {
        // Keep the remote search box in sync with the app (titlebar typing,
        // controller modal, or remote itself). Setting .value programmatically
        // never fires oninput, so this cannot loop back into the app. The
        // synced query also clears the "searching…" indicator.
        lastSyncedRemoteQuery = data.query || '';
        const searchInput = document.getElementById('remote-search-input');
        if (searchInput) searchInput.value = lastSyncedRemoteQuery;
        updateRemoteSearchUi();
      } else if (data.type === 'requestText') {
        showRemoteTypeModal(data.fieldId, data.value, data.label);
      }
    }

    /* Now Playing Renderer */
    function renderNowPlaying(np) {
      lastNowPlaying = np;
      const banner = document.getElementById('now-playing-banner');
      if (!np) {
        banner.style.display = 'none';
        if (lastMultiview) renderMultiview(lastMultiview);
        return;
      }
      banner.style.display = 'flex';
      document.getElementById('np-channel').innerText = np.name || 'Live TV';
      document.getElementById('np-title').innerText = np.current_program?.title || 'Live Broadcast';
      
      const fill = document.getElementById('np-progress-fill');
      if (np.current_program?.progress_percent) {
        fill.style.width = `${np.current_program.progress_percent}%`;
      } else {
        fill.style.width = '0%';
      }

      const logoBox = document.getElementById('np-logo-box');
      if (np.logo) {
        logoBox.innerHTML = `<img src="${esc(np.logo)}" class="np-logo" onerror="this.style.display='none'">`;
      } else {
        logoBox.innerHTML = `<div class="np-logo-fallback">TV</div>`;
      }
      if (lastMultiview) renderMultiview(lastMultiview);
    }

    /* Category Tree Renderer */
    function renderCategoryTree(tree) {
      categoryTreeData = tree;
      const box = document.getElementById('guide-sidebar-tree');
      if (!tree) return;

      let html = '';

      // 1. Virtuals
      if (tree.virtuals && tree.virtuals.length > 0) {
        html += `<div class="tree-header">Favorites & History</div>`;
        tree.virtuals.forEach(v => {
          const isAct = currentCategoryId === v.id;
          html += `
            <div class="tree-item ${isAct ? 'active' : ''}" onclick="selectCategory('${escAttr(v.id)}', '${escAttr(v.name)}')">
              <span class="tree-item-title">${esc(v.icon || '')} ${esc(v.name)}</span>
            </div>
          `;
        });
      }

      // 2. Custom Groups
      if (tree.custom_groups && tree.custom_groups.length > 0) {
        html += `<div class="tree-header">Custom Groups</div>`;
        tree.custom_groups.forEach(g => {
          const isAct = currentCategoryId === g.id;
          html += `
            <div class="tree-item ${isAct ? 'active' : ''}" onclick="selectCategory('${escAttr(g.id)}', '${escAttr(g.name)}')">
              <span class="tree-item-title">📂 ${esc(g.name)}</span>
            </div>
          `;
        });
      }

      // 3. Source Groups
      if (tree.source_groups && tree.source_groups.length > 0) {
        html += `<div class="tree-header">Playlists & Sources</div>`;
        tree.source_groups.forEach(sg => {
          const isSrcOpen = expandedSources.has(sg.source_id);
          html += `
            <div class="tree-source-row" onclick="toggleSource('${escAttr(sg.source_id)}')">
              <span class="tree-chevron ${isSrcOpen ? 'open' : ''}">▶</span>
              <span class="tree-item-title">${esc(sg.source_name)}</span>
              ${sg.count ? `<span class="tree-badge">${sg.count}</span>` : ''}
            </div>
          `;

          if (isSrcOpen) {
            // Folders inside source
            if (sg.folders && sg.folders.length > 0) {
              sg.folders.forEach(f => {
                const isFoldOpen = expandedFolders.has(f.folder_id);
                html += `
                  <div class="tree-folder-row" onclick="toggleFolder('${escAttr(f.folder_id)}')">
                    <span class="tree-chevron ${isFoldOpen ? 'open' : ''}">▶</span>
                    <span class="tree-item-title">📁 ${esc(f.name)}</span>
                    ${f.count ? `<span class="tree-badge">${f.count}</span>` : ''}
                  </div>
                `;

                if (isFoldOpen && f.categories) {
                  html += `<div class="tree-folder-contents">`;
                  f.categories.forEach(c => {
                    const isAct = currentCategoryId === c.id;
                    html += `
                      <div class="tree-item ${isAct ? 'active' : ''}" onclick="selectCategory('${escAttr(c.id)}', '${escAttr(c.name)}')">
                        <span class="tree-item-title">${esc(c.name)}</span>
                        ${c.count ? `<span class="tree-badge">${c.count}</span>` : ''}
                      </div>
                    `;
                  });
                  html += `</div>`;
                }
              });
            }

            // Categories directly under source
            if (sg.categories && sg.categories.length > 0) {
              sg.categories.forEach(c => {
                const isAct = currentCategoryId === c.id;
                html += `
                  <div class="tree-item ${isAct ? 'active' : ''}" onclick="selectCategory('${escAttr(c.id)}', '${escAttr(c.name)}')">
                    <span class="tree-item-title">${esc(c.name)}</span>
                    ${c.count ? `<span class="tree-badge">${c.count}</span>` : ''}
                  </div>
                `;
              });
            }
          }
        });
      }

      box.innerHTML = html;
    }

    function toggleSource(sourceId) {
      if (expandedSources.has(sourceId)) {
        expandedSources.delete(sourceId);
      } else {
        expandedSources.add(sourceId);
      }
      saveTreeState();
      renderCategoryTree(categoryTreeData);
    }

    function toggleFolder(folderId) {
      if (expandedFolders.has(folderId)) {
        expandedFolders.delete(folderId);
      } else {
        expandedFolders.add(folderId);
      }
      saveTreeState();
      renderCategoryTree(categoryTreeData);
    }

    function selectCategory(catId, catName) {
      if (navigator.vibrate) navigator.vibrate(15);
      currentCategoryId = catId;
      currentCategoryName = catName;
      document.getElementById('guide-cat-title').innerText = catName;
      document.getElementById('guide-cat-count').innerText = '';
      document.getElementById('guide-list').innerHTML = `<div style="text-align:center; padding:30px; color:#64748b;">Loading channels...</div>`;
      renderCategoryTree(categoryTreeData);
      requestGuide(currentCategoryId, currentSearchTerm);
    }

    function onSearchInput(val) {
      currentSearchTerm = val;
      const clearBtn = document.getElementById('guide-search-clear');
      clearBtn.style.display = val ? 'flex' : 'none';
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        document.getElementById('guide-list').innerHTML = `<div style="text-align:center; padding:30px; color:#64748b;">Searching...</div>`;
        requestGuide(currentCategoryId, currentSearchTerm);
      }, 200);
    }

    function clearSearch() {
      document.getElementById('guide-search').value = '';
      onSearchInput('');
    }

    function requestGuide(categoryId, search) {
      send({ action: 'getGuide', categoryId, search });
    }

    /* Guide Channels Renderer */
    function renderGuideChannels(channels, catId) {
      if (catId && catId !== currentCategoryId && !currentSearchTerm) {
        return; // Ignore stale response
      }
      const list = document.getElementById('guide-list');
      const countEl = document.getElementById('guide-cat-count');
      if (channels) countEl.innerText = `${channels.length} channels`;

      if (!channels || !channels.length) {
        list.innerHTML = `<div style="text-align:center; padding:30px; color:#64748b;">No channels found</div>`;
        return;
      }

      // Search results are cross-category, so only attach the browsed category
      // for non-search guide taps.
      const tapCat = currentSearchTerm ? '' : (currentCategoryId || '');
      let html = '';
      channels.forEach(c => {
        const name = c.name || '';
        const logoHtml = c.logo
          ? `<img src="${esc(c.logo)}" class="guide-logo" onerror="this.onerror=null; this.src=''; this.className='guide-logo-fallback';">`
          : `<div class="guide-logo-fallback">${esc((name || 'CH').slice(0, 2).toUpperCase())}</div>`;

        const progTitle = c.current_program?.title || 'Live Stream';
        const progTime = c.current_program?.time_remaining ? ` • ${esc(c.current_program.time_remaining)}` : '';
        const progressPct = c.current_program?.progress_percent || 0;
        const nextTitle = c.next_program ? `Next: ${esc(c.next_program.title)}` : '';
        const timeRange = formatTimeRange(c.current_program?.start, c.current_program?.end);

        const isView = c.stream_id === viewChannelStreamId;
        html += `
          <div class="guide-card${isView ? ' is-view' : ''}" data-stream-id="${escAttr(c.stream_id)}" onclick="channelTap('${escAttr(c.stream_id)}', '${escAttr(name)}', '${escAttr(tapCat)}')">
            ${logoHtml}
            <div class="guide-card-content">
              <div class="guide-card-header">
                <span class="guide-card-ch-name">${esc(name)}</span>
              </div>
              <span class="guide-card-prog-title">${esc(progTitle)}</span>
              ${progressPct > 0 ? `
                <div class="np-progress-bar" style="margin: 4px 0 2px;">
                  <div class="np-progress-fill" style="width:${progressPct}%;"></div>
                </div>
              ` : ''}
              <span class="guide-prog-time">${timeRange}${progTime}</span>
              ${nextTitle ? `<span class="guide-card-next">${nextTitle}</span>` : ''}
            </div>
          </div>
        `;
      });
      list.innerHTML = html;
    }

    function formatTime(iso) {
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (e) { return ''; }
    }

    function formatTimeRange(startIso, endIso) {
      const s = startIso ? formatTime(startIso) : '';
      const e = endIso ? formatTime(endIso) : '';
      if (s && e) return `${s} - ${e}`;
      return s || e || '';
    }

    function playChannel(channelId, name, catId) {
      if (navigator.vibrate) navigator.vibrate(25);
      send({ action: 'playChannel', channelId, categoryId: catId || undefined });
      showToast(`Tuning to ${name || 'Channel'}`);
    }

    /* Live Sports Renderer */
    function requestSports() {
      send({ action: 'getSports' });
    }

    function renderSports(events) {
      lastSportsEvents = events || [];
      const list = document.getElementById('sports-list');
      if (!events || !events.length) {
        list.innerHTML = `<div style="text-align:center; padding:30px; color:#64748b;">No live sports matches right now</div>`;
        return;
      }

      const pickTarget = pickSlot;

      let html = '';
      events.forEach(e => {
        const awayName = e.away_team?.name || 'A';
        const homeName = e.home_team?.name || 'H';
        const awayLogo = e.away_team?.logo
          ? `<img src="${esc(e.away_team.logo)}" class="sports-team-logo" onerror="this.style.display='none'">`
          : `<div class="sports-team-fallback">${esc(awayName.slice(0, 2))}</div>`;
        const homeLogo = e.home_team?.logo
          ? `<img src="${esc(e.home_team.logo)}" class="sports-team-logo" onerror="this.style.display='none'">`
          : `<div class="sports-team-fallback">${esc(homeName.slice(0, 2))}</div>`;

        const isLive = e.status === 'live' || e.status_text?.includes('Qtr') || e.status_text?.includes('Half') || e.status_text?.includes("'");

        function teamLinksHtml(team) {
          if (!team?.links?.length) return '';
          const primary = team.links[0];
          const backups = team.links.length > 1
            ? `<select class="sports-link-dropdown" onchange="playBackup(this)">
                 <option value="">Backup ▾</option>
                 ${team.links.slice(1).map(l => `<option value="${esc(l.stream_id)}">${esc(l.channel_name)}</option>`).join('')}
               </select>`
            : '';
          return `
            <div class="sports-team-links">
              <button class="sports-team-link-pill" onclick="event.stopPropagation(); channelTap('${escAttr(primary.stream_id)}', '${escAttr(primary.channel_name)}')">
                <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                ${esc(primary.channel_name)}
              </button>
              ${backups}
            </div>`;
        }
        const awayLinkHtml = teamLinksHtml(e.away_team);
        const homeLinkHtml = teamLinksHtml(e.home_team);

        let streamsHtml = '';
        if (e.available_streams && e.available_streams.length > 0) {
          const isStreamsOpen = expandedStreams.has(e.id);
          streamsHtml = `
            <div class="sports-streams-accordion">
              <div class="sports-streams-toggle ${isStreamsOpen ? 'open' : ''}" onclick="toggleStreams('${escAttr(e.id)}')">
                <span class="sports-streams-title">Matched Broadcast Streams (${e.available_streams.length})</span>
                <span class="chev">▶</span>
              </div>
              ${isStreamsOpen ? `
                <div style="display:flex; flex-direction:column; gap:6px;">
                  ${e.available_streams.map(s => `
                    <div class="sports-stream-item">
                      <span class="sports-stream-name">${esc(s.channel_name)}</span>
                      <div class="sports-stream-actions">
                        <button class="sports-stream-btn" onclick="channelTap('${escAttr(s.stream_id)}', '${escAttr(s.channel_name)}')">${pickTarget ? `→ Slot ${pickTarget}` : 'Tune'}</button>
                      </div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          `;
        }

        html += `
          <div class="sports-card">
            <div class="sports-card-header">
              <span class="sports-league-tag">${esc(e.league?.name || 'SPORTS')}</span>
              <span class="sports-clock-badge">
                ${isLive ? `<span class="sports-live-dot"></span>` : ''}
                ${esc(e.status_text || 'LIVE')}
              </span>
            </div>
            
            <div class="sports-team-row">
              <div class="sports-team-left">
                <div class="sports-team-main">
                  ${awayLogo}
                  <span class="sports-team-name">${esc(awayName)}</span>
                </div>
                ${awayLinkHtml}
              </div>
              <span class="sports-team-score">${e.away_team?.score ?? '-'}</span>
            </div>

            <div class="sports-team-row">
              <div class="sports-team-left">
                <div class="sports-team-main">
                  ${homeLogo}
                  <span class="sports-team-name">${esc(homeName)}</span>
                </div>
                ${homeLinkHtml}
              </div>
              <span class="sports-team-score">${e.home_team?.score ?? '-'}</span>
            </div>

            ${streamsHtml}
          </div>
        `;
      });
      list.innerHTML = html;
    }

    function assignToMultiview(slotIndex, channelId) {
      if (navigator.vibrate) navigator.vibrate(20);
      send({ action: 'assignMultiview', slotIndex, channelId });
      showToast(`Added to Slot ${slotIndex}`);
    }

    function toggleStreams(eventId) {
      if (expandedStreams.has(eventId)) {
        expandedStreams.delete(eventId);
      } else {
        expandedStreams.add(eventId);
      }
      renderSports(lastSportsEvents);
    }

    function playBackup(sel) {
      const streamId = sel.value;
      if (!streamId) return;
      const name = sel.options[sel.selectedIndex]?.text || 'Channel';
      channelTap(streamId, name);
      sel.value = '';
    }

    /* Multiview Renderer */
    function renderMultiview(mv) {
      lastMultiview = mv;
      const grid = document.getElementById('mv-grid');
      if (!mv) return;

      const btnLayout =
        mv.layout === 'main' ? 'single'
        : mv.layout === 'sbs' || mv.layout === 'pip' ? 'split'
        : mv.layout === '2x2' ? 'quad'
        : mv.layout === 'bigbottom' ? 'triple'
        : null;
      document.querySelectorAll('.mv-layout-btn[data-layout]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.layout === btnLayout);
      });
      // Engine pills: reflect the desktop's current engine (default HLS when
      // the desktop hasn't reported one yet).
      const engine = mv.engine === 'mpv_canvas' ? 'mpv_canvas' : 'hls';
      document.querySelectorAll('.mv-engine-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.engine === engine);
      });

      const mainName = lastNowPlaying?.name || null;
      const slots = mv.slots || [];

      let html = `
        <div class="mv-slot-card mv-main-card">
          <div class="mv-slot-header">
            <span class="mv-slot-num">Main</span>
            <span class="mv-audio-pill">
              <svg style="width:10px; height:10px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
              Now Playing
            </span>
          </div>
          <span class="mv-slot-channel">${esc(mainName || 'Nothing playing')}</span>
        </div>
      `;
      slots.forEach(s => {
        const slotId = s.slot_id || 2;
        const isPickTarget = pickSlot === slotId;
        html += `
          <div class="mv-slot-card ${isPickTarget ? 'picking' : ''}" onclick="pickSlotTarget(${slotId})">
            <div class="mv-slot-header">
              <span class="mv-slot-num">Slot ${slotId}</span>
              ${s.is_active ? `
                <span class="mv-audio-pill">
                  <svg style="width:10px; height:10px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                  Active
                </span>` : ''}
              ${isPickTarget ? `<span class="mv-pick-pill">Picking…</span>` : ''}
            </div>
            <span class="mv-slot-channel">${esc(s.channel_name || 'Empty — tap to add')}</span>
          </div>
        `;
      });
      grid.innerHTML = html;
    }

    function switchLayout(layout) {
      send({ action: 'switchMultiviewLayout', layout });
      showToast(`Layout: ${layout}`);
    }

    function setMultiviewEngine(mode) {
      send({ action: 'setMultiviewEngine', mode });
      document.querySelectorAll('.mv-engine-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.engine === mode);
      });
      showToast(mode === 'hls' ? 'Engine: HLS' : 'Engine: MPV');
    }

    /* Pick a slot, then choose its channel from the Live Guide */
    function pickSlotTarget(slotId) {
      if (navigator.vibrate) navigator.vibrate(15);
      pickSlot = slotId;
      document.getElementById('mv-pick-banner').style.display = 'flex';
      document.getElementById('mv-pick-text').innerText = `Sending to Slot ${slotId} — tap a channel in the Guide or Sports`;
      const indicator = document.getElementById('guide-pick-indicator');
      indicator.innerText = `→ Slot ${slotId}`;
      indicator.style.display = 'inline-block';
      renderMultiview(lastMultiview);
      if (lastSportsEvents) renderSports(lastSportsEvents);
      switchTab('guide');
    }

    function cancelPick() {
      pickSlot = null;
      document.getElementById('mv-pick-banner').style.display = 'none';
      document.getElementById('guide-pick-indicator').style.display = 'none';
      renderMultiview(lastMultiview);
      if (lastSportsEvents) renderSports(lastSportsEvents);
    }

    /* Guide card tap: routes to slot-assign when in pick mode, otherwise plays.
       catId is the guide category the channel was browsed in (omitted for
       sports links and cross-category search results), so the app can sync its
       guide category for ch up/down. */
    function channelTap(channelId, name, catId) {
      if (pickSlot) {
        assignToMultiview(pickSlot, channelId);
        cancelPick();
      } else {
        playChannel(channelId, name, catId);
      }
    }

    document.getElementById('mv-pick-cancel').onclick = () => {
      cancelPick();
    };

    pairRetry.onclick = () => {
      showApp();
      connect();
    };

    if (!token) {
      showPairScreen('missing');
    } else {
      connect();
    }
  </script>

  <!-- Type-into-field modal (search box activated from the remote) -->
  <div class="remote-type-modal" id="remote-type-modal">
    <div class="remote-type-box">
      <div class="remote-type-label" id="remote-type-label">Type your search</div>
      <input
        type="text"
        id="remote-type-input"
        class="remote-type-input"
        placeholder="Type here…"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        inputmode="search"
        oninput="remoteTypeInputChanged()"
        onkeydown="if(event.key==='Enter'){ event.preventDefault(); remoteTypeOk(); }"
      />
      <div class="remote-type-actions">
        <button class="remote-type-btn remote-type-cancel" onpointerdown="remoteTypeCancel(event)">Cancel</button>
        <button class="remote-type-btn remote-type-ok" onpointerdown="remoteTypeOk(event)">OK</button>
      </div>
    </div>
  </div>
</body>
</html>"###;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store, must-revalidate"))
        .header(header::PRAGMA, HeaderValue::from_static("no-cache"))
        .header(header::EXPIRES, HeaderValue::from_static("0"))
        .body(html.to_string())
        .unwrap()
}
