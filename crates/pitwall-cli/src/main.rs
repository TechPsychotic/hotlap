//! The `pitwall` CLI.
//!
//! Subcommands wire the core pipeline to a data source and one or more
//! front-ends:
//!   - `live`       attach to the F1 Live Timing feed
//!   - `replay`     replay a local recording
//!   - `historical` download & replay a past session
//!   - `tui`        launch the terminal UI (against live / replay / a remote core)
//!
//! Most actions are stubbed pending their milestone; argument parsing and the
//! overall shape are real so the UX is stable from day one.

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use pitwall_core::{Engine, Recording};
use pitwall_schema::SourceKind;

/// F1 live, recorded, and historical telemetry for your browser and terminal.
#[derive(Debug, Parser)]
#[command(name = "pitwall", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Increase log verbosity (-v, -vv).
    #[arg(short, long, global = true, action = clap::ArgAction::Count)]
    verbose: u8,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the web GUI with a session picker (pick year/event/session in the UI).
    Serve {
        #[command(flatten)]
        serve: ServeArgs,
    },

    /// Attach to the live F1 Live Timing feed.
    Live {
        #[command(flatten)]
        serve: ServeArgs,
        /// Record the raw feed to this directory for later replay.
        #[arg(long, value_name = "DIR")]
        record: Option<PathBuf>,
        /// F1 TV session cookie(s) for the (gated) live feed; or set
        /// `$PITWALL_F1_COOKIE`.
        #[arg(long, value_name = "COOKIE")]
        auth: Option<String>,
    },

    /// Replay a previously recorded session.
    Replay {
        /// Path to a recording directory (containing the session files).
        path: PathBuf,
        #[command(flatten)]
        serve: ServeArgs,
        /// Initial playback speed (1.0 = real time).
        #[arg(long, default_value_t = 1.0)]
        speed: f64,
        /// Launch the TUI instead of (or in addition to) serving the web GUI.
        #[arg(long)]
        tui: bool,
    },

    /// Download and replay a historical session from F1's public archive.
    Historical {
        /// Season year, e.g. 2023.
        year: i32,
        /// Event name substring, e.g. "Monaco".
        event: String,
        /// Session, e.g. "race", "qualifying", "sprint", "practice 1".
        session: String,
        #[command(flatten)]
        serve: ServeArgs,
        /// Keep every Nth car-telemetry / position frame (shrinks big races).
        #[arg(long, default_value_t = 1)]
        car_stride: usize,
        #[arg(long, default_value_t = 1)]
        pos_stride: usize,
        /// Only keep up to this many minutes of the session (0 = full).
        #[arg(long, default_value_t = 0)]
        max_minutes: u64,
        /// Start the window this many minutes into the recording (re-based to 0).
        #[arg(long, default_value_t = 0)]
        start_minutes: u64,
    },

    /// Launch the terminal UI.
    Tui {
        /// Replay a local recording.
        #[arg(long, value_name = "DIR", conflicts_with_all = ["live", "connect"])]
        replay: Option<PathBuf>,
        /// Attach to the live feed.
        #[arg(long, conflicts_with_all = ["replay", "connect"])]
        live: bool,
        /// Attach to a running core over its WebSocket URL.
        #[arg(long, value_name = "URL", conflicts_with_all = ["replay", "live"])]
        connect: Option<String>,
    },
}

/// Shared options for commands that can serve the web GUI / API.
#[derive(Debug, Args)]
struct ServeArgs {
    /// Serve the web GUI + API.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    serve: bool,
    /// Address to bind the server to.
    #[arg(long, default_value = pitwall_server::DEFAULT_ADDR)]
    addr: SocketAddr,
    /// Do not open a browser automatically.
    #[arg(long)]
    no_open: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_tracing(cli.verbose);

    match cli.command {
        Command::Serve { serve } => {
            run_serve(serve).await?;
        }
        Command::Live {
            serve,
            record,
            auth,
        } => {
            let auth = auth.or_else(|| std::env::var("PITWALL_F1_COOKIE").ok());
            run_live(serve, record, auth).await?;
        }
        Command::Replay {
            path,
            serve,
            speed,
            tui,
        } => {
            run_replay(path, serve, speed, tui).await?;
        }
        Command::Historical {
            year,
            event,
            session,
            serve,
            car_stride,
            pos_stride,
            max_minutes,
            start_minutes,
        } => {
            let opts = pitwall_core::historical::FetchOptions {
                start_ms: start_minutes * 60_000,
                end_ms: (max_minutes > 0).then(|| max_minutes * 60_000),
                car_stride: car_stride.max(1),
                pos_stride: pos_stride.max(1),
                cache_dir: historical_cache_dir(),
            };
            run_historical(year, event, session, serve, opts).await?;
        }
        Command::Tui {
            replay,
            live,
            connect,
        } => {
            run_tui(replay, live, connect).await?;
        }
    }

    Ok(())
}

