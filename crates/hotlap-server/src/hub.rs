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
    /// Set when the live-timing archive couldn't be reached (even via proxies)
    /// and a basic Ergast replay is available instead — the web then asks the
    /// user whether to load it rather than silently downgrading.
    fallback_available: bool,
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
#[serde(rename_all = "camelCase")]
pub struct LoadStatus {
    pub loading: bool,
    pub name: Option<String>,
    pub error: Option<String>,
    /// The archive was unreachable but a basic Ergast replay can be loaded if the
    /// user opts in (re-request the load with `fallback: true`).
    pub fallback_available: bool,
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

    /// The historical download cache directory, if configured.
    pub fn cache_dir(&self) -> Option<PathBuf> {
        self.cache_dir.clone()
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
            fallback_available: inner.fallback_available,
        }
    }

    /// Fetch a historical session and make it the current one. Aborts any
    /// running replay and resets the engine so clients resync.
    ///
    /// `use_fallback` selects the source: `false` loads the F1 live-timing
    /// archive (full telemetry) and, if it can't be reached, stops and sets
    /// `fallback_available` so the web can *ask* the user before downgrading.
    /// `true` is the user's confirmation — load the basic Ergast replay directly.
    pub async fn load_historical(
        self: Arc<Self>,
        year: i32,
        event: String,
        session: String,
        car_stride: usize,
        pos_stride: usize,
        use_fallback: bool,
    ) {
        {
            let mut inner = self.inner.lock().await;
            inner.loading = true;
            inner.error = None;
            inner.stop_sources();
            inner.name = None;
            inner.events.clear();
            inner.timeline = None;
            inner.fallback_available = false;
        }
        self.engine.reset_state(Default::default());

        // User confirmed the downgrade: load the basic Ergast replay directly.
        if use_fallback {
            let built = match hotlap_core::fallback::fetch(year, &event).await {
                Ok(fb) => serde_json::to_string(&fb.timeline)
                    .ok()
                    .map(|json| (fb.name, Arc::<str>::from(json))),
                Err(e) => {
                    tracing::warn!(error = %e, "fallback source failed");
                    None
                }
            };
            let mut inner = self.inner.lock().await;
            inner.loading = false;
            match built {
                Some((name, timeline)) => {
                    inner.name = Some(name);
                    inner.timeline = Some(timeline);
                }
                None => inner.error = Some("No fallback data is available for this session.".into()),
            }
            return;
        }

        // Primary source: the F1 live-timing archive (full telemetry, via the
        // proxy resolver). A failure, or a "success" with no actual data (the
        // archive can 401 every stream while still naming the session), means the
        // archive is unreachable — offer the fallback rather than loading it.
        let opts = historical::FetchOptions {
            start_ms: 0,
            end_ms: None,
            car_stride: car_stride.max(1),
            pos_stride: pos_stride.max(1),
            cache_dir: self.cache_dir.clone(),
        };
        let primary = historical::fetch(year, &event, &session, &opts).await;
        let built = match primary {
            Ok(f) if !f.recording.messages.is_empty() => {
                let events = compute_events(&f.recording);
                let tl = hotlap_core::compile_timeline(&f.recording);
                serde_json::to_string(&tl)
                    .ok()
                    .map(|json| (f.name, Arc::<str>::from(json), events))
            }
            Ok(_) => {
                tracing::warn!("live-timing archive returned no data");
                None
            }
            Err(e) => {
                tracing::warn!(error = %e, "live-timing archive load failed");
                None
            }
        };

        let mut inner = self.inner.lock().await;
        inner.loading = false;
        match built {
            Some((name, timeline, events)) => {
                inner.name = Some(name);
                inner.events = events;
                inner.timeline = Some(timeline);
            }
            // Archive unreachable: don't downgrade silently — tell the web a
            // basic replay is available so it can prompt the user.
            None => inner.fallback_available = true,
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
            inner.fallback_available = false;
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
