//! Compile a [`Recording`] into the ordered merge-patch stream a client folds to
//! reproduce the whole session locally.
//!
//! This is the same delta sequence the [`crate::engine::Engine`] would broadcast
//! during a replay, but captured up front as one document. The web client
//! downloads it once and runs its own clock over it, so replay is per-tab,
//! seeking can rebuild full history locally, and the server does no per-seek work.

use hotlap_schema::SessionState;
use serde::Serialize;
use serde_json::Value;

use crate::recording::Recording;
use crate::{merge, parser};

/// One step of the session: the patch to apply at virtual time `t` (ms).
#[derive(Serialize)]
pub struct TimelineFrame {
    pub t: u64,
    pub patch: Value,
}

/// A whole session as a foldable patch stream.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub duration_ms: u64,
    pub frames: Vec<TimelineFrame>,
}

/// Fold `recording` into one merge-patch per distinct offset that changed state.
/// Messages sharing an offset are batched into a single frame (as the engine
/// does), keeping the stream tidy for simultaneous `CarData` + `Position`.
pub fn compile(recording: &Recording) -> Timeline {
    let mut state = SessionState::default();
    let mut state_json = Value::Object(Default::default());
    let msgs = &recording.messages;
    let mut frames = Vec::new();
    let mut i = 0;
    while i < msgs.len() {
        let t = msgs[i].offset_ms;
        let start = i;
        while i < msgs.len() && msgs[i].offset_ms == t {
            i += 1;
        }
        for m in &msgs[start..i] {
            let _ = parser::apply(&mut state, m);
        }
        let new_json = serde_json::to_value(&state).expect("state serializes");
        let patch = merge::diff(&state_json, &new_json);
        if !patch.is_null() {
            state_json = new_json;
            frames.push(TimelineFrame { t, patch });
        }
    }
    Timeline {
        duration_ms: recording.duration_ms,
        frames,
    }
}
