//! Client for the F1 Live Timing feed (ASP.NET **Core** SignalR).
//!
//! F1 retired the legacy ASP.NET SignalR hub (`/signalr/`, which now answers
//! 401) in 2025 and moved to ASP.NET Core SignalR at `/signalrcore`. Handshake:
//! 1. `POST /signalrcore/negotiate?negotiateVersion=1` → JSON with a
//!    `connectionToken` (and a load-balancer `AWSALB` cookie that must be carried
//!    to the socket).
//! 2. Connect `wss://livetiming.formula1.com/signalrcore?id=<connectionToken>`,
//!    forwarding that cookie.
//! 3. Send the SignalR-Core handshake `{"protocol":"json","version":1}␞`
//!    (records are terminated by the 0x1e separator), then the Subscribe
//!    invocation `{"target":"Subscribe","arguments":[[<topics>]],"type":1,…}␞`.
//!
//! Frames then arrive as `␞`-delimited records: the Subscribe completion
//! (`{"type":3,"result":{<topic>:<state>…}}`, the full initial snapshot) and feed
//! invocations (`{"type":1,"target":"feed","arguments":[<topic>,<data>,<utc>]}`).
//! Each becomes a [`RawMessage`] sent to the caller's channel.
//!
//! Core timing data (TimingData, TrackStatus, RaceControl, Weather, DriverList…)
//! is public on this endpoint; the premium topics `CarData.z` and `Position.z`
//! still require a valid F1 TV session cookie, passed as `auth`.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use hotlap_schema::RawMessage;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{COOKIE, USER_AGENT};
use tokio_tungstenite::tungstenite::Message;

/// The feed topics Hotlap subscribes to.
pub const TOPICS: &[&str] = &[
    "Heartbeat",
    "SessionInfo",
    "SessionData",
    "DriverList",
    "TrackStatus",
    "SessionStatus",
    "LapCount",
    "ExtrapolatedClock",
    "WeatherData",
    "RaceControlMessages",
    "TeamRadio",
    "TimingData",
    "TimingAppData",
    "TimingStats",
    "CarData.z",
    "Position.z",
];

/// Base URL of the public F1 Live Timing service.
pub const BASE_URL: &str = "https://livetiming.formula1.com";
const UA: &str = "BestHTTP";
/// SignalR record separator (0x1e) terminating each JSON message.
const RS: char = '\u{1e}';

/// Connect to the live feed and stream parsed [`RawMessage`]s to `sink` until the
/// socket closes or `sink` is dropped.
///
/// Core timing/flags/weather/race-control/driver data is public. `auth` is an
/// optional `Cookie` header value — pass an F1 TV session cookie to also receive
/// the gated `CarData.z` / `Position.z` (car telemetry + positions). The static
/// archive used for recorded/historical replay remains fully public.
pub async fn run(sink: mpsc::Sender<RawMessage>, auth: Option<String>) -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).build()?;
    let (token, cookie) = negotiate(&http, auth.as_deref()).await?;

    let mut url = reqwest::Url::parse(&format!("{BASE_URL}/signalrcore"))?;
    url.query_pairs_mut().append_pair("id", &token);
    let ws_url = url.to_string().replacen("https://", "wss://", 1);

    // Forward the negotiate load-balancer cookie (required for affinity) plus any
    // auth cookie.
    let connect_cookie = [auth.clone(), cookie]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("; ");

    let mut request = ws_url.into_client_request().context("building ws request")?;
    request.headers_mut().insert(USER_AGENT, UA.parse()?);
    if !connect_cookie.is_empty() {
        request.headers_mut().insert(COOKIE, connect_cookie.parse()?);
    }

    tracing::info!("connecting to F1 live timing feed (signalrcore)…");
    let (ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .context("connecting to signalr websocket")?;
    let (mut write, mut read) = ws.split();

    // SignalR-Core handshake, then the Subscribe invocation.
    write
        .send(Message::Text(format!("{{\"protocol\":\"json\",\"version\":1}}{RS}")))
        .await?;
    let subscribe = serde_json::json!({
        "arguments": [TOPICS],
        "invocationId": "0",
        "target": "Subscribe",
        "type": 1,
    });
    write.send(Message::Text(format!("{subscribe}{RS}"))).await?;
    tracing::info!(topics = TOPICS.len(), "subscribed to live feed");

    let start = Instant::now();
    let mut keepalive = tokio::time::interval(Duration::from_secs(10));
    keepalive.tick().await; // consume the immediate first tick

    loop {
        tokio::select! {
            maybe = read.next() => {
                let Some(frame) = maybe else { break };
                let text = match frame.context("reading ws frame")? {
                    Message::Text(t) => t,
                    Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => break,
                    _ => continue,
                };
                for record in text.split(RS).filter(|r| !r.is_empty()) {
                    for msg in parse_record(record, start.elapsed().as_millis() as u64) {
                        if sink.send(msg).await.is_err() {
                            return Ok(()); // receiver gone
                        }
                    }
                }
            }
            _ = keepalive.tick() => {
                // SignalR-Core keepalive ping, so the server doesn't drop us in a lull.
                let _ = write.send(Message::Text(format!("{{\"type\":6}}{RS}"))).await;
            }
        }
    }
    Ok(())
}

