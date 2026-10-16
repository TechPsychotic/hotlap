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

Live timing is public; only live **car telemetry + positions** need an F1 TV login
(2025+). Historical sessions come from F1's static archive, which is **cached
locally** (so anything you've loaded replays offline) but, as of ~Oct 2026, is
**geo-gated** at F1's edge — see [Known issues](#known-issues) for the proxy and
basic-replay fallbacks that keep historical loading working.

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

**Live & historical entry** — a **Live session** button (enabled only when a
session is actually on air) connects the live feed and shows a **track-local
clock** + **elapsed/remaining** timers; **Replay session** loads any past
session. Historical replay is **per-tab and client-side**: the server compiles
the session into a patch timeline the browser downloads once and folds on its
own clock, so one viewer's play/pause/seek doesn't affect anyone else, seeking
rebuilds full history locally, and scrubbing does no per-seek server work.

**Replay transport** — play / pause / **instant seek** / variable speed, with
**timeline markers** for session start, flags, SC/VSC, red, and finish. Seeking
repopulates every panel — including the per-lap telemetry history — to that moment.

**Web dashboard** (window manager — move / resize / overlap / minimize; layout
persists):

- **Timing Tower** — order, gaps, sectors + mini-sector strips, tyres (new/used),
  best lap (session-fastest in purple), live sector delta, and places gained/lost
  vs the grid.
- **Track Clock** — a MultiViewer-style "Circle of Doom": drivers placed around a
  ring by relative on-track position (leader sweeping, field spread by real
  gaps), retired cars dropped, labels de-cluttered.
- **Telemetry** — full-resolution speed/throttle/brake for a single driver's
  current lap, with live speed/gear/rpm/DRS and pedal meters.
- **Driver Comparison** — overlay several drivers' laps (a driver's best, the
  session fastest, a specific lap, or another driver), aligned to seconds-into-lap.
- **Track Details** — the **real circuit map** in **2D** (geolocation outline) and
  **interactive 3D** (three.js, built from circuit **topography/elevation**, with
  orbit / zoom / pan), each showing the **start/finish line** and **yellow /
  double-yellow zone highlights**; plus weather and the race-control log, inline.
- **Race Chart** (position by lap), **Strategy** (tyre stints), **Team Radio**
  (inline audio), **Weather**, **Commentary** (F1's real live-blog, time-synced to
  the playhead), **Prediction**.

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

Open <http://localhost:8080>. The home page shows the season calendar — **click
any past session to load and replay it** — plus the next-session countdown in
your local time. Windows **float, overlap, move, and resize** like a desktop; use
the **taskbar** to open/minimize them, and the transport bar to play / pause /
seek / change speed. The layout is remembered per browser.

Or start with an empty **session picker** and choose any season / event / session
(practices included) from the dropdowns — it fetches and loads on the fly:

```sh
cargo run -p hotlap-cli -- serve
```

### LAN access

The server **binds `0.0.0.0:8080` by default**, so other devices on your network
can open it — on startup it prints the LAN URL (e.g. `http://192.168.1.20:8080`).
Change the bind with `--addr` (e.g. `--addr 127.0.0.1:8080` to keep it local-only,
or `--addr 0.0.0.0:9000` for a different port).

### Docker

```sh
docker compose up --build        # → http://<this-host-ip>:8080 from any LAN device
# or:
docker build -t hotlap .
docker run --rm -p 8080:8080 -v hotlap-cache:/root/.cache/hotlap hotlap
```

The image builds the web GUI and the Rust binary and serves both on
`0.0.0.0:8080`; the named volume persists the historical download cache.

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

