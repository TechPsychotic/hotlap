//! Hotlap core: the ingest pipeline shared by every front-end.
//!
//! Data flows: **source** → **parser** → **store** → (**recorder**, **broadcaster**).
//! A source is anything that yields [`hotlap_schema::RawMessage`]s — the live
//! SignalR client, a local recording, or a historical download — so everything
//! downstream is source-agnostic.
//!
pub mod decode;
pub mod engine;
pub mod events;
pub mod expand;
pub mod fallback;
pub mod historical;
pub mod merge;
pub mod parser;
pub mod proxy;
pub mod recording;
pub mod replay;
pub mod timeline;

pub use engine::Engine;
pub use events::{compute_events, SessionEvent};
pub use recording::{Recorder, Recording};
pub use replay::{spawn as spawn_replay, ReplayHandle};
pub use timeline::{compile as compile_timeline, Timeline};

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// Poll the Monterosa live-blog for the live session and apply new commentary
/// posts to the engine. The blog URI is discovered from the `ContentStreams`
/// topic (so this does nothing until that arrives). Used by the live path.
pub fn spawn_commentary_poller(engine: Arc<Engine>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .user_agent("hotlap")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            if let Some(uri) = engine.snapshot().commentary_uri.clone() {
                if let Ok(posts) = historical::fetch_monterosa_posts(&client, &uri).await {
                    for p in posts {
                        // De-dupe by content so re-polling the full history only
                        // adds genuinely new posts.
                        let key = p.payload.to_string();
                        if seen.insert(key) {
                            engine.apply(p);
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(12)).await;
        }
    })
}

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
