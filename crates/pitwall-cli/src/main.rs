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
    /// Attach to the live F1 Live Timing feed.
    Live {
        #[command(flatten)]
        serve: ServeArgs,
        /// Record the raw feed to this directory for later replay.
        #[arg(long, value_name = "DIR")]
        record: Option<PathBuf>,
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

    /// Download and replay a historical session.
    Historical {
        /// Season year, e.g. 2023.
        year: i32,
        /// Event name or round, e.g. "Monaco" or "7".
        event: String,
        /// Session, e.g. "race", "qualifying", "fp1".
        session: String,
        #[command(flatten)]
        serve: ServeArgs,
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
        Command::Live { serve, record } => {
            tracing::info!(?serve.addr, ?record, "live: not yet implemented (P4)");
            not_implemented("live");
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
        } => {
            tracing::info!(year, %event, %session, ?serve.addr, "historical: not yet implemented (P5)");
            not_implemented("historical");
        }
        Command::Tui {
            replay,
            live,
            connect,
        } => {
            tracing::info!(?replay, live, ?connect, "tui: not yet implemented (P3)");
            not_implemented("tui");
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
        if !serve.no_open {
            open_browser(&format!("http://{}", serve.addr));
        }
        pitwall_server::serve(serve.addr, engine, Some(handle.control())).await?;
    } else {
        // Headless: run the replay to completion.
        handle.join().await;
    }
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

fn not_implemented(what: &str) {
    eprintln!("pitwall: `{what}` is scaffolded but not implemented yet — see the roadmap.");
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
