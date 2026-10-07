//! Pitwall core: the ingest pipeline shared by every front-end.
//!
//! Data flows: **source** → **parser** → **store** → (**recorder**, **broadcaster**).
//! A source is anything that yields [`pitwall_schema::RawMessage`]s — the live
//! SignalR client, a local recording, or a historical download — so everything
//! downstream is source-agnostic.
//!
pub mod decode;
pub mod engine;
pub mod events;
pub mod expand;
pub mod historical;
pub mod merge;
pub mod parser;
pub mod recording;
pub mod replay;

pub use engine::Engine;
pub use events::{compute_events, SessionEvent};
pub use recording::{Recorder, Recording};
pub use replay::{spawn as spawn_replay, ReplayHandle};

/// Crate-wide error type.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("decode error: {0}")]
    Decode(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