/// Quick liveness probe: connect, read the initial snapshot, and return the
/// session's display name **iff a session is live right now** (SessionStatus is
/// `Started`/`Aborted`), else `None`. Used to light up the web "Live" button.
pub async fn probe_live(auth: Option<String>) -> Result<Option<String>> {
    let http = reqwest::Client::builder().user_agent(UA).build()?;
    let (token, cookie) = negotiate(&http, auth.as_deref()).await?;

    let mut url = reqwest::Url::parse(&format!("{BASE_URL}/signalrcore"))?;
    url.query_pairs_mut().append_pair("id", &token);
    let ws_url = url.to_string().replacen("https://", "wss://", 1);
    let connect_cookie = [auth, cookie].into_iter().flatten().collect::<Vec<_>>().join("; ");

    let mut request = ws_url.into_client_request().context("building ws request")?;
    request.headers_mut().insert(USER_AGENT, UA.parse()?);
    if !connect_cookie.is_empty() {
        request.headers_mut().insert(COOKIE, connect_cookie.parse()?);
    }
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .context("connecting to signalr websocket")?;
    let (mut write, mut read) = ws.split();

    write
        .send(Message::Text(format!("{{\"protocol\":\"json\",\"version\":1}}{RS}")))
        .await?;
    let sub = serde_json::json!({
        "arguments": [["SessionInfo", "SessionStatus"]],
        "invocationId": "0",
        "target": "Subscribe",
        "type": 1,
    });
    write.send(Message::Text(format!("{sub}{RS}"))).await?;

    let mut status: Option<String> = None;
    let mut name: Option<String> = None;
    loop {
        let frame = match tokio::time::timeout(Duration::from_secs(5), read.next()).await {
            Ok(Some(Ok(f))) => f,
            _ => break,
        };
        let text = match frame {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };
        for record in text.split(RS).filter(|r| !r.is_empty()) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(record) else {
                continue;
            };
            // Topic payloads come from the snapshot (type 3 result) or feed (type 1).
            let pick = |topic: &str| -> Option<serde_json::Value> {
                if v.get("type").and_then(|t| t.as_u64()) == Some(3) {
                    v.get("result").and_then(|r| r.get(topic)).cloned()
                } else if v.get("type").and_then(|t| t.as_u64()) == Some(1)
                    && v.get("target").and_then(|t| t.as_str()) == Some("feed")
                {
                    let args = v.get("arguments").and_then(|a| a.as_array())?;
                    (args.first().and_then(|t| t.as_str()) == Some(topic)).then(|| args[1].clone())
                } else {
                    None
                }
            };
            if let Some(ss) = pick("SessionStatus") {
                if let Some(s) = ss.get("Status").and_then(|s| s.as_str()) {
                    status = Some(s.to_string());
                }
            }
            if let Some(si) = pick("SessionInfo") {
                let meeting = si.get("Meeting").and_then(|m| m.get("Name")).and_then(|n| n.as_str());
                let session = si.get("Name").and_then(|n| n.as_str());
                name = Some(match (meeting, session) {
                    (Some(m), Some(s)) => format!("{m} — {s}"),
                    (Some(m), None) => m.to_string(),
                    (None, Some(s)) => s.to_string(),
                    _ => "Live session".to_string(),
                });
            }
        }
        if status.is_some() && name.is_some() {
            break;
        }
    }
    let live = matches!(status.as_deref(), Some("Started") | Some("Aborted"));
    let _ = write.send(Message::Close(None)).await;
    Ok(live.then(|| name.unwrap_or_else(|| "Live session".to_string())))
}

