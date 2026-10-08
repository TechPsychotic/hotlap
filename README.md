# Hotlap

> F1 live &amp; historical telemetry — in your browser **and** your terminal.

Hotlap is a local-first Formula 1 telemetry app. A single Rust core ingests F1's
Live Timing feed (live, from a local recording, or from a past session), normalizes
it, and serves it to two highly customizable front-ends:

- **Web GUI** — a window-manager-style dashboard with movable, resizable, dockable
  panels and saveable layouts.
- **TUI** — a keyboard-driven terminal dashboard with resizable tiled panels.

Live and historical data all flow through **one pipeline**, so a session
you record replays through the exact same code that rendered it live.

Live car positions are gated behind F1 TV (2025+), but **recorded and historical
sessions are fully public** — so everything below works offline on any past race.

> Deep dive: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** · Report:
> **[`docs/PROJECT_REPORT.md`](docs/PROJECT_REPORT.md)** · Roadmap:
> **[`docs/TODO.md`](docs/TODO.md)**.

## Features

**Home / landing** — an F1-themed page with mouse **parallax**, the **next-race
countdown** in your local time zone, and the full **season calendar** (live from
Jolpica/Ergast).

**One pipeline, three sources** — live SignalR feed, local recordings, and F1's
public historical archive all flow through the same parser → state → broadcast
path. Record a live session and it replays through the exact code that rendered it.

**Replay transport** — play / pause / **near-instant seek** / variable speed, with
**timeline markers** for session start, flags, SC/VSC, red, and finish. Seeking
repopulates every panel to that moment.

**Web dashboard** (window manager — move / resize / overlap / minimize; layout
persists):

- **Timing Tower** — order, gaps, sectors + mini-sector strips, tyres, live sector delta.
- **Telemetry** — full-resolution speed/throttle/brake for a lap, with **lap
  comparison** (a driver's best, the session fastest, a specific lap, or another
  driver).
- **Track Details** — the **real circuit map** in **2D** (geolocation outline) and
  **interactive 3D** (three.js, built from circuit **topography/elevation**, with
  orbit / zoom / pan), each showing the **start/finish line** and **yellow /
  double-yellow zone highlights**; plus weather and the race-control log, inline.
- **Strategy** (tyre stints), **Team Radio** (inline audio), **Weather**,
  **Commentary** (F1's real live-blog, time-synced to the playhead), **Prediction**.

**Liquid-glass UI** — translucent, blurred, iOS-style panels and chrome over a
themed background.

**Terminal UI** — the same engine in a keyboard-driven ratatui dashboard.

## Architecture

```
 sources ──▶ parser ──▶ state store ──┬─▶ recorder (raw .jsonl)
 (live /                              └─▶ broadcaster ─▶ WS/REST ─▶ Web GUI
  recorded /                                           └────────▶ TUI (in-proc)
  historical)
```

| Crate | Responsibility |
|-------|----------------|
| `hotlap-schema` | Shared data types (Rust → JSON Schema → TS) |
| `hotlap-core` | Ingest adapters, parser, state store, recorder, replay clock, broadcaster |
| `hotlap-signalr` | F1 Live Timing SignalR client |
| `hotlap-server` | axum WebSocket + REST API; serves the embedded web GUI |
| `hotlap-tui` | ratatui terminal UI |
| `hotlap-cli` | The `hotlap` binary |

## Quick start

```sh
# 1. Build the web GUI once (outputs web/dist, which the core serves)
cd web && npm install && npm run build && cd ..

# 2. Replay the bundled real session; opens the dashboard in your browser
cargo run -p hotlap-cli -- replay fixtures/monaco-2023-quali/
```

Open <http://127.0.0.1:8080>. Windows **float, overlap, move, and resize** like a
desktop; use the **taskbar** to open/minimize them, and the transport bar to
play / pause / seek / change speed. The layout is remembered per browser.

Or start with an empty **session picker** and choose any season / event / session
(practices included) from the dropdowns — it fetches and loads on the fly:

```sh
cargo run -p hotlap-cli -- serve
```

`fixtures/monaco-2023-quali/` is a real slice of the 2023 Monaco GP qualifying
(Q1 flying laps, incl. the yellow/red flags), exported with `tools/export_session.py`.
`fixtures/sample/` is a tiny hand-authored one used by tests.

### Any past session, on demand

Hotlap reads F1's archived Live Timing `.jsonStream` files directly (the same
source FastF1 uses) — no F1 TV login needed for past public sessions. Fetch,
cache, and replay any past session in one command:

```sh
cargo run -p hotlap-cli -- historical 2023 Silverstone Race
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
hotlap live                       # serves both UIs off the live feed
hotlap live --record data/my-session   # also save it for replay later
```

Since 2025 the live SignalR feed requires an **authenticated F1 TV session**, so
pass your session cookie(s) with `--auth "<cookie>"` or `$HOTLAP_F1_COOKIE`
(and there must be a session live). The protocol client, recorder, and both UIs
are implemented; only the feed itself is gated. The **static archive** used for
`replay`/historical remains public and needs no login.

### Web dev loop

```sh
# Terminal 1 — core serving the API + WebSocket
cargo run -p hotlap-cli -- replay fixtures/monaco-2023-quali/ --no-open

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
cargo run -p hotlap-cli -- tui --replay fixtures/monaco-2023-quali/
```

Keys: `space` play/pause · `←/→` seek ±10s · `[`/`]` slower/faster · `↑/↓` focus
driver · `q` quit.

## Tech stack

- **Core / server / TUI:** Rust — `tokio`, `axum` (+ WebSocket), `reqwest`,
  `serde`/`schemars`, `tokio-tungstenite` (SignalR), `flate2` + `base64` (`.z`
  decode), `clap`, `ratatui`, `chrono`.
- **Web:** React 19 + TypeScript + Vite, `zustand` (state), `react-rnd` (windows),
  `uPlot` (telemetry charts), `three.js` (3D track). Types are generated from the
  Rust schema (`npm run gen:types`) so they can't drift.
- **Data:** F1 Live Timing (live + static archive), Monterosa (commentary),
  `bacinger/f1-circuits` GeoJSON + Open-Meteo/Open-Elevation (circuit elevation),
  Jolpica/Ergast (calendar).

## Project layout

```
hotlap/
  crates/
    hotlap-schema/   # shared types → JSON Schema → TS
    hotlap-core/     # parser, engine, replay, recorder, historical, commentary, events, expand
    hotlap-signalr/  # F1 Live Timing SignalR client
    hotlap-server/   # axum WS + REST; serves web/dist; runtime session Hub
    hotlap-tui/       # ratatui dashboard
    hotlap-cli/       # the `hotlap` binary (serve/live/replay/historical/tui)
  web/
    src/
      store.ts          # one WS → zustand store + derived state
      components/        # TopBar, WindowManager, SessionPicker, TransportBar, Landing
      panels/            # TimingTower, Telemetry, TrackDetails, Track3D, Strategy, Radio, Weather, Commentary, Prediction
      circuits.ts        # circuit GeoJSON load/match/projection
      types.gen.ts       # generated from the Rust schema
    public/circuits.geojson   # 40 circuits, with baked elevation
  fixtures/             # checked-in sample sessions for offline dev/tests
  docs/                 # ARCHITECTURE.md, TODO.md
```

## Data source & legal

Hotlap reads the publicly reachable F1 Live Timing feed, as the FastF1, f1-dash, and
undercut-f1 projects do. It is an unofficial, fan-made tool and is not associated with,
authorized, or endorsed by Formula 1 companies. "F1", "Formula 1" and related marks are
trademarks of Formula One Licensing B.V.

## License

MIT
