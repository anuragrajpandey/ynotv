use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};

pub const DEFAULT_REMOTE_PORT: u16 = 11470;

static RUNNING: AtomicBool = AtomicBool::new(false);
static ACTIVE_PORT: Mutex<u16> = Mutex::new(DEFAULT_REMOTE_PORT);
static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct ServeState {
    app: AppHandle,
    outbound: broadcast::Sender<String>,
    clients: Arc<AsyncMutex<HashSet<u64>>>,
}

fn shutdown_slot() -> &'static Mutex<Option<oneshot::Sender<()>>> {
    static S: OnceLock<Mutex<Option<oneshot::Sender<()>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn serve_state_slot() -> &'static Mutex<Option<ServeState>> {
    static S: OnceLock<Mutex<Option<ServeState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServeStatus {
    pub running: bool,
    pub port: u16,
    pub local_ip: String,
    pub remote_url: String,
    pub all_urls: Vec<String>,
    pub connected_clients: usize,
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
pub fn web_serve_status() -> WebServeStatus {
    let running = RUNNING.load(Ordering::Relaxed);
    let port = *ACTIVE_PORT.lock().unwrap_or_else(|e| e.into_inner());
    let ip = get_local_lan_ip();
    let remote_url = format!("http://{}:{}/remote", ip, port);
    let all_urls = get_all_local_ips()
        .into_iter()
        .map(|i| format!("http://{}:{}/remote", i, port))
        .collect();
    WebServeStatus {
        running,
        port,
        local_ip: ip,
        remote_url,
        all_urls,
        connected_clients: 0,
    }
}

#[tauri::command]
pub async fn web_serve_start(app: AppHandle, port: Option<u16>) -> Result<WebServeStatus, String> {
    let target_port = port.unwrap_or(DEFAULT_REMOTE_PORT);

    if RUNNING.load(Ordering::SeqCst) {
        let cur_port = *ACTIVE_PORT.lock().unwrap_or_else(|e| e.into_inner());
        if cur_port == target_port {
            return Ok(web_serve_status());
        }
        web_serve_stop();
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], target_port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            let msg = format!("Failed to bind port {}: {}", target_port, e);
            warn!("[remote-server] {}", msg);
            return Err(msg);
        }
    };

    let (outbound_tx, _) = broadcast::channel::<String>(128);
    let clients = Arc::new(AsyncMutex::new(HashSet::new()));

    let state = ServeState {
        app: app.clone(),
        outbound: outbound_tx,
        clients,
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

    tokio::spawn(async move {
        info!("[remote-server] YNOTV Phone Remote server listening on {}", addr);
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        {
            error!("[remote-server] Server error: {}", e);
        }
        RUNNING.store(false, Ordering::SeqCst);
        info!("[remote-server] Server stopped");
    });

    Ok(web_serve_status())
}

#[tauri::command]
pub fn web_serve_stop() {
    if let Ok(mut slot) = shutdown_slot().lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
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
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_remote_socket(socket, state))
}

