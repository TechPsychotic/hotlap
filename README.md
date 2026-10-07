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

## Quick start

```sh
# 1. Build the web GUI once (outputs web/dist, which the core serves)
cd web && npm install && npm run build && cd ..

# 2. Replay the bundled real session; opens the dashboard in your browser
cargo run -p pitwall-cli -- replay fixtures/monaco-2023-quali/
```

Open <http://127.0.0.1:8080>. Windows **float, overlap, move, and resize** like a
desktop; use the **taskbar** to open/minimize them, and the transport bar to
play / pause / seek / change speed. The layout is remembered per browser.

Or start with an empty **session picker** and choose any season / event / session
(practices included) from the dropdowns — it fetches and loads on the fly:

```sh
cargo run -p pitwall-cli -- serve
```

`fixtures/monaco-2023-quali/` is a real slice of the 2023 Monaco GP qualifying
(Q1 flying laps, incl. the yellow/red flags), exported with `tools/export_session.py`.
`fixtures/sample/` is a tiny hand-authored one used by tests.

### Any past session, on demand

Pitwall reads F1's archived Live Timing `.jsonStream` files directly (the same
source FastF1 uses) — no F1 TV login needed for past public sessions. Fetch,
cache, and replay any past session in one command:

```sh
cargo run -p pitwall-cli -- historical 2023 Silverstone Race
# big race? downsample telemetry: --car-stride 3 --pos-stride 3
# or window it:                   --start-minutes 20 --max-minutes 50
```

The raw download is cached under your OS cache dir, so re-runs are offline. The
standalone `tools/export_session.py` writes the same format to a directory if you
prefer a saved fixture.

> Live car positions are gated behind F1 TV; recorded/historical positions are
> public, so the Track Details map works on exported sessions.

### Live timing

```sh
pitwall live                       # serves both UIs off the live feed
pitwall live --record data/my-session   # also save it for replay later
```

Since 2025 the live SignalR feed requires an **authenticated F1 TV session**, so
pass your session cookie(s) with `--auth "<cookie>"` or `$PITWALL_F1_COOKIE`
(and there must be a session live). The protocol client, recorder, and both UIs
are implemented; only the feed itself is gated. The **static archive** used for
`replay`/historical remains public and needs no login.

### Web dev loop

```sh
# Terminal 1 — core serving the API + WebSocket
cargo run -p pitwall-cli -- replay fixtures/monaco-2023-quali/ --no-open

# Terminal 2 — Vite dev server (HMR), proxies /api + /ws to the core
cd web && npm run dev     # http://127.0.0.1:5173
```

The web's TypeScript types are generated from the Rust schema (no drift):

```sh
cd web && npm run gen:types   # regenerates src/types.gen.ts
```

### Terminal UI

A full ratatui dashboard against the same engine — no browser needed:

```sh
cargo run -p pitwall-cli -- tui --replay fixtures/monaco-2023-quali/
```

Keys: `space` play/pause · `←/→` seek ±10s · `[`/`]` slower/faster · `↑/↓` focus
driver · `q` quit.

## Data source & legal

Pitwall reads the publicly reachable F1 Live Timing feed, as the FastF1, f1-dash, and
undercut-f1 projects do. It is an unofficial, fan-made tool and is not associated with,
authorized, or endorsed by Formula 1 companies. "F1", "Formula 1" and related marks are
trademarks of Formula One Licensing B.V.

## License

MIT
