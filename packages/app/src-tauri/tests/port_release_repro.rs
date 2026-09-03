//! Reproduction harness for the "Phone Remote off→on fails with AddrInUse"
//! bug. Mirrors the exact server pattern in web_server.rs (tokio listener +
//! axum::serve with graceful shutdown) and measures, for several client
//! scenarios, how long the server task takes to exit and whether the port is
//! immediately re-bindable afterwards.
//!
//! Run: cargo test --test port_release_repro -- --nocapture

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(|mut socket: WebSocket| async move {
        while let Some(Ok(msg)) = socket.recv().await {
            if let Message::Text(_) = msg {
                let _ = socket.send(Message::Text("pong".into())).await;
            }
        }
    })
}

fn build_router() -> Router {
    Router::new()
        .route("/", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
}

/// Same as run_phase but the server task is ABORTED instead of gracefully
/// shut down — approximates web_serve_stop's abort path.
async fn run_abort_phase(kind: &str) {
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await.unwrap();
    let router = build_router();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let mut held_client: Option<std::net::TcpStream> = None;
    match kind {
        "no-client" => {}
        "keep-alive-open" => {
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(2))).ok();
            c.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            held_client = Some(c);
        }
        "ws-open" => {
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(2))).ok();
            c.write_all(
                b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            )
            .unwrap();
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            held_client = Some(c);
        }
        other => panic!("unknown kind {other}"),
    }

    let t0 = Instant::now();
    task.abort();
    let task_result = task.await;
    let task_ms = t0.elapsed().as_millis();

    // Try re-binding while the client connection is STILL OPEN.
    let t1 = Instant::now();
    let rebind_open = tokio::time::timeout(Duration::from_secs(2), TcpListener::bind(addr)).await;
    let open_ms = t1.elapsed().as_millis();

    // Now close the client and retry.
    drop(held_client);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let rebind_after_close =
        tokio::time::timeout(Duration::from_secs(5), TcpListener::bind(addr)).await;

    println!(
        "[abort/{kind:16}] task={:?} ({task_ms}ms) | rebind_while_client_open={:<5} ({open_ms}ms) | rebind_after_client_close={}",
        task_result.is_ok(),
        rebind_open.is_ok(),
        rebind_after_close.is_ok()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn abort_leaves_connections_bound() {
    for kind in ["no-client", "keep-alive-open", "ws-open"] {
        run_abort_phase(kind).await;
    }
}

/// The real remote page connects via the machine's LAN IP (that's what the QR
/// shows: http://192.168.x.x:11470/remote), not loopback. Windows bind
/// conflict rules can differ for sockets bound to a specific interface — test
/// whether a LAN-IP connection blocks re-binding the wildcard listener.
async fn lan_ip_phase(kind: &str) {
    // Find this machine's LAN IP (first non-loopback IPv4).
    let lan = std::net::UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|s| {
            s.connect("192.168.1.1:80").ok()?;
            s.local_addr().ok().map(|a| a.ip())
        })
        .expect("no LAN IP");

    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await.unwrap();
    let router = build_router();
    let (tx, rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    let mut held: Option<std::net::TcpStream> = None;
    match kind {
        "lan-keep-alive-open" => {
            let mut c = std::net::TcpStream::connect((lan, port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(2))).ok();
            c.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            held = Some(c);
        }
        other => panic!("unknown kind {other}"),
    }

    // Graceful shutdown, client still open.
    let _ = tx.send(());
    let t0 = Instant::now();
    let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
    println!("graceful exit took {}ms", t0.elapsed().as_millis());

    let t1 = Instant::now();
    let rebind = tokio::time::timeout(Duration::from_secs(2), TcpListener::bind(addr)).await;
    println!(
        "[{kind:24}] client={} rebind_while_open={} ({:?}ms) err={:?}",
        held.is_some(),
        rebind.is_ok(),
        t1.elapsed().as_millis(),
        rebind.err()
    );

    drop(held);
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lan_ip_connections() {
    lan_ip_phase("lan-keep-alive-open").await;
}

/// The REAL launch scenario: many binds to the same port issued CONCURRENTLY
/// (lib.rs spawn + StrictMode double-mount invokes all race). Windows has a
/// known race where simultaneous bind() calls can both succeed. This decides
/// whether the zombie listener is explained by a launch-time duplicate bind.
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_duplicate_binds() {
    for round in 0..5 {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let addr = ("0.0.0.0", port);

        let mut set = tokio::task::JoinSet::new();
        for _ in 0..20 {
            set.spawn(async move { TcpListener::bind(addr).await.is_ok() });
        }
        let mut successes = 0usize;
        while let Some(res) = set.join_next().await {
            if res.unwrap() {
                successes += 1;
            }
        }
        println!("round {round}: {successes}/20 concurrent binds succeeded");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lan_ip_connections_abort() {
    // Same but abort instead of graceful.
    let lan = std::net::UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|s| {
            s.connect("192.168.1.1:80").ok()?;
            s.local_addr().ok().map(|a| a.ip())
        })
        .expect("no LAN IP");
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr).await.unwrap();
    let router = build_router();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let mut c = std::net::TcpStream::connect((lan, port)).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(2))).ok();
    c.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
    let mut buf = [0u8; 4096];
    let _ = c.read(&mut buf);

    task.abort();
    let _ = task.await;
    let t1 = Instant::now();
    let rebind = tokio::time::timeout(Duration::from_secs(2), TcpListener::bind(addr)).await;
    println!(
        "[lan-abort-open       ] rebind_while_open={} ({:?}ms) err={:?}",
        rebind.is_ok(),
        t1.elapsed().as_millis(),
        rebind.err()
    );
    drop(c);
    tokio::time::sleep(Duration::from_millis(300)).await;
}

