//! axum WebSocket + REST API for Pitwall, and host for the web GUI.
//!
//! Endpoints:
//! - `GET /ws` — snapshot + merge-patch stream; accepts `ClientMessage` (replay control) upstream.
//! - `GET /api/health` — liveness.
//! - `GET /api/state` — current `SessionState` snapshot (JSON).
//! - `GET /api/replay/status` — current `ReplayStatus`, or 204.
//! - `POST /api/replay/control` — a `ReplayControl` command.
//! - `GET /*` — the web GUI (embedded in P2); until then a small built-in dev page.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use pitwall_core::Engine;
use pitwall_schema::{ClientMessage, ReplayControl, ServerMessage};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;

/// Default address the local server binds to.
pub const DEFAULT_ADDR: &str = "127.0.0.1:8080";

/// Shared handler state.
#[derive(Clone)]
pub struct AppState {
    engine: Arc<Engine>,
    /// Present only for replay/historical sources; `None` for live.
    replay_ctrl: Option<mpsc::Sender<ReplayControl>>,
}

/// Build the application router.
pub fn router(engine: Arc<Engine>, replay_ctrl: Option<mpsc::Sender<ReplayControl>>) -> Router {
    let state = AppState {
        engine,
        replay_ctrl,
    };
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/state", get(state_handler))
        .route("/api/replay/status", get(replay_status_handler))
        .route("/api/replay/control", post(replay_control_handler))
        .fallback(get(dev_index))
        .with_state(state)
}

/// Serve until the process is shut down.
pub async fn serve(
    addr: SocketAddr,
    engine: Arc<Engine>,
    replay_ctrl: Option<mpsc::Sender<ReplayControl>>,
) -> anyhow::Result<()> {
    let app = router(engine, replay_ctrl);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "pitwall server listening (web GUI + API)");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn state_handler(State(state): State<AppState>) -> Json<pitwall_schema::SessionState> {
    Json(state.engine.snapshot())
}

async fn replay_status_handler(State(state): State<AppState>) -> Response {
    match state.engine.replay_status() {
        Some(status) => Json(status).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn replay_control_handler(
    State(state): State<AppState>,
    Json(control): Json<ReplayControl>,
) -> StatusCode {
    match &state.replay_ctrl {
        Some(tx) => match tx.send(control).await {
            Ok(()) => StatusCode::ACCEPTED,
            Err(_) => StatusCode::SERVICE_UNAVAILABLE,
        },
        None => StatusCode::CONFLICT, // live source: nothing to control
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    // Grab the snapshot and subscribe atomically so no patch is missed.
    let (snapshot, mut rx) = state.engine.subscribe();

    // Send the current replay status (if any) then the snapshot.
    if let Some(status) = state.engine.replay_status() {
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

    // Forward broadcast messages to this client.
    let engine = state.engine.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if send_json(&mut sender, &msg).await.is_err() {
                        break;
                    }
                }
                // Client fell behind: resync with a fresh snapshot and continue.
                Err(RecvError::Lagged(_)) => {
                    let snap = ServerMessage::Snapshot {
                        state: Box::new(engine.snapshot()),
                    };
                    if send_json(&mut sender, &snap).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    // Read client -> server messages (replay control).
    let ctrl = state.replay_ctrl.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::ReplayControl { control }) => {
                        if let Some(tx) = &ctrl {
                            let _ = tx.send(control).await;
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "bad client message"),
                }
            }
        }
    });

    // When either side ends, tear down the other.
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

/// A minimal built-in page for verifying the pipeline in a browser before the
/// real web GUI (P2) is embedded. Connects to `/ws` and renders a live timing
/// list from the snapshot + patches.
async fn dev_index() -> impl IntoResponse {
    Html(include_str!("dev_index.html"))
}
