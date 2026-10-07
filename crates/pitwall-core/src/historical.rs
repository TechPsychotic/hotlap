//! Fetch a past session from F1's public Live Timing archive and turn it into a
//! [`Recording`] that replays through the normal pipeline.
//!
//! F1 publishes each past session's feed as static `.jsonStream` files under
//! `livetiming.formula1.com/static/<path>` (the same source FastF1 uses); these
//! are public and need no login, unlike the live feed. This is the Rust home of
//! what `tools/export_session.py` does, so `pitwall historical …` fetches,
//! caches, and replays on demand.

use std::path::{Path, PathBuf};

use pitwall_schema::RawMessage;

use crate::recording::Recording;
use crate::{Error, Result};

const STATIC_BASE: &str = "https://livetiming.formula1.com/static/";
const UA: &str = "pitwall-historical";

/// Topics fetched as `.jsonStream` (in addition to the single `SessionInfo.json`).
const STREAM_TOPICS: &[&str] = &[
    "DriverList",
    "SessionData",
    "TrackStatus",
    "LapCount",
    "ExtrapolatedClock",
    "WeatherData",
    "RaceControlMessages",
    "TeamRadio",
    "TimingData",
    "TimingAppData",
    "CarData.z",
    "Position.z",
];
const HEAVY: &[&str] = &["CarData.z", "Position.z"];

/// Windowing / downsampling options for a fetch.
#[derive(Debug, Clone)]
pub struct FetchOptions {
    /// Window start in the original timeline (ms); earlier context collapses to 0.
    pub start_ms: u64,
    /// Window end in the original timeline (ms); `None` = full session.
    pub end_ms: Option<u64>,
    /// Keep every Nth CarData frame (1 = all).
    pub car_stride: usize,
    /// Keep every Nth Position frame (1 = all).
    pub pos_stride: usize,
    /// Directory for the raw-download cache (so re-runs are offline).
    pub cache_dir: Option<PathBuf>,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            start_ms: 0,
            end_ms: None,
            car_stride: 1,
            pos_stride: 1,
            cache_dir: None,
        }
    }
}

/// A fetched session.
pub struct Fetched {
    pub recording: Recording,
    /// Human-readable name, e.g. "Monaco Grand Prix — Qualifying".
    pub name: String,
    /// Archive path, e.g. `2023/2023-05-28_Monaco_Grand_Prix/2023-05-27_Qualifying/`.
    pub path: String,
}