/// Run one scenario and print the numbers.
async fn run_phase(kind: &str, wildcard: bool) {
    // Pick a free port, then release it.
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);

    let ip: [u8; 4] = if wildcard { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
    let addr = SocketAddr::from((ip, port));
    let listener = TcpListener::bind(addr).await.unwrap();
    let router = build_router();
    let (tx, rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    // A client connection to hold across shutdown (None for the baseline).
    let mut held_client: Option<std::net::TcpStream> = None;

    match kind {
        "no-client" => {}
        "closed-client" => {
            // Request with Connection: close — server closes first, leaving
            // the server side in TIME_WAIT.
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(2))).ok();
            c.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .unwrap();
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            drop(c);
        }
        "keep-alive-open" => {
            // Plain request without Connection: close — idle keep-alive
            // connection stays open across shutdown.
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(2))).ok();
            c.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            held_client = Some(c);
        }
        "ws-open" => {
            // Manual WebSocket handshake; socket held open across shutdown.
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.set_read_timeout(Some(Duration::from_secs(2))).ok();
            c.write_all(
                b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            )
            .unwrap();
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            held_client = Some(c);
        }
        other => panic!("unknown kind {other}"),
    }

    // Trigger graceful shutdown and time how long the task takes to exit.
    let t0 = Instant::now();
    let _ = tx.send(());
    let task_result = tokio::time::timeout(Duration::from_secs(10), task).await;
    let task_ms = t0.elapsed().as_millis();

    // Drop any held client *after* the task has had a chance to unwind.
    drop(held_client);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Can we re-bind immediately?
    let t1 = Instant::now();
    let tokio_rebind = tokio::time::timeout(Duration::from_secs(5), TcpListener::bind(addr)).await;
    let tokio_ms = t1.elapsed().as_millis();
    let std_rebind = std::net::TcpListener::bind(addr);
    let std_ms = Instant::now().duration_since(t1).as_millis();

    println!(
        "[{kind:16}] task_exited={:<5} task_took={task_ms:>4}ms | tokio_rebind={:<5} ({tokio_ms}ms) | std_rebind={} ({std_ms}ms) | err={:?}",
        task_result.is_ok(),
        tokio_rebind.is_ok(),
        std_rebind.is_ok(),
        tokio_rebind.err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn port_release_matrix() {
    for kind in ["no-client", "closed-client", "keep-alive-open", "ws-open"] {
        run_phase(kind, false).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn port_release_matrix_wildcard() {
    for kind in ["no-client", "closed-client", "keep-alive-open", "ws-open"] {
        run_phase(kind, true).await;
    }
}

/// Can two listeners bind the SAME port simultaneously on this platform?
/// If yes, a launch race (lib.rs spawn + frontend mount invoke both reading
/// RUNNING=false) can silently create TWO servers, and web_serve_stop can
/// only stop the last one — leaving the first holding the port forever.
/// NB: tests SEQUENTIAL binds — see concurrent_duplicate_binds for the race.
#[tokio::test(flavor = "multi_thread")]
async fn duplicate_bind_same_port() {
    // Loopback
    {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let l1 = TcpListener::bind(("127.0.0.1", port)).await;
        let l2 = TcpListener::bind(("127.0.0.1", port)).await;
        println!("loopback: first={} second={:?}", l1.is_ok(), l2.is_ok());
        drop(l1);
        drop(l2);
    }
    // Wildcard
    {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let l1 = TcpListener::bind(("0.0.0.0", port)).await;
        let l2 = TcpListener::bind(("0.0.0.0", port)).await;
        println!("wildcard: first={} second={:?}", l1.is_ok(), l2.is_ok());
        drop(l1);
        drop(l2);
    }
    // std listeners (the raw std path, in case tokio differs)
    {
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let l1 = std::net::TcpListener::bind(("0.0.0.0", port));
        let l2 = std::net::TcpListener::bind(("0.0.0.0", port));
        println!("std wildcard: first={} second={:?}", l1.is_ok(), l2.is_ok());
        drop(l1);
        drop(l2);
    }
}
