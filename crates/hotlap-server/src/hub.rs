//! The session hub: owns the shared [`Engine`] and the *current* replay, and can
//! swap sessions at runtime so the web picker can load any session on demand.

use std::path::PathBuf;
use std::sync::Arc;

use hotlap_core::{compute_events, historical, Engine, ReplayHandle, SessionEvent};
use hotlap_schema::{RawMessage, ReplayControl};
use serde::Serialize;
use tokio::sync::{mpsc, Mutex};
use tokio::task::AbortHandle;

/// Handles for a running live ingestion (feed producer, engine consumer, and the
/// live-blog commentary poller).
struct LiveTask {
    producer: AbortHandle,
    consumer: AbortHandle,
    commentary: AbortHandle,
}

impl LiveTask {
    fn abort(&self) {
        self.producer.abort();
        self.consumer.abort();
        self.commentary.abort();
    }
}

/// Shared session state for the server.
pub struct Hub {
    pub engine: Arc<Engine>,
    cache_dir: Option<PathBuf>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    replay: Option<ReplayHandle>,
    live: Option<LiveTask>,
    name: Option<String>,
    loading: bool,
    error: Option<String>,
    events: Vec<SessionEvent>,
    /// Pre-serialized client-side replay timeline for the loaded session (web
    /// clients fold this locally). `None` for live sources.
    timeline: Option<Arc<str>>,
}

impl Inner {
    /// Stop whatever source is currently running.
    fn stop_sources(&mut self) {
        if let Some(h) = &self.replay {
            h.abort();
        }
        self.replay = None;
        if let Some(l) = self.live.take() {
            l.abort();
        }
    }
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

    /// The loaded session's client-side replay timeline (pre-serialized JSON),
    /// if any. Web clients fetch this and run replay locally.
    pub async fn timeline(&self) -> Option<Arc<str>> {
        self.inner.lock().await.timeline.clone()
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
            inner.stop_sources();
            inner.name = None;
            inner.events.clear();
            inner.timeline = None;
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
                // The web replays the compiled timeline client-side (per tab), so
                // the server runs no replay for it — it just serves the timeline.
                // The recording is dropped once compiled.
                let timeline = {
                    let tl = hotlap_core::compile_timeline(&fetched.recording);
                    serde_json::to_string(&tl).ok().map(Arc::<str>::from)
                };
                let mut inner = self.inner.lock().await;
                inner.name = Some(fetched.name);
                inner.events = events;
                inner.timeline = timeline;
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

    /// Attach the **live** feed as the current source: aborts any running source,
    /// resets the engine, and spawns the SignalR client feeding it. `auth` is an
    /// optional F1 TV cookie for the gated car-telemetry/position topics.
    pub async fn go_live(self: Arc<Self>, auth: Option<String>) {
        {
            let mut inner = self.inner.lock().await;
            inner.loading = true;
            inner.error = None;
            inner.stop_sources();
            inner.name = None;
            inner.events.clear();
            inner.timeline = None;
        }
        self.engine.reset_state(Default::default());

        let (tx, mut rx) = mpsc::channel::<RawMessage>(4096);
        let engine = self.engine.clone();
        let consumer = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                engine.apply(msg);
            }
        });
        let hub = self.clone();
        let producer = tokio::spawn(async move {
            if let Err(e) = hotlap_signalr::run(tx, auth).await {
                tracing::warn!(error = %e, "live feed ended");
                let mut inner = hub.inner.lock().await;
                inner.error = Some(e.to_string());
            }
        });
        // Poll the live-blog (URI arrives via the ContentStreams topic).
        let commentary = hotlap_core::spawn_commentary_poller(self.engine.clone());

        let mut inner = self.inner.lock().await;
        inner.live = Some(LiveTask {
            producer: producer.abort_handle(),
            consumer: consumer.abort_handle(),
            commentary: commentary.abort_handle(),
        });
        inner.name = Some("Live session".to_string());
        inner.loading = false;
    }
}
