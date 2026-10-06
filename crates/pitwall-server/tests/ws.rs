//! End-to-end API test: a real client over a real socket.

use std::time::Duration;

use futures::StreamExt;
use pitwall_core::Engine;
use pitwall_schema::RawMessage;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

fn raw(topic: &str, payload: Value) -> RawMessage {
    RawMessage {
        topic: topic.to_string(),
        payload,
        utc: None,
        offset_ms: 0,
    }
}

/// Spawn the server on an ephemeral port and return its base address.
async fn start(engine: std::sync::Arc<Engine>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = pitwall_server::router(engine, None);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    // Give the accept loop a tick.
    tokio::time::sleep(Duration::from_millis(50)).await;
    format!("127.0.0.1:{}", addr.port())
}

async fn next_json<S>(ws: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("timed out waiting for ws message")
            .expect("stream ended")
            .expect("ws error");
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

#[tokio::test]
async fn ws_delivers_snapshot_then_updates() {
    let engine = Engine::new(1024);
    engine.apply(raw(
        "TrackStatus",
        json!({"Status": "1", "Message": "AllClear"}),
    ));
    let addr = start(engine.clone()).await;

    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();

    // First message is the snapshot.
    let snap = next_json(&mut ws).await;
    assert_eq!(snap["type"], "snapshot");
    assert_eq!(snap["state"]["trackStatus"]["status"], "1");

    // A subsequent change arrives as an update patch.
    engine.apply(raw(
        "TrackStatus",
        json!({"Status": "2", "Message": "Yellow"}),
    ));
    let upd = next_json(&mut ws).await;
    assert_eq!(upd["type"], "update");
    assert_eq!(upd["patch"]["trackStatus"]["status"], "2");

    ws.close(None).await.ok();
}

#[tokio::test]
async fn rest_health_and_state() {
    let engine = Engine::new(1024);
    engine.apply(raw("LapCount", json!({"CurrentLap": 3, "TotalLaps": 78})));
    let addr = start(engine).await;

    let client = reqwest::Client::new();
    let health = client
        .get(format!("http://{addr}/api/health"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(health, "ok");

    let state: Value = client
        .get(format!("http://{addr}/api/state"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(state["lapCount"]["currentLap"], 3);
}