/// Negotiate: returns the connection token and any load-balancer cookie.
async fn negotiate(http: &reqwest::Client, auth: Option<&str>) -> Result<(String, Option<String>)> {
    let mut req = http
        .post(format!("{BASE_URL}/signalrcore/negotiate"))
        .query(&[("negotiateVersion", "1")]);
    if let Some(auth) = auth {
        req = req.header(reqwest::header::COOKIE, auth);
    }
    let resp = req.send().await.context("negotiate request")?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(anyhow!(
            "live feed negotiate returned {status}. Core timing is normally public; if you asked \
             for the gated CarData/Position topics, pass a valid F1 TV session cookie via `--auth` \
             or $HOTLAP_F1_COOKIE."
        ));
    }
    if !status.is_success() {
        return Err(anyhow!("negotiate failed: HTTP {status}"));
    }

    // Collect any Set-Cookie into a single Cookie header value.
    let cookie = {
        let parts: Vec<String> = resp
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|c| c.split(';').next())
            .map(|c| c.trim().to_string())
            .collect();
        (!parts.is_empty()).then(|| parts.join("; "))
    };

    let body: serde_json::Value = resp.json().await.context("parsing negotiate body")?;
    let token = body
        .get("connectionToken")
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("negotiate response missing connectionToken"))?
        .to_string();
    Ok((token, cookie))
}

/// Parse one SignalR-Core JSON record into zero or more [`RawMessage`]s.
fn parse_record(text: &str, offset_ms: u64) -> Vec<RawMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();

    match value.get("type").and_then(|t| t.as_u64()) {
        // Feed invocation: arguments = [topic, data, utc].
        Some(1) if value.get("target").and_then(|t| t.as_str()) == Some("feed") => {
            if let Some(args) = value.get("arguments").and_then(|a| a.as_array()) {
                if args.len() >= 2 {
                    if let Some(topic) = args[0].as_str() {
                        out.push(RawMessage {
                            topic: topic.to_string(),
                            payload: args[1].clone(),
                            utc: args.get(2).and_then(|v| v.as_str()).map(str::to_string),
                            offset_ms,
                        });
                    }
                }
            }
        }
        // Subscribe completion: the full current state of every topic.
        Some(3) => {
            if let Some(result) = value.get("result").and_then(|r| r.as_object()) {
                for (topic, data) in result {
                    out.push(RawMessage {
                        topic: topic.clone(),
                        payload: data.clone(),
                        utc: None,
                        offset_ms: 0,
                    });
                }
            }
        }
        // type 6 = ping, handshake `{}` (no type), other completions: ignored.
        _ => {}
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_subscribe_completion() {
        let frame = r#"{"type":3,"invocationId":"0","result":{"TrackStatus":{"Status":"1","Message":"AllClear"}}}"#;
        let msgs = parse_record(frame, 999);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].topic, "TrackStatus");
        assert_eq!(msgs[0].offset_ms, 0); // snapshot anchored at 0
    }

    #[test]
    fn parses_feed_invocation() {
        let frame = r#"{"type":1,"target":"feed","arguments":["TimingData",{"Lines":{"44":{"Position":"1"}}},"2023-05-28T13:00:01.1Z"]}"#;
        let msgs = parse_record(frame, 1234);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].topic, "TimingData");
        assert_eq!(msgs[0].offset_ms, 1234);
        assert_eq!(msgs[0].utc.as_deref(), Some("2023-05-28T13:00:01.1Z"));
    }

    #[test]
    fn ignores_ping_and_handshake() {
        assert!(parse_record(r#"{"type":6}"#, 0).is_empty());
        assert!(parse_record("{}", 0).is_empty());
    }
}