Connects to F1's ASP.NET **Core** SignalR endpoint (`/signalrcore`; F1 retired the
old `/signalr` hub in 2025, which now 401s). **Core live timing — gaps, sectors,
flags, weather, race control, driver list — is public and needs no login.** The
premium topics **`CarData.z` and `Position.z`** (car telemetry + positions) still
require a valid F1 TV session cookie since the 2025 Dutch GP — pass it with
`--auth "<cookie>"` or `$HOTLAP_F1_COOKIE` to get those too. There must be a live
session on. The **static archive** used for `replay`/historical was public but is
now **geo-gated** at F1's edge (see [Known issues](#known-issues)); the live feed
above is unaffected.

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
    hotlap-core/     # parser, engine, replay, timeline, recorder, historical, fallback, proxy, commentary, events, expand
    hotlap-signalr/  # F1 Live Timing SignalR client
    hotlap-server/   # axum WS + REST; serves web/dist; runtime session Hub
    hotlap-tui/       # ratatui dashboard
    hotlap-cli/       # the `hotlap` binary (serve/live/replay/historical/tui)
  web/
    src/
      store.ts          # WS live source + client-side local timeline player + derived state
      components/        # TopBar, WindowManager, SessionPicker, TransportBar, Landing
      panels/            # TimingTower, TrackClock, Telemetry, DriverComparison, TrackDetails, Track3D, RaceChart, Strategy, Radio, Weather, Commentary, Prediction
      circuits.ts        # circuit GeoJSON load/match/projection
      types.gen.ts       # generated from the Rust schema
    public/circuits.geojson   # 40 circuits, with baked elevation
  fixtures/             # checked-in sample sessions for offline dev/tests
  docs/                 # ARCHITECTURE.md, TODO.md
```

## Known issues

### F1's historical archive is geo-gated (since ~Oct 2026)
**Symptom:** loading a past session that isn't already cached fails to fetch
telemetry; the picker shows an **"F1 archive unavailable"** prompt.

**Cause:** F1 added a **CloudFront edge-function access gate** on
`livetiming.formula1.com/static/`. Requests from blocked regions get an immediate
**`401 Unauthorized`** (`x-cache: FunctionGeneratedResponse`), *regardless of
User-Agent or headers* — so no request tweak bypasses it. This is **not rate
limiting** (that would be `429`); it's **region/IP-based**. The **live** feed
(`/signalrcore`) is unaffected, and this is an F1-side change that hits every tool
reading the static archive (FastF1 included), not a Hotlap bug.

**What Hotlap does about it**, most-reliable first:
1. **A trusted proxy you supply** — set **`HOTLAP_ARCHIVE_PROXY`** to an
   `http`/`https`/`socks5` URL (optionally `user:pass@host`) in an allowed region.
   Only the archive host is routed through it; everything else stays direct.
2. **Automatic proxy discovery** — when the archive is blocked, the server fetches
   a public free-proxy list and tests candidates against the archive in parallel,
   using the first that connects (cached, re-probed). Disable with
   **`HOTLAP_NO_AUTO_PROXY=1`**. *Note:* free proxies rarely work here — F1 also
   WAF-blocks datacenter IP ranges (a `403`), and free lists are almost all
   datacenter IPs, so a **residential/paid** proxy is usually required.
3. **Ergast/Jolpica basic replay** — offered via the popup as a last resort: a
   results-based replay (positions, lap times, gaps) with **no telemetry, track
   map, sectors, weather or race control**. Covers 2024+, race sessions best.

**Already-cached sessions still load fully** (immutable session files are served
from disk). The season index is cached with a 15-min TTL and falls back to the
last-good copy, so the calendar keeps working through an outage.

### Other notes
- **Large race timelines.** A full race compiles to a ~50 MB client-side timeline
  (car/position streams are thinned 2×). Fine for local/LAN; enable HTTP
  compression for remote hosting. First (uncached) loads are download-bound.
- **Backward seek** re-folds the timeline from lap 1 to rebuild full history — a
  brief synchronous pass on a long race (no keyframe optimization yet).
- **Live telemetry/positions** need `HOTLAP_F1_COOKIE` (F1 TV, 2025+); without it,
  live mode omits car telemetry and track position (timing/flags/weather/radio/
  commentary still work).

## Data source & legal

Hotlap reads the publicly reachable F1 Live Timing feed, as the FastF1, f1-dash, and
undercut-f1 projects do. It is an unofficial, fan-made tool and is not associated with,
authorized, or endorsed by Formula 1 companies. "F1", "Formula 1" and related marks are
trademarks of Formula One Licensing B.V.

## License

MIT
