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
    let html = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
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
      --bg: #0b0d13;
      --card-bg: #131722;
      --card-border: #222738;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.25);
      --text: #f3f4f6;
      --text-muted: #94a3b8;
      --live-red: #ef4444;
      --live-green: #10b981;
    }
    html, body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      touch-action: manipulation;
      overscroll-behavior: none;
    }

    button, input, select, a, .dpad, .dpad-btn, .dpad-center, .action-btn, .media-btn, .section-btn, .nav-tab-btn, .tree-item, .folder-item, .channel-card, .team-link-pill, .mv-layout-btn {
      touch-action: manipulation;
    }
    .dpad, .dpad-btn, .dpad-center {
      touch-action: none !important;
    }

    /* Header */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: #11141d;
      border-bottom: 1px solid var(--card-border);
      flex-shrink: 0;
      z-index: 20;
    }
    .logo {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .status-badge {
      font-size: 11.5px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      background: #1e2333;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; }
    .status-badge.connected .status-dot { background: #10b981; box-shadow: 0 0 8px #10b981; }
    .status-badge.connected { color: #d1fae5; background: rgba(16, 185, 129, 0.12); }

    /* Sticky Now Playing Banner */
    .now-playing-banner {
      background: #161b27;
      border-bottom: 1px solid var(--card-border);
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .np-logo {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      object-fit: contain;
      background: #10121a;
      flex-shrink: 0;
    }
    .np-logo-fallback {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: #232a3d;
      color: #38bdf8;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
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
      font-size: 12px;
      font-weight: 700;
      color: #cbd5e1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .np-title {
      font-size: 13px;
      font-weight: 600;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .np-progress-bar {
      width: 100%;
      height: 3px;
      background: #252d42;
      border-radius: 2px;
      overflow: hidden;
      margin-top: 2px;
    }
    .np-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      width: 0%;
      transition: width 0.3s;
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
      border-radius: 8px;
      background: #202638;
      border: 1px solid #2d364f;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      cursor: pointer;
    }
    .np-btn:active { background: #38bdf8; color: #000; }

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

    /* Bottom Navigation Bar */
    nav.bottom-nav {
      height: 60px;
      background: #11141d;
      border-top: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: space-around;
      flex-shrink: 0;
      z-index: 20;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .nav-tab-btn {
      flex: 1;
      height: 100%;
      background: transparent;
      border: none;
      color: #64748b;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      cursor: pointer;
      transition: color 0.15s;
      position: relative;
    }
    .nav-tab-btn .nav-icon { font-size: 18px; }
    .nav-tab-btn .nav-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.2px; }
    .nav-tab-btn.active { color: #38bdf8; }
    .nav-tab-btn.active .nav-icon { transform: scale(1.1); }
    /* Desktop-view indicator dot: lights up when the app is showing this view */
    .nav-tab-btn.view-active::after {
      content: '';
      position: absolute;
      top: 5px;
      right: calc(50% - 20px);
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.8);
    }

    /* ================= TAB 1: REMOTE ================= */
    .sections-bar {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 10px 14px;
      background: #0f121a;
      scrollbar-width: none;
      flex-shrink: 0;
    }
    .sections-bar::-webkit-scrollbar { display: none; }
    .section-btn {
      flex-shrink: 0;
      background: #1a1f2e;
      border: 1px solid #283045;
      color: #cbd5e1;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 999px;
      cursor: pointer;
    }
    .section-btn:active { background: #38bdf8; color: #000; border-color: #38bdf8; }
    .section-btn.active {
      background: #38bdf8;
      color: #04101c;
      border-color: #7dd3fc;
      font-weight: 700;
    }

    .pad-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 10px;
    }
    .dpad {
      width: 240px;
      height: 240px;
      border-radius: 50%;
      background: #161b28;
      border: 2px solid #252c40;
      position: relative;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5), inset 0 2px 5px rgba(255,255,255,0.05);
    }
    .dpad-btn {
      position: absolute;
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .dpad-btn:active { color: #38bdf8; background: rgba(56, 189, 248, 0.15); }
    .dpad-up { top: 0; left: 70px; width: 100px; height: 70px; border-radius: 120px 120px 0 0; }
    .dpad-down { bottom: 0; left: 70px; width: 100px; height: 70px; border-radius: 0 0 120px 120px; }
    .dpad-left { left: 0; top: 70px; width: 70px; height: 100px; border-radius: 120px 0 0 120px; }
    .dpad-right { right: 0; top: 70px; width: 70px; height: 100px; border-radius: 0 120px 120px 0; }
    .dpad-center {
      position: absolute;
      top: 70px; left: 70px;
      width: 100px; height: 100px;
      border-radius: 50%;
      background: #232b3e;
      border: 2px solid #35405a;
      color: #fff;
      font-weight: 800;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .dpad-center:active { background: #38bdf8; color: #000; border-color: #7dd3fc; }

    .action-row {
      display: flex;
      justify-content: space-around;
      width: 100%;
      max-width: 320px;
      margin-top: 12px;
      gap: 10px;
    }
    .action-btn {
      flex: 1;
      height: 44px;
      background: #171c2a;
      border: 1px solid #283147;
      border-radius: 12px;
      color: #cbd5e1;
      font-weight: 600;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .action-btn:active { background: #2b3652; color: #fff; }
    .action-btn.back-btn:active { background: #e11d48; color: #fff; }

    .media-footer {
      background: #11141d;
      border-top: 1px solid var(--card-border);
      padding: 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .media-row { display: flex; gap: 8px; }
    .media-btn {
      height: 42px;
      flex: 1;
      border-radius: 10px;
      background: #1a2030;
      border: 1px solid #29334a;
      color: #e2e8f0;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .media-btn:active { background: #38bdf8; color: #000; }
    .media-btn.play-btn { background: #2563eb; color: #fff; border-color: #3b82f6; flex: 1.3; }
    .media-btn.play-btn:active { background: #1d4ed8; }

    /* ================= TAB 2: LIVE GUIDE 2-PANE ================= */
    .guide-header-controls {
      padding: 8px 12px;
      background: #11141d;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .sidebar-toggle-btn {
      height: 36px;
      padding: 0 10px;
      background: #1a2030;
      border: 1px solid #28334a;
      border-radius: 8px;
      color: #cbd5e1;
      font-size: 11.5px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .sidebar-toggle-btn:active { background: #38bdf8; color: #000; }
    .search-input-box {
      position: relative;
      flex: 1;
    }
    .search-input {
      width: 100%;
      height: 36px;
      background: #191f2e;
      border: 1px solid #2b354d;
      border-radius: 8px;
      padding: 0 30px 0 10px;
      color: #f8fafc;
      font-size: 13px;
      outline: none;
    }
    .search-input:focus { border-color: #38bdf8; }
    .search-clear-btn {
      position: absolute;
      right: 8px;
      top: 8px;
      background: transparent;
      border: none;
      color: #64748b;
      font-size: 14px;
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
      width: 145px;
      flex-shrink: 0;
      background: #0e1119;
      border-right: 1px solid var(--card-border);
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      display: flex;
      flex-direction: column;
      transition: width 0.2s, margin-left 0.2s;
    }
    .guide-sidebar.collapsed {
      margin-left: -145px;
    }
    .sidebar-tree {
      padding: 6px 4px 20px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .tree-header {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
      padding: 6px 6px 2px;
      margin-top: 4px;
    }
    .tree-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 8px;
      border-radius: 8px;
      font-size: 11.5px;
      font-weight: 600;
      color: #94a3b8;
      cursor: pointer;
      line-height: 1.2;
      gap: 4px;
    }
    .tree-item:active { background: #1a2133; color: #fff; }
    .tree-item.active {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      font-weight: 700;
      border-left: 2.5px solid #38bdf8;
    }
    .tree-item-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .tree-badge {
      font-size: 10px;
      color: #64748b;
      font-weight: 600;
      flex-shrink: 0;
    }
    .tree-source-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 6px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 700;
      color: #cbd5e1;
      cursor: pointer;
      background: #141824;
      margin-top: 4px;
    }
    .tree-source-row:active { background: #1d2538; }
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
    .tree-folder-row:active { background: #192030; color: #fff; }
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
      gap: 1px;
    }

    /* Right Main Channel List */
    .guide-channel-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      background: var(--bg);
    }
    .guide-cat-banner {
      padding: 8px 12px;
      background: #11151f;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .guide-cat-title {
      font-size: 12.5px;
      font-weight: 800;
      color: #f1f5f9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .guide-pick-indicator {
      font-size: 10.5px;
      font-weight: 800;
      color: #04101c;
      background: #38bdf8;
      border-radius: 999px;
      padding: 2px 8px;
      margin-left: 8px;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .guide-cat-count {
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      margin-left: 8px;
      flex-shrink: 0;
    }
    .guide-channel-list {
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .guide-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 9px 10px;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .guide-card:active {
      background: #1d2538;
      border-color: #38bdf8;
      transform: scale(0.99);
    }
    .guide-logo {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      object-fit: contain;
      background: #0d1017;
      flex-shrink: 0;
    }
    .guide-logo-fallback {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: #1e2638;
      color: #38bdf8;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 12px;
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
      font-size: 12px;
      font-weight: 700;
      color: #94a3b8;
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
      font-size: 10.5px;
      color: #64748b;
      margin-top: 1px;
    }
    .guide-card-next {
      font-size: 10.5px;
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
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .sports-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .sports-league-tag {
      font-size: 11px;
      font-weight: 800;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      padding: 2px 8px;
      border-radius: 6px;
      text-transform: uppercase;
    }
    .sports-clock-badge {
      font-size: 11.5px;
      font-weight: 700;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .sports-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--live-red);
      box-shadow: 0 0 6px var(--live-red);
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
      width: 28px;
      height: 28px;
      border-radius: 6px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .sports-team-fallback {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: #252e42;
      color: #cbd5e1;
      font-weight: 700;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .sports-team-name {
      font-size: 14px;
      font-weight: 700;
      color: #f8fafc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sports-team-score {
      font-size: 18px;
      font-weight: 800;
      color: #f8fafc;
    }
    .sports-team-link-pill {
      font-size: 11px;
      font-weight: 600;
      background: #1c2333;
      border: 1px solid #2d374f;
      color: #38bdf8;
      padding: 4px 8px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      margin-left: 6px;
    }
    .sports-team-link-pill:active { background: #38bdf8; color: #000; }

    .sports-streams-accordion {
      border-top: 1px solid #1e2436;
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
      padding: 2px 0;
    }
    .sports-streams-toggle:active { color: #38bdf8; }
    .sports-streams-toggle .chev {
      font-size: 9px;
      color: #64748b;
      transition: transform 0.15s;
    }
    .sports-streams-toggle.open .chev { transform: rotate(90deg); }
    .sports-streams-title {
      font-size: 11px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
    }
    .sports-team-links {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      max-width: 100%;
    }
    .sports-team-links .sports-team-link-pill { margin-left: 0; }
    .sports-link-dropdown {
      font-size: 11px;
      font-weight: 600;
      background: #1c2333;
      border: 1px solid #2d374f;
      color: #94a3b8;
      padding: 4px 6px;
      border-radius: 8px;
      max-width: 120px;
      cursor: pointer;
    }
    .sports-stream-item {
      background: #181e2b;
      border: 1px solid #263045;
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
      padding: 4px 8px;
      border-radius: 6px;
      background: #2563eb;
      color: #fff;
      border: none;
      cursor: pointer;
    }
    .sports-stream-btn:active { background: #1d4ed8; }
    .sports-stream-btn.mv-btn { background: #334155; }
    .sports-stream-btn.mv-btn:active { background: #475569; }

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
      height: 40px;
      border-radius: 10px;
      background: #171c28;
      border: 1px solid #283147;
      color: #cbd5e1;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .mv-layout-btn.active {
      background: #38bdf8;
      color: #04101c;
      border-color: #7dd3fc;
    }
    .mv-grid-preview {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .mv-slot-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 90px;
      min-width: 0;
      cursor: pointer;
    }
    .mv-slot-card.picking {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.3);
    }
    .mv-slot-card.mv-main-card { cursor: default; }
    .mv-pick-pill {
      font-size: 10px;
      font-weight: 700;
      color: #04101c;
      background: #38bdf8;
      border-radius: 999px;
      padding: 2px 8px;
    }
    .mv-pick-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: #16233a;
      border-bottom: 1px solid #2d374f;
      padding: 9px 12px;
      font-size: 12.5px;
      font-weight: 600;
      color: #dbeafe;
      flex-shrink: 0;
      z-index: 15;
    }
    .mv-pick-cancel {
      flex-shrink: 0;
      font-size: 11.5px;
      font-weight: 700;
      color: #fca5a5;
      background: #2a1b22;
      border: 1px solid #4c2634;
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
      font-size: 10.5px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      background: #10b981;
      color: #042f1a;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    /* Toast */
    .toast {
      position: fixed;
      top: 60px;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid #38bdf8;
      color: #f8fafc;
      font-size: 12.5px;
      font-weight: 600;
      padding: 8px 16px;
      border-radius: 999px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s, transform 0.2s;
      z-index: 100;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
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
      background: #0b0d13;
    }
    .pair-card {
      max-width: 420px;
      width: 100%;
      background: #131722;
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 28px 24px;
      text-align: center;
    }
    .pair-icon { font-size: 40px; margin-bottom: 12px; }
    .pair-title { font-size: 22px; font-weight: 800; margin-bottom: 8px; color: #f3f4f6; }
    .pair-desc { font-size: 13.5px; line-height: 1.5; color: #94a3b8; margin-bottom: 18px; }
    .pair-steps {
      text-align: left;
      margin: 0 auto 18px;
      padding-left: 20px;
      color: #cbd5e1;
      font-size: 13.5px;
      line-height: 1.9;
    }
    .pair-retry {
      display: block;
      width: 100%;
      height: 44px;
      background: #2563eb;
      border: none;
      border-radius: 12px;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="app-root" style="display:flex; flex-direction:column; height:100dvh; overflow:hidden;">
    <header>
      <div class="logo">YNOTV Remote</div>
      <div id="status" class="status-badge">
        <span class="status-dot"></span>
        <span id="status-text">Connecting...</span>
      </div>
    </header>

    <!-- Now Playing Mini Bar -->
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
        <button class="np-btn" onpointerdown="sendAction('play_pause', event)">⏯</button>
        <button class="np-btn" onpointerdown="sendAction('toggle_mute', event)">🔇</button>
      </div>
    </div>

    <!-- Shared sections bar: every view reachable from any tab -->
    <div class="sections-bar">
      <button class="section-btn" data-view="livetv" onpointerdown="sendView('livetv', event)">📺 Live TV</button>
      <button class="section-btn" data-view="guide" onpointerdown="sendView('guide', event)">📅 Guide</button>
      <button class="section-btn" data-view="movies" onpointerdown="sendView('movies', event)">🎬 Movies</button>
      <button class="section-btn" data-view="series" onpointerdown="sendView('series', event)">🍿 Series</button>
      <button class="section-btn" data-view="sports" onpointerdown="sendView('sports', event)">⚽ Sports</button>
      <button class="section-btn" data-view="stremio" onpointerdown="sendView('stremio', event)">🎥 Stremio</button>
      <button class="section-btn" data-view="nuvio" onpointerdown="sendView('nuvio', event)">☁️ Nuvio</button>
      <button class="section-btn" data-view="dvr" onpointerdown="sendView('dvr', event)">📼 DVR</button>
      <button class="section-btn" data-view="settings" onpointerdown="sendView('settings', event)">⚙️ Settings</button>
    </div>

    <!-- Tab Container -->
    <div class="tab-content-container">
      <!-- 1. REMOTE TAB -->
      <div id="tab-remote" class="tab-pane active" style="overflow-y:auto;">
        <div class="pad-container">
          <div class="dpad">
            <button class="dpad-btn dpad-up" onpointerdown="sendNav('up', event)">▲</button>
            <button class="dpad-btn dpad-down" onpointerdown="sendNav('down', event)">▼</button>
            <button class="dpad-btn dpad-left" onpointerdown="sendNav('left', event)">◀</button>
            <button class="dpad-btn dpad-right" onpointerdown="sendNav('right', event)">▶</button>
            <button class="dpad-center" onpointerdown="sendNav('select', event)">OK</button>
          </div>

          <div class="action-row">
            <button class="action-btn back-btn" onpointerdown="sendNav('back', event)">↩ Back</button>
            <button class="action-btn" onpointerdown="sendAction('search', event)">🔍 Search</button>
            <button class="action-btn" onpointerdown="sendAction('subtitles', event)">💬 Subs</button>
            <button class="action-btn" onpointerdown="sendAction('toggle_fullscreen', event)">⛶ Screen</button>
          </div>
        </div>

        <div class="media-footer">
          <div class="media-row">
            <button class="media-btn" onpointerdown="sendAction('seek_backward', event)">⏪ -10s</button>
            <button class="media-btn play-btn" onpointerdown="sendAction('play_pause', event)">⏯ Play / Pause</button>
            <button class="media-btn" onpointerdown="sendAction('seek_forward', event)">⏩ +10s</button>
          </div>
          <div class="media-row">
            <button class="media-btn" onpointerdown="sendAction('prev_channel', event)">⏮ Ch -</button>
            <button class="media-btn" onpointerdown="sendAction('toggle_mute', event)">🔇 Mute</button>
            <button class="media-btn" onpointerdown="sendAction('next_channel', event)">⏭ Ch +</button>
          </div>
        </div>
      </div>

      <!-- 2. LIVE GUIDE TAB (2-PANE SIDEBAR TREE) -->
      <div id="tab-guide" class="tab-pane">
        <div class="guide-header-controls">
          <button id="sidebar-toggle" class="sidebar-toggle-btn" onclick="toggleSidebar()">
            <span id="sidebar-toggle-icon">☰</span> Categories
          </button>
          <div class="search-input-box">
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
            <div id="guide-list" class="guide-channel-list">
              <div style="text-align:center; padding:30px; color:#64748b;">Loading channels...</div>
            </div>
          </main>
        </div>
      </div>

      <!-- 3. LIVE SPORTS TAB -->
      <div id="tab-sports" class="tab-pane" style="overflow-y:auto;">
        <div style="padding:10px 14px 4px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:13px; font-weight:700; color:#cbd5e1;">Live & Upcoming Games</span>
          <button class="section-btn" onclick="requestSports()">⟳ Refresh</button>
        </div>
        <div id="sports-list" class="sports-container">
          <div style="text-align:center; padding:30px; color:#64748b;">Loading live scores...</div>
        </div>
      </div>

      <!-- 4. MULTIVIEW TAB -->
      <div id="tab-multiview" class="tab-pane" style="overflow-y:auto;">
        <div class="mv-container">
          <span style="font-size:13px; font-weight:700; color:#cbd5e1;">Multiview Layout</span>
          <div class="mv-layout-row">
            <button class="mv-layout-btn" data-layout="single" onclick="switchLayout('single')">Single</button>
            <button class="mv-layout-btn" data-layout="split" onclick="switchLayout('split')">Split</button>
            <button class="mv-layout-btn" data-layout="quad" onclick="switchLayout('quad')">2x2 Quad</button>
            <button class="mv-layout-btn" data-layout="triple" onclick="switchLayout('triple')">3-Up</button>
          </div>
          <span style="font-size:13px; font-weight:700; color:#cbd5e1; margin-top:8px;">Screens</span>
          <div id="mv-grid" class="mv-grid-preview"></div>
        </div>
      </div>
    </div>

    <!-- Bottom Navigation Bar -->
    <nav class="bottom-nav">
      <button id="nav-remote" class="nav-tab-btn active" onclick="switchTab('remote')">
        <span class="nav-icon">🎮</span>
        <span class="nav-label">Remote</span>
      </button>
      <button id="nav-guide" class="nav-tab-btn" onclick="switchTab('guide')">
        <span class="nav-icon">📺</span>
        <span class="nav-label">Live Guide</span>
      </button>
      <button id="nav-sports" class="nav-tab-btn" onclick="switchTab('sports')">
        <span class="nav-icon">⚽</span>
        <span class="nav-label">Sports</span>
      </button>
      <button id="nav-multiview" class="nav-tab-btn" onclick="switchTab('multiview')">
        <span class="nav-icon">🎛</span>
        <span class="nav-label">Multiview</span>
      </button>
    </nav>
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
      <div class="pair-icon">🔒</div>
      <h1 class="pair-title" id="pair-title">Not paired</h1>
      <p class="pair-desc" id="pair-desc"></p>
      <ol class="pair-steps">
        <li>Open <strong>YNOTV</strong> on your computer</li>
        <li>Go to <strong>Settings → Controllers</strong></li>
        <li>Make sure <strong>Virtual Phone Remote</strong> is enabled</li>
        <li>Scan the <strong>QR code</strong> shown there with this phone's camera</li>
      </ol>
      <button class="pair-retry" id="pair-retry">Try again</button>
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
    // lives in an HTML attribute (e.g. onclick="fn('...')"). Handles both the JS
    // string-literal escaping and the HTML attribute escaping so the value can
    // never break out of either context.
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
    function sendAction(action, e) {
      if (e && e.cancelable) e.preventDefault();
      send({ action });
    }
    function sendView(view, e) {
      if (e && e.cancelable) e.preventDefault();
      send({ action: 'openView', view });
    }

    function updateSections(view) {
      document.querySelectorAll('.section-btn[data-view]').forEach(btn => {
        // The app's guide view covers both the "Live TV" and "Guide" buttons
        const matches =
          btn.dataset.view === view ||
          (view === 'guide' && (btn.dataset.view === 'livetv' || btn.dataset.view === 'guide'));
        btn.classList.toggle('active', matches);
      });

      // Bottom-nav indicator: which nav tab matches the desktop's current view.
      // Uses a separate dot so it can't clash with the "this tab is open" state.
      const navMap = { guide: 'guide', sports: 'sports' };
      const navId = navMap[view] || null;
      document.querySelectorAll('.nav-tab-btn').forEach(btn => {
        btn.classList.toggle('view-active', btn.id === `nav-${navId}`);
      });
    }

    function handleIncomingData(data) {
      if (data.type === 'initialState') {
        if (data.nowPlaying !== undefined) renderNowPlaying(data.nowPlaying);
        if (data.categoryTree) renderCategoryTree(data.categoryTree);
        if (data.multiview) renderMultiview(data.multiview);
        if (data.activeView !== undefined) updateSections(data.activeView);
      } else if (data.type === 'view') {
        updateSections(data.view);
      } else if (data.type === 'nowPlaying') {
        renderNowPlaying(data.nowPlaying);
      } else if (data.type === 'categoryTree') {
        renderCategoryTree(data.categoryTree);
      } else if (data.type === 'guideData') {
        renderGuideChannels(data.channels, data.categoryId);
      } else if (data.type === 'sportsData') {
        renderSports(data.events);
      } else if (data.type === 'multiview') {
        renderMultiview(data.multiview);
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
      clearBtn.style.display = val ? 'block' : 'none';
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

        html += `
          <div class="guide-card" onclick="channelTap('${escAttr(c.stream_id)}', '${escAttr(name)}')">
            ${logoHtml}
            <div class="guide-card-content">
              <div class="guide-card-header">
                <span class="guide-card-ch-name">${esc(name)}</span>
                ${c.channel_num ? `<span style="font-size:10px; color:#64748b;">#${c.channel_num}</span>` : ''}
              </div>
              <span class="guide-card-prog-title">${esc(progTitle)}</span>
              ${progressPct > 0 ? `
                <div class="np-progress-bar" style="margin: 4px 0 2px;">
                  <div class="np-progress-fill" style="width:${progressPct}%;"></div>
                </div>
              ` : ''}
              <span class="guide-prog-time">${c.current_program?.start ? formatTime(c.current_program.start) : ''}${progTime}</span>
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

    function playChannel(channelId, name) {
      if (navigator.vibrate) navigator.vibrate(25);
      send({ action: 'playChannel', channelId });
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

      // When pick mode is active, sports stream buttons assign to the slot too
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

        // Team linked channels: primary pill + a dropdown for backup streams
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
              <button class="sports-team-link-pill" onclick="event.stopPropagation(); channelTap('${escAttr(primary.stream_id)}', '${escAttr(primary.channel_name)}')">📺 ${esc(primary.channel_name)}</button>
              ${backups}
            </div>`;
        }
        const awayLinkHtml = teamLinksHtml(e.away_team);
        const homeLinkHtml = teamLinksHtml(e.home_team);

        // Matched Broadcast Streams — collapsed by default, expandable per game
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
                        <button class="sports-stream-btn mv-btn" onclick="assignToMultiview(0, '${escAttr(s.stream_id)}')">+MV</button>
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

      // Highlight the layout button matching the app's current layout
      const btnLayout =
        mv.layout === 'main' ? 'single'
        : mv.layout === 'sbs' || mv.layout === 'pip' ? 'split'
        : mv.layout === '2x2' ? 'quad'
        : mv.layout === 'bigbottom' ? 'triple'
        : null;
      document.querySelectorAll('.mv-layout-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.layout === btnLayout);
      });

      const mainName = lastNowPlaying?.name || null;
      const slots = mv.slots || [];

      let html = `
        <div class="mv-slot-card mv-main-card">
          <div class="mv-slot-header">
            <span class="mv-slot-num">Main</span>
            <span class="mv-audio-pill">Now Playing</span>
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
              ${s.is_active ? `<span class="mv-audio-pill">Active</span>` : ''}
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

    /* Guide card tap: routes to slot-assign when in pick mode, otherwise plays */
    function channelTap(channelId, name) {
      if (pickSlot) {
        assignToMultiview(pickSlot, channelId);
        cancelPick();
      } else {
        playChannel(channelId, name);
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
</body>
</html>"#;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))
        .body(html.to_string())
        .unwrap()
}
