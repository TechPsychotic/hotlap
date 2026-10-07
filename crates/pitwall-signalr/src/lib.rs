//! Client for the F1 Live Timing SignalR feed.
//!
//! Handshake (classic ASP.NET SignalR, protocol 1.5):
//! 1. `GET /signalr/negotiate?connectionData=[{"name":"Streaming"}]&clientProtocol=1.5`
//!    → a JSON body with `ConnectionToken` (and a load-balancer cookie).
//! 2. Connect `wss://livetiming.formula1.com/signalr/connect?...&transport=webSockets`,
//!    forwarding the cookie.
//! 3. Send `{"H":"Streaming","M":"Subscribe","A":[[<topics>]],"I":1}`.
//!
//! Frames then arrive as either the subscribe response (`{"R":{<topic>:<state>…}}`,
//! the full initial snapshot) or feed updates
//! (`{"M":[{"H":"Streaming","M":"feed","A":[<topic>,<data>,<utc>]}]}`). Each becomes
//! a [`RawMessage`] sent to the caller's channel, so this crate stays decoupled
//! from the core.

use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use futures::{SinkExt, StreamExt};
use pitwall_schema::RawMessage;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{COOKIE, USER_AGENT};
use tokio_tungstenite::tungstenite::Message;

/// The feed topics Pitwall subscribes to.
pub const TOPICS: &[&str] = &[
    "Heartbeat",
    "SessionInfo",
    "SessionData",
    "DriverList",
    "TrackStatus",
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
const CONNECTION_DATA: &str = r#"[{"name":"Streaming"}]"#;
const UA: &str = "Mozilla/5.0 (pitwall) BestHTTP";

/// Connect to the live feed and stream parsed [`RawMessage`]s to `sink` until the
/// socket closes or `sink` is dropped.
///
/// `auth` is an optional `Cookie` header value — since 2025 the live feed requires
/// an authenticated F1 TV session, so pass the session cookie(s) here. The static
/// archive used for recorded/historical replay remains public.
pub async fn run(sink: mpsc::Sender<RawMessage>, auth: Option<String>) -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).build()?;
    let (token, cookie) = negotiate(&http, auth.as_deref()).await?;

    let mut url = reqwest::Url::parse(&format!("{BASE_URL}/signalr/connect"))?;
    url.query_pairs_mut()
        .append_pair("transport", "webSockets")
        .append_pair("clientProtocol", "1.5")
        .append_pair("connectionToken", &token)
        .append_pair("connectionData", CONNECTION_DATA);
    let ws_url = url.to_string().replacen("https://", "wss://", 1);

    // Forward both the negotiate load-balancer cookie and any auth cookie.
    let connect_cookie = [auth, cookie]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("; ");

    let mut request = ws_url
        .into_client_request()
        .context("building ws request")?;
    request.headers_mut().insert(USER_AGENT, UA.parse()?);
    if !connect_cookie.is_empty() {
        request
            .headers_mut()
            .insert(COOKIE, connect_cookie.parse()?);
    }

    tracing::info!("connecting to F1 live timing feed…");
    let (ws, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .context("connecting to signalr websocket")?;
    let (mut write, mut read) = ws.split();

    let subscribe = serde_json::json!({
        "H": "Streaming",
        "M": "Subscribe",
        "A": [TOPICS],
        "I": 1,
    });
    write.send(Message::Text(subscribe.to_string())).await?;
    tracing::info!(topics = TOPICS.len(), "subscribed to live feed");

    let start = Instant::now();
    while let Some(frame) = read.next().await {
        let frame = frame.context("reading ws frame")?;
        let text = match frame {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => break,
            _ => continue,
        };
        for msg in parse_frame(&text, start.elapsed().as_millis() as u64) {
            if sink.send(msg).await.is_err() {
                return Ok(()); // receiver gone
            }
        }
    }
    Ok(())
}

/// Negotiate: returns the connection token and any load-balancer cookie.
async fn negotiate(http: &reqwest::Client, auth: Option<&str>) -> Result<(String, Option<String>)> {
    let mut req = http.get(format!("{BASE_URL}/signalr/negotiate")).query(&[
        ("connectionData", CONNECTION_DATA),
        ("clientProtocol", "1.5"),
    ]);
    if let Some(auth) = auth {
        req = req.header(reqwest::header::COOKIE, auth);
    }
    let resp = req.send().await.context("negotiate request")?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(anyhow!(
            "live feed negotiate returned {status}: the F1 Live Timing feed requires an \
             authenticated F1 TV session (and an active session). Pass your session cookie via \
             `--auth` or $PITWALL_F1_COOKIE. The static archive (recorded/historical replay) \
             remains public."
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
        .get("ConnectionToken")
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("negotiate response missing ConnectionToken"))?
        .to_string();
    Ok((token, cookie))
}

/// Parse one SignalR text frame into zero or more [`RawMessage`]s.
fn parse_frame(text: &str, offset_ms: u64) -> Vec<RawMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();

    // Subscribe response: the full current state of every topic.
    if let Some(initial) = value.get("R").and_then(|r| r.as_object()) {
        for (topic, data) in initial {
            out.push(RawMessage {
                topic: topic.clone(),
                payload: data.clone(),
                utc: None,
                offset_ms: 0,
            });
        }
    }

    // Feed updates.
    if let Some(messages) = value.get("M").and_then(|m| m.as_array()) {
        for item in messages {
            if item.get("M").and_then(|m| m.as_str()) != Some("feed") {
                continue;
            }
            let Some(args) = item.get("A").and_then(|a| a.as_array()) else {
                continue;
            };
            if args.len() < 2 {
                continue;
            }
            let Some(topic) = args[0].as_str() else {
                continue;
            };
            out.push(RawMessage {
                topic: topic.to_string(),
                payload: args[1].clone(),
                utc: args.get(2).and_then(|v| v.as_str()).map(str::to_string),
                offset_ms,
            });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_subscribe_response() {
        let frame = r#"{"R":{"TrackStatus":{"Status":"1","Message":"AllClear"}},"I":"1"}"#;
        let msgs = parse_frame(frame, 0);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].topic, "TrackStatus");
        assert_eq!(msgs[0].offset_ms, 0);
    }

    #[test]
    fn parses_feed_update() {
        let frame = r#"{"M":[{"H":"Streaming","M":"feed","A":["TimingData",{"Lines":{"44":{"Position":"1"}}},"2023-05-28T13:00:01.1Z"]}]}"#;
        let msgs = parse_frame(frame, 1234);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].topic, "TimingData");
        assert_eq!(msgs[0].offset_ms, 1234);
        assert_eq!(msgs[0].utc.as_deref(), Some("2023-05-28T13:00:01.1Z"));
    }

    #[test]
    fn ignores_keepalive() {
        assert!(parse_frame("{}", 0).is_empty());
    }
}
