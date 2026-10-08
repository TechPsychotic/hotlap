//! The session hub: owns the shared [`Engine`] and the *current* replay, and can
//! swap sessions at runtime so the web picker can load any session on demand.

use std::path::PathBuf;
use std::sync::Arc;

use hotlap_core::{compute_events, historical, spawn_replay, Engine, ReplayHandle, SessionEvent};
use hotlap_schema::{ReplayControl, SourceKind};
use serde::Serialize;
use tokio::sync::{mpsc, Mutex};

/// Shared session state for the server.
pub struct Hub {
    pub engine: Arc<Engine>,
    cache_dir: Option<PathBuf>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    replay: Option<ReplayHandle>,
    name: Option<String>,
    loading: bool,
    error: Option<String>,
    events: Vec<SessionEvent>,
}

/// What the picker polls while a session loads.
#[derive(Serialize)]
pub struct LoadStatus {
    pub loading: bool,
    pub name: Option<String>,
    pub error: Option<String>,
}

impl Hub {
    /// An empty hub (no session yet — `hotlap serve`).
    pub fn new(engine: Arc<Engine>, cache_dir: Option<PathBuf>) -> Arc<Self> {
        Arc::new(Self {
            engine,
            cache_dir,
            inner: Mutex::new(Inner::default()),
        })
    }

    /// Install a pre-built replay (used by `replay`/`historical`).
    pub async fn set_replay(&self, handle: ReplayHandle, name: String) {
        let mut inner = self.inner.lock().await;
        inner.replay = Some(handle);
        inner.name = Some(name);
    }

    /// Set the timeline events for the current session.
    pub async fn set_events(&self, events: Vec<SessionEvent>) {
        self.inner.lock().await.events = events;
    }

    /// The current session's timeline events.
    pub async fn events(&self) -> Vec<SessionEvent> {
        self.inner.lock().await.events.clone()
    }

    /// The current replay control sender, if any.
    pub async fn control(&self) -> Option<mpsc::Sender<ReplayControl>> {
        self.inner.lock().await.replay.as_ref().map(|h| h.control())
    }

    /// Current load status.
    pub async fn status(&self) -> LoadStatus {
        let inner = self.inner.lock().await;
        LoadStatus {
            loading: inner.loading,
            name: inner.name.clone(),
            error: inner.error.clone(),
        }
    }

    /// Fetch a historical session and make it the current one. Aborts any
    /// running replay and resets the engine so clients resync.
    pub async fn load_historical(
        self: Arc<Self>,
        year: i32,
        event: String,
        session: String,
        car_stride: usize,
        pos_stride: usize,
    ) {
        {
            let mut inner = self.inner.lock().await;
            inner.loading = true;
            inner.error = None;
            if let Some(h) = &inner.replay {
                h.abort();
            }
            inner.replay = None;
            inner.name = None;
            inner.events.clear();
        }
        self.engine.reset_state(Default::default());

        let opts = historical::FetchOptions {
            start_ms: 0,
            end_ms: None,
            car_stride: car_stride.max(1),
            pos_stride: pos_stride.max(1),
            cache_dir: self.cache_dir.clone(),
        };
        match historical::fetch(year, &event, &session, &opts).await {
            Ok(fetched) => {
                self.engine.reset_state(Default::default());
                let events = compute_events(&fetched.recording);
                let handle = spawn_replay(
                    self.engine.clone(),
                    fetched.recording,
                    SourceKind::Historical,
                    1.0,
                    true,
                );
                let mut inner = self.inner.lock().await;
                inner.replay = Some(handle);
                inner.name = Some(fetched.name);
                inner.events = events;
                inner.loading = false;
            }
            Err(e) => {
                tracing::warn!(error = %e, "historical load failed");
                let mut inner = self.inner.lock().await;
                inner.loading = false;
                inner.error = Some(e.to_string());
            }
        }
    }
}