/// Download and assemble a historical session into a [`Recording`].
pub async fn fetch(year: i32, gp: &str, session: &str, opts: &FetchOptions) -> Result<Fetched> {
    let client = reqwest::Client::builder().user_agent(UA).build()?;
    let cache = opts.cache_dir.as_deref();

    let index_txt = get_text(&client, &format!("{STATIC_BASE}{year}/Index.json"), cache).await?;
    let index: serde_json::Value = serde_json::from_str(strip_bom(&index_txt))?;
    let (meeting_name, session_name, path) = find_session(&index, gp, session)?;
    let base = format!("{STATIC_BASE}{path}");
    tracing::info!(%meeting_name, %session_name, %path, "fetching historical session");

    let mut msgs = Vec::new();

    // SessionInfo is a single JSON document.
    if let Ok(info) = get_text(&client, &format!("{base}SessionInfo.json"), cache).await {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(strip_bom(&info)) {
            msgs.push(RawMessage {
                topic: "SessionInfo".into(),
                payload: v,
                utc: None,
                offset_ms: 0,
            });
        }
    }

    for &topic in STREAM_TOPICS {
        let txt = match get_text(&client, &format!("{base}{topic}.jsonStream"), cache).await {
            Ok(t) => t,
            Err(_) => continue, // e.g. LapCount is 403 for qualifying
        };
        let stride = match topic {
            "CarData.z" => opts.car_stride,
            "Position.z" => opts.pos_stride,
            _ => 1,
        };
        let heavy = HEAVY.contains(&topic);
        let mut kept = 0;
        for (i, (offset, payload)) in parse_stream(&txt).into_iter().enumerate() {
            if let Some(end) = opts.end_ms {
                if offset > end {
                    break;
                }
            }
            let new_off = if offset < opts.start_ms {
                if heavy {
                    continue; // drop pre-window telemetry history
                }
                0
            } else {
                offset - opts.start_ms
            };
            if stride > 1 && heavy && i % stride != 0 {
                continue;
            }
            msgs.push(RawMessage {
                topic: topic.into(),
                payload,
                utc: None,
                offset_ms: new_off,
            });
            kept += 1;
        }
        tracing::debug!(topic, kept, "fetched topic");
    }

    // Real live-blog commentary (Monterosa), via ContentStreams. Best-effort;
    // present for 2024+ sessions (2023 and earlier used the now-defunct
    // ScribbleLive, which yields nothing). Posts are time-synced to the replay
    // timeline via a feed Utc+offset anchor.
    let duration_pre = msgs.last().map(|m| m.offset_ms).unwrap_or(0);
    let start_epoch = recording_start_epoch(&msgs);
    match fetch_commentary(&client, &base, cache, start_epoch, duration_pre).await {
        Ok(comm) => {
            tracing::debug!(commentary = comm.len(), "fetched commentary");
            msgs.extend(comm);
        }
        Err(e) => tracing::debug!(error = %e, "no commentary"),
    }

    // Split bundled CarData frames into per-sample messages so telemetry
    // traces stream at the feed's native ~5Hz rather than ~1Hz per message.
    let mut msgs = crate::expand::expand_telemetry(msgs);
    msgs.sort_by_key(|m| m.offset_ms);
    let duration_ms = msgs.last().map(|m| m.offset_ms).unwrap_or(0);
    Ok(Fetched {
        recording: Recording {
            messages: msgs,
            duration_ms,
        },
        name: format!("{meeting_name} — {session_name}"),
        path,
    })
}

/// Years with a public archive Index (2022 is gated).
pub const AVAILABLE_YEARS: &[i32] = &[2018, 2019, 2020, 2021, 2023, 2024, 2025, 2026];

/// One session of an event, for the picker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionEntry {
    pub name: String,
    pub kind: String,
}

/// One event (meeting) with its sessions, for the picker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EventInfo {
    pub name: String,
    pub sessions: Vec<SessionEntry>,
}

