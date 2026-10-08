//! Derive notable timeline events (start, flags, SC/VSC, red, finish) from a
//! recording, for marking on the replay scrubber.

use serde::Serialize;

use crate::recording::Recording;

/// A notable moment in a session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub offset_ms: u64,
    /// `start` | `green` | `yellow` | `sc` | `vsc` | `red` | `finish`.
    pub kind: String,
    pub label: String,
}

/// Compute the timeline events from a recording's raw messages.
pub fn compute_events(rec: &Recording) -> Vec<SessionEvent> {
    let mut out = Vec::new();
    let mut last_status: Option<String> = None;
    let mut started = false;

    for m in &rec.messages {
        match m.base_topic() {
            "TrackStatus" => {
                let Some(st) = m.payload.get("Status").and_then(|v| v.as_str()) else {
                    continue;
                };
                if last_status.as_deref() == Some(st) {
                    continue;
                }
                let first = last_status.is_none();
                last_status = Some(st.to_string());
                // Skip the opening baseline status.
                if first {
                    continue;
                }
                let (kind, label) = match st {
                    "1" => ("green", "Green"),
                    "2" => ("yellow", "Yellow"),
                    "4" => ("sc", "Safety Car"),
                    "5" => ("red", "Red Flag"),
                    "6" => ("vsc", "Virtual SC"),
                    "7" => ("vsc", "VSC ending"),
                    _ => continue,
                };
                out.push(SessionEvent {
                    offset_ms: m.offset_ms,
                    kind: kind.into(),
                    label: label.into(),
                });
            }
            "SessionStatus" => {
                let Some(st) = m.payload.get("Status").and_then(|v| v.as_str()) else {
                    continue;
                };
                match st {
                    "Started" if !started => {
                        started = true;
                        out.push(SessionEvent {
                            offset_ms: m.offset_ms,
                            kind: "start".into(),
                            label: "Session start".into(),
                        });
                    }
                    "Finished" | "Finalised" | "Ends" => out.push(SessionEvent {
                        offset_ms: m.offset_ms,
                        kind: "finish".into(),
                        label: "Session end".into(),
                    }),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}
