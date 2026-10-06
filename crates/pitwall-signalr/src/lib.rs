//! Client for the F1 Live Timing SignalR feed.
//!
//! Handshake (classic ASP.NET SignalR, protocol 1.5):
//! 1. `GET /signalr/negotiate?connectionData=[{"name":"Streaming"}]&clientProtocol=1.5`
//!    → `connectionToken`.
//! 2. Connect `wss://livetiming.formula1.com/signalr/connect?...&transport=webSockets`.
//! 3. Send `{"H":"Streaming","M":"Subscribe","A":[[<topics>]],"I":1}`.
//!
//! Implemented in the P4 (live ingest) milestone; this placeholder fixes the
//! crate's public surface so the workspace compiles.

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
