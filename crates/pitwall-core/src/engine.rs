//! The state store and delta broadcaster.
//!
//! [`Engine`] owns the authoritative [`SessionState`]. Feeding it raw messages
//! folds them in (via the [`crate::parser`]) and broadcasts the resulting change
//! as a [`ServerMessage::Update`] merge patch. New subscribers get a
//! [`ServerMessage::Snapshot`] of the current state and then the live patch
//! stream. A seek replaces the whole state and rebroadcasts a fresh snapshot.

use std::sync::{Arc, Mutex};

use pitwall_schema::{RawMessage, ReplayStatus, ServerMessage, SessionState};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::{merge, parser};

/// Shared, thread-safe engine handle.
pub struct Engine {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<ServerMessage>,
}

struct Inner {
    state: SessionState,
    /// Cached JSON serialization of `state`, kept in sync so each tick only
    /// serializes once (for the diff).
    state_json: Value,
    replay: Option<ReplayStatus>,
}

impl Engine {
    /// Create an engine. `channel_capacity` bounds how far a slow client may lag
    /// before it is dropped and must resync.
    pub fn new(channel_capacity: usize) -> Arc<Self> {
        let (tx, _rx) = broadcast::channel(channel_capacity);
        Arc::new(Self {
            inner: Mutex::new(Inner {
                state: SessionState::default(),
                state_json: Value::Object(Default::default()),
                replay: None,
            }),
            tx,
        })
    }

    /// Fold a batch of raw messages in as a single atomic step, broadcasting one
    /// merge patch for the combined change. Batching messages that share an
    /// offset (e.g. simultaneous `CarData` + `Position`) keeps the wire tidy.
    pub fn apply_batch(&self, msgs: &[RawMessage]) {
        if msgs.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        for msg in msgs {
            if let Err(e) = parser::apply(&mut inner.state, msg) {
                tracing::warn!(topic = %msg.topic, error = %e, "failed to parse message");
            }
        }
        let new_json = serde_json::to_value(&inner.state).expect("state serializes");
        let patch = merge::diff(&inner.state_json, &new_json);
        if !patch.is_null() {
            inner.state_json = new_json;
            // A send error just means there are no subscribers; that's fine.
            let _ = self.tx.send(ServerMessage::Update { patch });
        }
    }

    /// Fold a single message in.
    pub fn apply(&self, msg: RawMessage) {
        self.apply_batch(std::slice::from_ref(&msg));
    }

    /// Replace the entire state (used on seek) and rebroadcast a snapshot so all
    /// clients resynchronize.
    pub fn reset_state(&self, state: SessionState) {
        let mut inner = self.inner.lock().unwrap();
        inner.state_json = serde_json::to_value(&state).expect("state serializes");
        inner.state = state;
        let _ = self.tx.send(ServerMessage::Snapshot {
            state: Box::new(inner.state.clone()),
        });
    }

    /// A clone of the current state.
    pub fn snapshot(&self) -> SessionState {
        self.inner.lock().unwrap().state.clone()
    }

    /// Subscribe to the patch stream. Returns the initial snapshot message plus a
    /// receiver; both are produced under one lock so no update is lost between
    /// them.
    pub fn subscribe(&self) -> (ServerMessage, broadcast::Receiver<ServerMessage>) {
        let inner = self.inner.lock().unwrap();
        let rx = self.tx.subscribe();
        let snapshot = ServerMessage::Snapshot {
            state: Box::new(inner.state.clone()),
        };
        (snapshot, rx)
    }

    /// Current replay transport status, if this is a replay/historical source.
    pub fn replay_status(&self) -> Option<ReplayStatus> {
        self.inner.lock().unwrap().replay
    }

    /// Update and broadcast replay transport status.
    pub fn set_replay_status(&self, status: ReplayStatus) {
        self.inner.lock().unwrap().replay = Some(status);
        let _ = self.tx.send(ServerMessage::ReplayStatus { status });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitwall_schema::ServerMessage;
    use serde_json::json;

    fn raw(topic: &str, payload: Value) -> RawMessage {
        RawMessage {
            topic: topic.to_string(),
            payload,
            utc: None,
            offset_ms: 0,
        }
    }

    #[tokio::test]
    async fn subscriber_gets_snapshot_then_patches() {
        let engine = Engine::new(64);
        engine.apply(raw(
            "TrackStatus",
            json!({"Status": "1", "Message": "AllClear"}),
        ));

        let (snapshot, mut rx) = engine.subscribe();
        match snapshot {
            ServerMessage::Snapshot { state } => {
                assert_eq!(state.track_status.status.as_deref(), Some("1"));
            }
            _ => panic!("expected snapshot"),
        }

        engine.apply(raw(
            "TrackStatus",
            json!({"Status": "2", "Message": "Yellow"}),
        ));
        match rx.recv().await.unwrap() {
            ServerMessage::Update { patch } => {
                assert_eq!(
                    patch,
                    json!({"trackStatus": {"status": "2", "message": "Yellow"}})
                );
            }
            _ => panic!("expected update"),
        }
    }

    #[tokio::test]
    async fn no_patch_when_nothing_changes() {
        let engine = Engine::new(64);
        engine.apply(raw("TrackStatus", json!({"Status": "1"})));
        let (_snap, mut rx) = engine.subscribe();
        // Re-applying identical data must not emit a patch.
        engine.apply(raw("TrackStatus", json!({"Status": "1"})));
        assert!(rx.try_recv().is_err());
    }
}
