//! The raw, pre-parse message shape.
//!
//! Every ingest source — the live SignalR client, a local recording, or a
//! historical static download — normalizes into a stream of [`RawMessage`]s.
//! Downstream parsing, state-merging, recording, and broadcasting are then
//! identical regardless of source. This is what makes "a session you record
//! replays through the exact same code that rendered it live" true.

use serde::{Deserialize, Serialize};

/// A single update from a data source, before parsing.
///
/// Mirrors one entry of the F1 feed: a topic name and its JSON payload. For
/// compressed topics (`CarData.z`, `Position.z`) the payload here is still the
/// raw (base64 + deflate) string exactly as received; decompression happens in
/// the parser so that recordings stay byte-faithful to the wire.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RawMessage {
    /// Feed topic, e.g. `TimingData`, `CarData.z`, `RaceControlMessages`.
    pub topic: String,

    /// The payload as received. Usually a JSON object/array; for `*.z` topics a
    /// base64 string.
    pub payload: serde_json::Value,

    /// Wall-clock timestamp from the feed, ISO-8601 (e.g. `2023-05-28T13:00:01.123Z`),
    /// when the feed provides one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utc: Option<String>,

    /// Monotonic offset from the start of the session, in milliseconds.
    ///
    /// This is the clock the replay engine seeks against. For live ingest it is
    /// filled from arrival time relative to session start.
    pub offset_ms: u64,
}

impl RawMessage {
    /// True for the deflate-compressed binary topics that need decoding.
    pub fn is_compressed(&self) -> bool {
        self.topic.ends_with(".z")
    }

    /// The logical topic name with any `.z` suffix stripped
    /// (`CarData.z` -> `CarData`).
    pub fn base_topic(&self) -> &str {
        self.topic.strip_suffix(".z").unwrap_or(&self.topic)
    }
}
