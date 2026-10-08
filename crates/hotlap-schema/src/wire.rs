//! The WebSocket wire protocol between the core and its clients.
//!
//! On connect a client receives a [`ServerMessage::Snapshot`] with the full
//! current [`SessionState`], followed by a stream of [`ServerMessage::Update`]s.
//! Each update carries an RFC 7386 **JSON Merge Patch** over the state tree, so
//! high-rate topics (car telemetry, positions) stay cheap on the wire and the
//! client just deep-merges. Replay clients also send [`ClientMessage`]s to drive
//! the transport (play / pause / seek / speed).

use crate::state::SessionState;
use serde::{Deserialize, Serialize};

/// Where the current data is coming from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    /// Attached to the live F1 feed.
    Live,
    /// Replaying a locally recorded session.
    Replay,
    /// Replaying a downloaded historical session.
    Historical,
}

/// Core → client.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    /// Full state, sent once on connect (and after a seek).
    Snapshot { state: Box<SessionState> },
    /// Incremental RFC 7386 merge patch over [`SessionState`].
    Update { patch: serde_json::Value },
    /// Replay transport state (omitted / ignored for live).
    ReplayStatus { status: ReplayStatus },
    /// A non-fatal error to surface to the user.
    Error { message: String },
}

/// Client → core.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    /// Drive the replay transport.
    ReplayControl { control: ReplayControl },
}

/// A replay transport command.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ReplayControl {
    Play,
    Pause,
    /// Jump to an absolute offset from session start, in milliseconds.
    Seek {
        // Explicit rename: enum-level `rename_all` renames variants, not their
        // struct fields, so spell the wire name out (and keep schemars in sync).
        #[serde(rename = "offsetMs")]
        offset_ms: u64,
    },
    /// Set playback rate (1.0 = real time, 2.0 = double speed, ...).
    SetSpeed {
        speed: f64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_control_uses_camel_case_on_the_wire() {
        let seek = ReplayControl::Seek { offset_ms: 4800 };
        let json = serde_json::to_value(seek).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"action": "seek", "offsetMs": 4800})
        );

        // And it round-trips back from the exact shape clients send.
        let parsed: ReplayControl =
            serde_json::from_value(serde_json::json!({"action": "seek", "offsetMs": 1000}))
                .unwrap();
        assert!(matches!(parsed, ReplayControl::Seek { offset_ms: 1000 }));

        let speed: ReplayControl =
            serde_json::from_value(serde_json::json!({"action": "setSpeed", "speed": 2.0}))
                .unwrap();
        assert!(matches!(speed, ReplayControl::SetSpeed { speed } if speed == 2.0));
    }
}

/// Current transport state for a replay/historical source.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    pub source: SourceKind,
    pub playing: bool,
    pub speed: f64,
    /// Current playhead offset from session start, in milliseconds.
    pub position_ms: u64,
    /// Total session length in milliseconds, if known.
    pub duration_ms: Option<u64>,
}
