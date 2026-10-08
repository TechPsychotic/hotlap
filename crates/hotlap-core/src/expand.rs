//! Telemetry densification.
//!
//! Each `CarData` message bundles an `Entries` array of several samples (~4,
//! spaced ~200 ms apart — the native ~5 Hz telemetry rate). The engine folds a
//! whole message in as one state step and broadcasts only the resulting latest
//! value, so clients see just one sample per message (~1 Hz) and telemetry
//! traces look coarse.
//!
//! [`expand_telemetry`] splits each bundled message into one message per entry,
//! timed by the entry's own `Utc`, so the existing pipeline streams every
//! sample and traces render at full resolution.

use crate::decode;
use hotlap_schema::RawMessage;
use serde_json::{json, Value};

/// Split bundled `CarData` messages into one message per `Entries` element.
///
/// Non-`CarData` messages, already-decoded payloads, and single-entry messages
/// pass through unchanged. The result is not sorted; callers sort by offset.
pub fn expand_telemetry(msgs: Vec<RawMessage>) -> Vec<RawMessage> {
    let mut out: Vec<RawMessage> = Vec::with_capacity(msgs.len() * 3);
    for m in msgs {
        if m.base_topic() != "CarData" {
            out.push(m);
            continue;
        }
        // Only the raw (base64 + deflate) string form carries the entry bundle.
        let decoded = match &m.payload {
            Value::String(s) => decode::inflate_z(s).ok(),
            _ => None,
        };
        let entries = decoded
            .as_ref()
            .and_then(|d| d.get("Entries"))
            .and_then(|e| e.as_array());
        let entries = match entries {
            Some(e) if e.len() > 1 => e,
            _ => {
                out.push(m);
                continue;
            }
        };

        // Anchor the last entry at the message offset and place earlier ones
        // before it by their real inter-sample gap, preserving spacing + order.
        let last_ms = entries.last().and_then(entry_ms);
        for entry in entries {
            let offset_ms = match (last_ms, entry_ms(entry)) {
                (Some(last), Some(t)) => m.offset_ms.saturating_sub((last - t).max(0) as u64),
                _ => m.offset_ms,
            };
            out.push(RawMessage {
                topic: m.topic.clone(),
                payload: json!({ "Entries": [entry.clone()] }),
                utc: entry.get("Utc").and_then(|v| v.as_str()).map(String::from),
                offset_ms,
            });
        }
    }
    out
}

/// Parse an entry's `Utc` to epoch milliseconds.
fn entry_ms(entry: &Value) -> Option<i64> {
    let s = entry.get("Utc")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn car_msg(offset_ms: u64, entries: Value) -> RawMessage {
        // Build the compressed string form the way the feed delivers it.
        use base64::Engine as _;
        use flate2::{write::DeflateEncoder, Compression};
        use std::io::Write;
        let raw = serde_json::to_vec(&json!({ "Entries": entries })).unwrap();
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&raw).unwrap();
        let z = enc.finish().unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(z);
        RawMessage {
            topic: "CarData.z".into(),
            payload: Value::String(b64),
            utc: None,
            offset_ms,
        }
    }

    #[test]
    fn splits_entries_into_timed_messages() {
        let entries = json!([
            {"Utc": "2024-12-08T12:00:00.000Z", "Cars": {"1": {"Channels": {"2": 100}}}},
            {"Utc": "2024-12-08T12:00:00.200Z", "Cars": {"1": {"Channels": {"2": 150}}}},
            {"Utc": "2024-12-08T12:00:00.400Z", "Cars": {"1": {"Channels": {"2": 200}}}}
        ]);
        let out = expand_telemetry(vec![car_msg(10_000, entries)]);
        assert_eq!(out.len(), 3);
        // Last entry anchored at the message offset; earlier ones 400/200ms back.
        assert_eq!(out[0].offset_ms, 9_600);
        assert_eq!(out[1].offset_ms, 9_800);
        assert_eq!(out[2].offset_ms, 10_000);
        // Each carries exactly one entry.
        for m in &out {
            assert_eq!(m.payload["Entries"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn passes_other_topics_through() {
        let m = RawMessage {
            topic: "TimingData".into(),
            payload: json!({"Lines": {}}),
            utc: None,
            offset_ms: 5,
        };
        let out = expand_telemetry(vec![m]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].topic, "TimingData");
    }
}
