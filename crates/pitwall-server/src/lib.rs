//! axum WebSocket + REST API for Pitwall, and host for the web GUI.
//!
//! Endpoints:
//! - `GET /ws` — snapshot + merge-patch stream; accepts `ClientMessage` (replay control) upstream.
//! - `GET /api/health` — liveness.
//! - `GET /api/state` — current `SessionState` snapshot (JSON).
//! - `GET /api/replay/status` — current `ReplayStatus`, or 204.
//! - `POST /api/replay/control` — a `ReplayControl` command.
//! - `GET /api/years` — seasons with a public archive.
//! - `GET /api/index/:year` — events + sessions for the picker.
//! - `POST /api/session/load` — load a historical session at runtime.
//! - `GET /api/session/status` — load progress.
//! - `GET /*` — the web GUI (built), else a small built-in dev page.

mod hub;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use pitwall_core::historical;
use pitwall_schema::{ClientMessage, ReplayControl, ServerMessage};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tower_http::services::{ServeDir, ServeFile};

pub use hub::Hub;

/// Default address the local server binds to.
pub const DEFAULT_ADDR: &str = "127.0.0.1:8080";

/// Shared handler state.
#[derive(Clone)]
struct AppState {
    hub: Arc<Hub>,
}

/// Build the application router around a [`Hub`].
pub fn router(hub: Arc<Hub>) -> Router {
    let state = AppState { hub };
    let api = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/state", get(state_handler))
        .route("/api/replay/status", get(replay_status_handler))
        .route("/api/replay/control", post(replay_control_handler))
        .route("/api/years", get(years_handler))
        .route("/api/index/:year", get(index_handler))
        .route("/api/session/load", post(load_handler))
        .route("/api/session/status", get(session_status_handler))
        .route("/api/events", get(events_handler))
        .with_state(state);

    match find_web_dir() {
        Some(dir) => {
            let index = dir.join("index.html");
            let serve = ServeDir::new(&dir).not_found_service(ServeFile::new(index));
            tracing::info!(dir = %dir.display(), "serving web GUI from disk");
            api.fallback_service(serve)
        }
        None => {
            tracing::info!("web GUI build not found; serving built-in dev page");
            api.fallback(get(dev_index))
        }
    }
}

/// Locate the web GUI build. Checks `$PITWALL_WEB_DIR`, then the workspace
/// `web/dist` relative to this crate (so `cargo run` finds a fresh build).
fn find_web_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PITWALL_WEB_DIR") {
        let p = PathBuf::from(dir);
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    if workspace.join("index.html").is_file() {
        return Some(workspace);
    }
    None
}

/// Serve until the process is shut down.
pub async fn serve(addr: SocketAddr, hub: Arc<Hub>) -> anyhow::Result<()> {
    let app = router(hub);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "pitwall server listening (web GUI + API)");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn state_handler(State(state): State<AppState>) -> Json<pitwall_schema::SessionState> {
    Json(state.hub.engine.snapshot())
}

async fn replay_status_handler(State(state): State<AppState>) -> Response {
    match state.hub.engine.replay_status() {
        Some(status) => Json(status).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn replay_control_handler(
    State(state): State<AppState>,
    Json(control): Json<ReplayControl>,
) -> StatusCode {
    match state.hub.control().await {
        Some(tx) => match tx.send(control).await {
            Ok(()) => StatusCode::ACCEPTED,
            Err(_) => StatusCode::SERVICE_UNAVAILABLE,
        },
        None => StatusCode::CONFLICT, // live source / nothing loaded
    }
}

async fn years_handler() -> Json<&'static [i32]> {
    Json(historical::AVAILABLE_YEARS)
}

async fn index_handler(Path(year): Path<i32>) -> Response {
    match historical::index(year, None).await {
        Ok(events) => Json(events).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct LoadRequest {
    year: i32,
    event: String,
    session: String,
    #[serde(default)]
    car_stride: Option<usize>,
    #[serde(default)]
    pos_stride: Option<usize>,
}

async fn load_handler(State(state): State<AppState>, Json(req): Json<LoadRequest>) -> StatusCode {
    let hub = state.hub.clone();
    tokio::spawn(hub.load_historical(
        req.year,
        req.event,
        req.session,
        req.car_stride.unwrap_or(1),
        req.pos_stride.unwrap_or(1),
    ));
    StatusCode::ACCEPTED
}

async fn session_status_handler(State(state): State<AppState>) -> Json<hub::LoadStatus> {
    Json(state.hub.status().await)
}

async fn events_handler(State(state): State<AppState>) -> Json<Vec<pitwall_core::SessionEvent>> {
    Json(state.hub.events().await)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let engine = state.hub.engine.clone();

    // Grab the snapshot and subscribe atomically so no patch is missed.
    let (snapshot, mut rx) = engine.subscribe();

    if let Some(status) = engine.replay_status() {
        if send_json(&mut sender, &ServerMessage::ReplayStatus { status })
            .await
            .is_err()
        {
            return;
        }
    }
    if send_json(&mut sender, &snapshot).await.is_err() {
        return;
    }

    let engine_fwd = engine.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if send_json(&mut sender, &msg).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    let snap = ServerMessage::Snapshot {
                        state: Box::new(engine_fwd.snapshot()),
                    };
                    if send_json(&mut sender, &snap).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    // Read client -> server messages (replay control), routed to the current hub.
    let hub = state.hub.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::ReplayControl { control }) => {
                        if let Some(tx) = hub.control().await {
                            let _ = tx.send(control).await;
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "bad client message"),
                }
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }
}

async fn send_json(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    msg: &ServerMessage,
) -> Result<(), ()> {
    let text = serde_json::to_string(msg).map_err(|_| ())?;
    sender.send(Message::Text(text)).await.map_err(|_| ())
}

/// A minimal built-in page shown only when no web build is present.
async fn dev_index() -> impl IntoResponse {
    Html(include_str!("dev_index.html"))
}