/// List the events and sessions in a season, for a picker UI.
pub async fn index(year: i32, cache_dir: Option<&Path>) -> Result<Vec<EventInfo>> {
    let client = reqwest::Client::builder().user_agent(UA).build()?;
    let txt = get_text(
        &client,
        &format!("{STATIC_BASE}{year}/Index.json"),
        cache_dir,
    )
    .await?;
    let index: serde_json::Value = serde_json::from_str(strip_bom(&txt))?;
    let mut events = Vec::new();
    for m in index
        .get("Meetings")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
    {
        let name = m
            .get("Name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let sessions = m
            .get("Sessions")
            .and_then(|s| s.as_array())
            .into_iter()
            .flatten()
            .filter_map(|s| {
                Some(SessionEntry {
                    name: s.get("Name").and_then(|n| n.as_str())?.to_string(),
                    kind: s
                        .get("Type")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
            })
            .collect();
        events.push(EventInfo { name, sessions });
    }
    Ok(events)
}

fn strip_bom(s: &str) -> &str {
    s.trim_start_matches('\u{feff}')
}

/// Fetch F1's live-blog commentary for a session: ContentStreams → the Monterosa
/// commentary URI → that event's `history.json` (a static timeline of posts).
/// Emits synthetic `Commentary` messages at offset 0 (shown as the session's
/// commentary log). Returns an empty vec when no Monterosa stream is present.
async fn fetch_commentary(
    client: &reqwest::Client,
    base: &str,
    cache: Option<&Path>,
    start_epoch: Option<i64>,
    duration_ms: u64,
) -> Result<Vec<RawMessage>> {
    let cs_txt = get_text(client, &format!("{base}ContentStreams.json"), cache).await?;
    let cs: serde_json::Value = serde_json::from_str(strip_bom(&cs_txt))?;
    let uri = cs["Streams"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["Type"] == "Commentary")
        .and_then(|s| s["Uri"].as_str())
        .unwrap_or_default();

    let Some((host, event)) = parse_monterosa_uri(uri) else {
        return Ok(Vec::new());
    };
    if event.len() < 2 {
        return Ok(Vec::new());
    }
    let hist_url = format!(
        "https://{host}/events/{}/{}/history.json",
        &event[..2],
        event
    );
    let hist_txt = get_text(client, &hist_url, cache).await?;
    let hist: serde_json::Value = serde_json::from_str(strip_bom(&hist_txt))?;

    let mut out = Vec::new();
    for post in hist["timeline"].as_array().into_iter().flatten() {
        let all = &post["custom_fields"]["all"];
        let title = all["title"].as_str().unwrap_or("").trim().to_string();
        let text = strip_html(all["text"].as_str().unwrap_or(""));
        if title.is_empty() && text.is_empty() {
            continue; // media-only post (image/video/social)
        }
        // Time-sync to the replay timeline when we have an anchor.
        let offset_ms = match (start_epoch, post["published_at"].as_i64()) {
            (Some(start), Some(published)) => {
                (((published - start) * 1000).max(0) as u64).min(duration_ms)
            }
            _ => 0,
        };
        out.push(RawMessage {
            topic: "Commentary".into(),
            payload: serde_json::json!({
                "Title": title,
                "Text": text,
                "Utc": post["published_at_iso"].as_str().unwrap_or_default(),
            }),
            utc: None,
            offset_ms,
        });
    }
    Ok(out)
}

/// Epoch (seconds) of the recording's t=0, from the first feed message carrying
/// both an absolute `Utc` and a relative offset.
fn recording_start_epoch(msgs: &[RawMessage]) -> Option<i64> {
    for m in msgs {
        let utc = match m.base_topic() {
            "ExtrapolatedClock" => m.payload.get("Utc").and_then(|v| v.as_str()),
            "RaceControlMessages" => m.payload["Messages"]
                .as_array()
                .and_then(|a| a.first())
                .or_else(|| m.payload["Messages"].get("0"))
                .and_then(|m0| m0.get("Utc"))
                .and_then(|v| v.as_str()),
            _ => None,
        };
        if let Some(utc) = utc {
            if let Some(epoch) = iso_epoch(utc) {
                return Some(epoch - (m.offset_ms as i64) / 1000);
            }
        }
    }
    None
}

/// Parse an ISO-8601 timestamp to a Unix epoch (seconds), tolerating a missing
/// timezone (treated as UTC).
fn iso_epoch(s: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Some(ndt.and_utc().timestamp());
        }
    }
    None
}

/// Pull the `h` (CDN host) and `e` (event id) query params from a Monterosa
/// commentary embed URI. `None` for non-Monterosa (e.g. the old ScribbleLive).
fn parse_monterosa_uri(uri: &str) -> Option<(String, String)> {
    let url = reqwest::Url::parse(uri).ok()?;
    let mut host = None;
    let mut event = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "h" => host = Some(v.to_string()),
            "e" => event = Some(v.to_string()),
            _ => {}
        }
    }
    Some((host.unwrap_or_else(|| "cdn.monterosa.cloud".into()), event?))
}