/// Load a recording, start replaying it, and (optionally) serve the GUI/API.
async fn run_replay(path: PathBuf, serve: ServeArgs, speed: f64, tui: bool) -> Result<()> {
    let recording = Recording::load(&path)
        .with_context(|| format!("loading recording from {}", path.display()))?;
    tracing::info!(
        messages = recording.messages.len(),
        duration_ms = recording.duration_ms,
        "loaded recording"
    );

    let engine = Engine::new(4096);
    let handle = pitwall_core::spawn_replay(
        engine.clone(),
        recording,
        SourceKind::Replay,
        speed,
        /* autoplay */ true,
    );

    if tui {
        // P3 wires the TUI; for now keep serving so the session is still viewable.
        eprintln!("pitwall: TUI not implemented yet (P3); continuing with the web GUI.");
    }

    if serve.serve {
        let hub = pitwall_server::Hub::new(engine, historical_cache_dir());
        hub.set_replay(handle, path.display().to_string()).await;
        if !serve.no_open {
            open_browser(&format!("http://{}", serve.addr));
        }
        pitwall_server::serve(serve.addr, hub).await?;
    } else {
        // Headless: run the replay to completion.
        handle.join().await;
    }
    Ok(())
}

/// Serve the web GUI with an empty session picker.
async fn run_serve(serve: ServeArgs) -> Result<()> {
    let engine = Engine::new(4096);
    let hub = pitwall_server::Hub::new(engine, historical_cache_dir());
    if !serve.no_open {
        open_browser(&format!("http://{}", serve.addr));
    }
    pitwall_server::serve(serve.addr, hub).await
}

/// Cache directory for raw historical downloads.
fn historical_cache_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "pitwall").map(|p| p.cache_dir().join("historical"))
}

/// Download a historical session and replay it (optionally serving the UIs).
async fn run_historical(
    year: i32,
    event: String,
    session: String,
    serve: ServeArgs,
    opts: pitwall_core::historical::FetchOptions,
) -> Result<()> {
    let fetched = pitwall_core::historical::fetch(year, &event, &session, &opts)
        .await
        .with_context(|| format!("fetching {year} {event} {session}"))?;
    tracing::info!(
        name = %fetched.name,
        messages = fetched.recording.messages.len(),
        duration_ms = fetched.recording.duration_ms,
        "loaded historical session"
    );

    let engine = Engine::new(4096);
    let handle = pitwall_core::spawn_replay(
        engine.clone(),
        fetched.recording,
        SourceKind::Historical,
        1.0,
        true,
    );
    if serve.serve {
        let hub = pitwall_server::Hub::new(engine, historical_cache_dir());
        hub.set_replay(handle, fetched.name).await;
        if !serve.no_open {
            open_browser(&format!("http://{}", serve.addr));
        }
        pitwall_server::serve(serve.addr, hub).await?;
    } else {
        handle.join().await;
    }
    Ok(())
}

/// Attach to the live F1 feed: ingest → engine (+ optional recorder) → serve.
async fn run_live(serve: ServeArgs, record: Option<PathBuf>, auth: Option<String>) -> Result<()> {
    let engine = Engine::new(4096);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<pitwall_schema::RawMessage>(2048);

    let mut recorder = match record {
        Some(dir) => Some(
            pitwall_core::Recorder::create(&dir)
                .with_context(|| format!("creating recording in {}", dir.display()))?,
        ),
        None => None,
    };
    if recorder.is_some() {
        tracing::info!("recording live feed for later replay");
    }

    // Feed incoming raw messages into the engine and (optionally) the recording.
    let engine_feed = engine.clone();
    tokio::spawn(async move {
        while let Some(raw) = rx.recv().await {
            engine_feed.apply(raw.clone());
            if let Some(r) = recorder.as_mut() {
                if r.record(&raw).and_then(|_| r.flush()).is_err() {
                    tracing::warn!("failed to write recording");
                }
            }
        }
    });

    // Drive the live SignalR client.
    let signalr = tokio::spawn(async move {
        if let Err(e) = pitwall_signalr::run(tx, auth).await {
            tracing::error!(error = %e, "live feed ended");
        }
    });

    if serve.serve {
        let hub = pitwall_server::Hub::new(engine, historical_cache_dir());
        if !serve.no_open {
            open_browser(&format!("http://{}", serve.addr));
        }
        pitwall_server::serve(serve.addr, hub).await?;
    } else {
        let _ = signalr.await;
    }
    Ok(())
}

/// Launch the terminal UI. Currently drives an in-process replay.
async fn run_tui(replay: Option<PathBuf>, live: bool, connect: Option<String>) -> Result<()> {
    if live || connect.is_some() {
        eprintln!("pitwall: `tui --live/--connect` not implemented yet; use `--replay <dir>`.");
        return Ok(());
    }
    let Some(path) = replay else {
        eprintln!("pitwall: `tui` currently requires `--replay <dir>`.");
        return Ok(());
    };
    let recording = Recording::load(&path)
        .with_context(|| format!("loading recording from {}", path.display()))?;
    let engine = Engine::new(4096);
    let handle =
        pitwall_core::spawn_replay(engine.clone(), recording, SourceKind::Replay, 1.0, true);
    let ctrl = handle.control();
    let engine2 = engine.clone();
    tokio::task::spawn_blocking(move || pitwall_tui::run(engine2, Some(ctrl))).await??;
    Ok(())
}

/// Best-effort: open the given URL in the user's browser. Never fatal.
fn open_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    match std::process::Command::new(opener).arg(url).spawn() {
        Ok(_) => tracing::info!(%url, "opened browser"),
        Err(e) => tracing::debug!(%url, error = %e, "could not open browser automatically"),
    }
}

fn init_tracing(verbose: u8) {
    use tracing_subscriber::{fmt, EnvFilter};
    let default = match verbose {
        0 => "info",
        1 => "debug",
        _ => "trace",
    };
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("pitwall={default},{default}")));
    fmt().with_env_filter(filter).with_target(false).init();
}
