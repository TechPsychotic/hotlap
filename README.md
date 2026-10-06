# Pitwall

> F1 live, recorded, and historical telemetry — in your browser **and** your terminal.

Pitwall is a local-first Formula 1 telemetry app. A single Rust core ingests F1's
Live Timing feed (live, from a local recording, or from a past session), normalizes
it, and serves it to two highly customizable front-ends:

- **Web GUI** — a window-manager-style dashboard with movable, resizable, dockable
  panels and saveable layouts.
- **TUI** — a keyboard-driven terminal dashboard with resizable tiled panels.

Live, recorded, and historical data all flow through **one pipeline**, so a session
you record replays through the exact same code that rendered it live.

> Status: early development. See [`docs`](docs/) / the plan for the roadmap.

## Architecture

```
 sources ──▶ parser ──▶ state store ──┬─▶ recorder (raw .jsonl)
 (live /                              └─▶ broadcaster ─▶ WS/REST ─▶ Web GUI
  recorded /                                           └────────▶ TUI (in-proc)
  historical)
```

| Crate | Responsibility |
|-------|----------------|
| `pitwall-schema` | Shared data types (Rust → JSON Schema → TS) |
| `pitwall-core` | Ingest adapters, parser, state store, recorder, replay clock, broadcaster |
| `pitwall-signalr` | F1 Live Timing SignalR client |
| `pitwall-server` | axum WebSocket + REST API; serves the embedded web GUI |
| `pitwall-tui` | ratatui terminal UI |
| `pitwall-cli` | The `pitwall` binary |

## Quick start (dev)

```sh
# Replay the bundled sample session and serve the API + web GUI
cargo run -p pitwall-cli -- replay fixtures/sample/ --serve

# Terminal UI against the same sample
cargo run -p pitwall-cli -- tui --replay fixtures/sample/
```

## Data source & legal

Pitwall reads the publicly reachable F1 Live Timing feed, as the FastF1, f1-dash, and
undercut-f1 projects do. It is an unofficial, fan-made tool and is not associated with,
authorized, or endorsed by Formula 1 companies. "F1", "Formula 1" and related marks are
trademarks of Formula One Licensing B.V.

## License

MIT