/// Strip HTML tags and decode a few common entities to plain text.
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&rsquo;", "'")
        .replace("&lsquo;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Fetch a URL as text, caching the raw body on disk when `cache` is set.
async fn get_text(client: &reqwest::Client, url: &str, cache: Option<&Path>) -> Result<String> {
    if let Some(dir) = cache {
        let name = url.split("static/").nth(1).unwrap_or(url).replace('/', "_");
        let path = dir.join(name);
        if path.is_file() {
            return Ok(std::fs::read_to_string(&path)?);
        }
        let text = client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        std::fs::create_dir_all(dir)?;
        std::fs::write(&path, &text)?;
        Ok(text)
    } else {
        Ok(client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?)
    }
}

/// Locate a session's archive path in a season Index, preferring an exact
/// session-name match (so "Race" doesn't grab the Sprint, whose Type is "Race").
fn find_session(
    index: &serde_json::Value,
    gp: &str,
    session: &str,
) -> Result<(String, String, String)> {
    let gp = gp.to_lowercase();
    let session = session.to_lowercase();
    let meetings = index.get("Meetings").and_then(|m| m.as_array());
    let Some(meetings) = meetings else {
        return Err(Error::NotFound("season index has no meetings".into()));
    };

    for meeting in meetings {
        let name = meeting.get("Name").and_then(|n| n.as_str()).unwrap_or("");
        if !name.to_lowercase().contains(&gp) {
            continue;
        }
        let sessions = meeting.get("Sessions").and_then(|s| s.as_array());
        let Some(sessions) = sessions else { continue };
        let name_of = |s: &serde_json::Value| {
            s.get("Name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string()
        };
        let type_of = |s: &serde_json::Value| {
            s.get("Type")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string()
        };

        type Matcher<'a> = Box<dyn Fn(&serde_json::Value) -> bool + 'a>;
        let matchers: [Matcher; 4] = [
            Box::new(|s| name_of(s).to_lowercase() == session),
            Box::new(|s| type_of(s).to_lowercase() == session),
            Box::new(|s| name_of(s).to_lowercase().contains(&session)),
            Box::new(|s| type_of(s).to_lowercase().contains(&session)),
        ];
        for matcher in &matchers {
            if let Some(s) = sessions.iter().find(|s| matcher(s)) {
                if let Some(path) = s.get("Path").and_then(|p| p.as_str()) {
                    return Ok((name.to_string(), name_of(s), path.to_string()));
                }
            }
        }
    }
    Err(Error::NotFound(format!(
        "no session matching gp='{gp}' session='{session}'"
    )))
}

/// Parse a `.jsonStream` file: each line is `HH:MM:SS.mmm` + a JSON payload
/// (for `*.z` topics the payload is a base64 string).
fn parse_stream(text: &str) -> Vec<(u64, serde_json::Value)> {
    let mut out = Vec::new();
    for line in strip_bom(text).lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let (offset, rest) = match parse_time_prefix(line) {
            Some(ms) => (ms, &line[12..]),
            None => match line.find(['{', '[', '"']) {
                Some(j) => (0, &line[j..]),
                None => continue,
            },
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
            out.push((offset, v));
        }
    }
    out
}

/// Parse a fixed `HH:MM:SS.mmm` (12-char) prefix into milliseconds.
fn parse_time_prefix(line: &str) -> Option<u64> {
    let b = line.as_bytes();
    if b.len() < 12 || b[2] != b':' || b[5] != b':' || b[8] != b'.' {
        return None;
    }
    let h: u64 = line.get(0..2)?.parse().ok()?;
    let m: u64 = line.get(3..5)?.parse().ok()?;
    let s: u64 = line.get(6..8)?.parse().ok()?;
    let ms: u64 = line.get(9..12)?.parse().ok()?;
    Some(((h * 60 + m) * 60 + s) * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_lines() {
        let txt = "\u{feff}00:00:00.000{\"Status\":\"1\"}\n00:01:02.500{\"Status\":\"2\"}\n";
        let rows = parse_stream(txt);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, 0);
        assert_eq!(rows[1].0, 62_500);
        assert_eq!(rows[1].1["Status"], "2");
    }

    #[test]
    fn finds_session_prefers_exact_name() {
        let index = serde_json::json!({
            "Meetings": [{
                "Name": "São Paulo Grand Prix",
                "Sessions": [
                    {"Name": "Sprint", "Type": "Race", "Path": "p/sprint/"},
                    {"Name": "Race", "Type": "Race", "Path": "p/race/"}
                ]
            }]
        });
        let (_m, s, path) = find_session(&index, "Paulo", "Race").unwrap();
        assert_eq!(s, "Race");
        assert_eq!(path, "p/race/");
    }
}