async fn handle_remote_socket(socket: WebSocket, state: ServeState) {
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

async fn serve_remote_html() -> impl IntoResponse {
    let html = r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>YNOTV Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; user-select: none; }
    body {
      background: #0d0f14;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      background: #141721;
      border-bottom: 1px solid #232738;
    }
    .logo { font-size: 19px; font-weight: 800; background: linear-gradient(135deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .status-badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: #222738; color: #9ca3af; display: flex; align-items: center; gap: 6px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
    .status-badge.connected .status-dot { background: #10b981; }
    .status-badge.connected { color: #d1fae5; background: rgba(16, 185, 129, 0.15); }

    /* Sections Bar */
    .sections-bar {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 10px 14px;
      background: #10121a;
      scrollbar-width: none;
    }
    .sections-bar::-webkit-scrollbar { display: none; }
    .section-btn {
      flex-shrink: 0;
      background: #1a1e2d;
      border: 1px solid #2a3045;
      color: #e5e7eb;
      font-size: 12.5px;
      font-weight: 600;
      padding: 7px 14px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .section-btn:active { background: #3b82f6; border-color: #3b82f6; }

    /* Main Pad Area */
    .pad-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 12px;
      position: relative;
    }

    .dpad {
      width: 250px;
      height: 250px;
      border-radius: 50%;
      background: #171b26;
      border: 2px solid #252b3d;
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
      transition: color 0.1s, background 0.1s;
    }
    .dpad-btn:active { color: #38bdf8; background: rgba(56, 189, 248, 0.12); }
    .dpad-up { top: 0; left: 75px; width: 100px; height: 75px; border-radius: 125px 125px 0 0; }
    .dpad-down { bottom: 0; left: 75px; width: 100px; height: 75px; border-radius: 0 0 125px 125px; }
    .dpad-left { left: 0; top: 75px; width: 75px; height: 100px; border-radius: 125px 0 0 125px; }
    .dpad-right { right: 0; top: 75px; width: 75px; height: 100px; border-radius: 0 125px 125px 0; }
    .dpad-center {
      position: absolute;
      top: 75px; left: 75px;
      width: 100px; height: 100px;
      border-radius: 50%;
      background: #23293a;
      border: 2px solid #333c52;
      color: #f8fafc;
      font-weight: 700;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 10px rgba(0,0,0,0.3);
    }
    .dpad-center:active { background: #3b82f6; color: white; border-color: #60a5fa; }

    /* Quick Action Row (Back, Search, Fullscreen) */
    .action-row {
      display: flex;
      justify-content: space-around;
      width: 100%;
      max-width: 320px;
      margin-top: 14px;
      gap: 12px;
    }
    .action-btn {
      flex: 1;
      height: 48px;
      background: #171b26;
      border: 1px solid #282f42;
      border-radius: 14px;
      color: #cbd5e1;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.15s;
    }
    .action-btn:active { background: #28334e; color: white; }
    .action-btn.back-btn:active { background: #e11d48; color: white; }

    /* Media Controls Footer */
    footer {
      background: #141721;
      border-top: 1px solid #232738;
      padding: 12px 18px 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .media-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .media-btn {
      height: 44px;
      flex: 1;
      border-radius: 12px;
      background: #1e2333;
      border: 1px solid #2f374e;
      color: #e2e8f0;
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .media-btn:active { background: #3b82f6; color: white; }
    .media-btn.play-btn {
      background: #2563eb;
      color: white;
      border-color: #3b82f6;
      flex: 1.4;
    }
    .media-btn.play-btn:active { background: #1d4ed8; }
  </style>
</head>
<body>
  <header>
    <div class="logo">YNOTV Remote</div>
    <div id="status" class="status-badge">
      <span class="status-dot"></span>
      <span id="status-text">Connecting...</span>
    </div>
  </header>

  <div class="sections-bar">
    <button class="section-btn" onclick="sendView('livetv')">📺 Live TV</button>
    <button class="section-btn" onclick="sendView('guide')">📅 Guide</button>
    <button class="section-btn" onclick="sendView('movies')">🎬 Movies</button>
    <button class="section-btn" onclick="sendView('series')">🍿 Series</button>
    <button class="section-btn" onclick="sendView('sports')">⚽ Sports</button>
    <button class="section-btn" onclick="sendView('calendar')">🗓 Calendar</button>
    <button class="section-btn" onclick="sendView('dvr')">📼 DVR</button>
    <button class="section-btn" onclick="sendView('settings')">⚙️ Settings</button>
  </div>

  <div class="pad-container">
    <div class="dpad">
      <button class="dpad-btn dpad-up" onclick="sendNav('up')">▲</button>
      <button class="dpad-btn dpad-down" onclick="sendNav('down')">▼</button>
      <button class="dpad-btn dpad-left" onclick="sendNav('left')">◀</button>
      <button class="dpad-btn dpad-right" onclick="sendNav('right')">▶</button>
      <button class="dpad-center" onclick="sendNav('select')">OK</button>
    </div>

    <div class="action-row">
      <button class="action-btn back-btn" onclick="sendNav('back')">↩ Back</button>
      <button class="action-btn" onclick="sendAction('search')">🔍 Search</button>
      <button class="action-btn" onclick="sendAction('subtitles')">💬 Subs</button>
      <button class="action-btn" onclick="sendAction('toggle_fullscreen')">⛶ Screen</button>
    </div>
  </div>

  <footer>
    <div class="media-row">
      <button class="media-btn" onclick="sendAction('seek_backward')">⏪ -10s</button>
      <button class="media-btn play-btn" onclick="sendAction('play_pause')">⏯ Play / Pause</button>
      <button class="media-btn" onclick="sendAction('seek_forward')">⏩ +10s</button>
    </div>
    <div class="media-row">
      <button class="media-btn" onclick="sendAction('prev_channel')">⏮ Ch -</button>
      <button class="media-btn" onclick="sendAction('toggle_mute')">🔇 Mute</button>
      <button class="media-btn" onclick="sendAction('next_channel')">⏭ Ch +</button>
    </div>
  </footer>

  <script>
    let ws = null;
    const statusEl = document.getElementById('status');
    const statusTextEl = document.getElementById('status-text');

    function connect() {
      const loc = window.location;
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProto}//${loc.host}/api/remote`;
      
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        statusEl.className = 'status-badge connected';
        statusTextEl.innerText = 'Connected';
      };

      ws.onclose = () => {
        statusEl.className = 'status-badge';
        statusTextEl.innerText = 'Reconnecting...';
        setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    function send(msg) {
      if (navigator.vibrate) navigator.vibrate(20);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }

    function sendNav(key) {
      send({ action: 'nav', key });
    }

    function sendAction(action) {
      send({ action });
    }

    function sendView(view) {
      send({ action: 'openView', view });
    }

    connect();
  </script>
</body>
</html>"#;

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))
        .body(html.to_string())
        .unwrap()
}
