# Hotlap — Project Report

> Formula 1 telemetry — live &amp; historical
> *Project report · v0.1*

A local-first F1 telemetry application. One Rust core ingests Formula 1's Live
Timing feed — live, from a recording, or from any past session — normalizes it,
and serves it to two front-ends: a browser window-manager dashboard and a
terminal UI.

A shareable, designed version of this report is published as an artifact. This
file is the committable copy; see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
full technical reference and [`TODO.md`](TODO.md) for the roadmap.

## At a glance

| | |
|---|---|
| Rust crates | **6** |
| Lines of code | **~10.1k** (~5.5k Rust, ~4.7k TS/TSX) |
| Front-ends | **2** (web dashboard + terminal UI) |
| Dashboard panels | **11** |
| Circuits with baked elevation | **40** |
| Commits | **56** |

---

## 1. Overview — one pipeline, three sources

**Live and replay share one code path.** Every source — the live SignalR feed, a
local recording, or F1's public historical archive — normalizes to the same
message shape and flows through the same parser → state → broadcast pipeline. A
session you record replays through the exact code that rendered it live, which
makes replay a free correctness check on the live path.

**Two UIs over one state stream.** The core serves a normalized `SessionState` as
a snapshot plus merge-patch deltas over WebSocket. The web dashboard is a React
client; the terminal UI links the core in-process. Neither re-implements parsing
— they render state.

---

## 2. Architecture — the data pipeline

Sources differ only in the adapter that produces
`RawMessage { topic, payload, offset_ms }`; parsing, state, and broadcast are
identical downstream.

```
            ┌──────────────── sources (adapters) ─────────────────┐
  live ───▶ │ SignalR client  ┐                                    │
  record ─▶ │ JSONL reader    ├─▶  RawMessage { topic, payload, ts }
  history ▶ │ static fetcher  ┘                                    │
            └───────────────────────────┬─────────────────────────┘
                                         ▼
                           PARSER  (decode .z, per-topic deltas,
                                    CarData entry expansion)
                                         ▼
                        STATE STORE  (normalized SessionState)
                             │                    │
                         RECORDER             BROADCASTER
                      (raw → .jsonl)     (snapshot + merge-patches)
                                                  │
                        ┌─────────────────────────┼──────────────┐
                        ▼                          ▼              ▼
                 WebSocket  /ws              REST  /api/*     in-process
                        │                          │              │
                  Web GUI (React)            calendar, index   Rust TUI
```

| Crate | Responsibility |
|-------|----------------|
| `hotlap-schema` | Shared types; derives JSON Schema, exported to TypeScript so Rust and the web can't drift. |
| `hotlap-core` | Parser, engine (state + broadcaster), recorder, replay clock, historical fetch/index, commentary, event detection, telemetry densification. |
| `hotlap-signalr` | F1 Live Timing SignalR client: negotiate → connect → Subscribe → parse frames. |
| `hotlap-server` | axum WebSocket + REST; a runtime session Hub; serves the built web GUI. |
| `hotlap-tui` | ratatui terminal dashboard, in-process over the same engine. |
| `hotlap-cli` | The `hotlap` binary: serve · live · replay · historical · tui. |

---

## 3. Pipeline internals

A few of the problems that needed real engineering rather than a library call.

- **Compressed telemetry.** `CarData.z` / `Position.z` are base64 of *raw*
  DEFLATE (no zlib header) — decoded as `inflate(-MAX_WBITS)`. The car channel
  map: `0=RPM 2=Speed 3=Gear 4=Throttle 5=Brake 45=DRS`.
- **Telemetry densification.** Each `CarData` message bundles ~4 timestamped
  samples (~5 Hz). Folding one message into one state step would collapse traces
  to ~1 Hz, so each message is split into one frame per entry, timed by its own
  `Utc` — restoring full-resolution traces.
- **Delta protocol.** The engine diffs each state change as an RFC 7386
  merge-patch and broadcasts it. New clients get a snapshot, then patches —
  keeping the wire small under high-rate car data.
- **Client-side replay.** For historical sessions the server pre-compiles the
  whole recording into one ordered patch *timeline*; the web downloads it once and
  folds it on its own clock. Replay is independent per tab, seeking rebuilds full
  per-lap history locally (a backward seek re-folds from lap 1), and the server
  does no per-seek work. Live mode and the TUI/CLI keep the server-driven
  snapshot-then-seek path.
- **Archive resilience.** The geo-gated static archive is reached via an optional
  / auto-discovered proxy (archive host only); when it can't be reached, the user
  is offered an Ergast-reconstructed basic replay. The season index is cached with
  a TTL and a last-good fallback.
- **No schema drift.** Types live once in `hotlap-schema`; `schemars` → JSON
  Schema → generated `types.gen.ts`. A Rust field rename surfaces as a
  TypeScript error, not a silent mismatch.
- **Circuit elevation.** Real topography for all 40 circuits is fetched once
  from open elevation APIs and baked into the bundled GeoJSON as
  `[lng, lat, elevation]` — Spa and Kyalami (~1450 m) show dramatic relief,
  Zandvoort (~8 m) is nearly flat.

---

## 4. Web dashboard — eleven panels, one window manager

Floating, resizable, overlapping windows with a taskbar and a persistent layout
— fed by a single WebSocket into a zustand store, in a liquid-glass UI.

- **Timing Tower** — order, gaps and intervals, sector &amp; mini-sector strips,
  tyres (new/used), best lap (session-fastest in purple), a live running sector
  delta vs the session benchmark, and places gained/lost versus the grid.
- **Track Clock** — a MultiViewer-style "Circle of Doom": drivers arranged around
  a ring by relative on-track position (the leader sweeping, the field spread by
  real time gaps), retired cars dropped, labels de-cluttered.
- **Telemetry** — full-resolution speed / throttle / brake for a single driver's
  current lap, with live speed / gear / rpm / DRS and pedal meters.
- **Driver Comparison** — overlay several drivers' laps (a driver's best, the
  session fastest, a specific lap, or another driver), aligned to seconds-into-lap.
- **Track Details** — the real circuit in 2D (geolocation outline, chosen by true
  location rather than the GP name) and interactive 3D (three.js, built from
  topography), each with the start/finish line and live yellow / double-yellow
  zone highlights; weather and race control inline.
- **Race Chart &amp; Strategy** — position by lap; tyre stints per driver.
- **Team Radio** — radio clips played inline from F1's static host.
- **Commentary** — F1's real live-blog (via Monterosa), time-synced to the
  playhead so posts reveal as the replay reaches them.
- **Weather**, **Prediction**, and the **Landing page** (F1-themed home with a
  roaming "breathing" orb, the next-race countdown in the viewer's local time
  zone, the full season calendar, and Live / Replay entry points).

---

## 5. Data sources

| Data | Source | Access |
|------|--------|--------|
| Live timing | livetiming.formula1.com — SignalR Core (`/signalrcore`) | Public |
| Live car telemetry + positions | same feed, `CarData.z` / `Position.z` | F1 TV token (2025+) |
| Historical sessions | Static `.jsonStream` archive + season Index | **Geo-gated** (Oct 2026); cached locally |
| Basic replay fallback | Jolpica / Ergast per-lap results | Public |
| Live-blog commentary | Monterosa (F1's provider since 2024) | Public |
| Circuit outlines | bacinger/f1-circuits GeoJSON (bundled) | Offline |
| Circuit elevation | Open-Meteo / Open-Elevation (baked in) | Offline |
| Race calendar | Jolpica / Ergast — via server proxy | Public |

Live timing is public via the `/signalrcore` endpoint; only live car telemetry +
positions need an F1 TV token. The historical **static archive** was public but,
since ~Oct 2026, F1 geo-gates it at the CloudFront edge (a 401 from blocked
regions) — Hotlap reaches it via an optional proxy, or degrades to the Ergast
basic replay (see §8). Sessions already cached replay fully offline.

---

## 6. Tech stack

- **Core / server / TUI (Rust):** tokio · axum (+ws) · reqwest · serde/schemars ·
  tokio-tungstenite (SignalR) · flate2 + base64 (`.z` decode) · clap · ratatui ·
  chrono.
- **Web:** React 19 + TypeScript + Vite · zustand (state) · react-rnd (windows) ·
  uPlot (charts) · three.js (3D track). Types generated from the Rust schema.
- **Discipline:** one pipeline for live/replay; schema-generated TS; parser,
  merge, replay-clock and densification covered by unit + integration tests; a
  recording replays identically to live.

---

## 7. How it came together

Built in phases, each independently runnable, then extended round by round
against real sessions.

1. **Phases P0–P5** — workspace + pipeline; the web MVP and the ratatui TUI; the
   SignalR live client; FastF1-style historical fetch — verified end-to-end on
   2023 Monaco qualifying.
2. **Session picker &amp; Hub** — a server Hub swaps the loaded session at
   runtime; `hotlap serve` starts empty and loads any year / event / session
   from the UI.
3. **Real commentary &amp; replay polish** — F1's actual live-blog (Monterosa)
   time-synced to the playhead; timeline event markers; near-instant seek.
4. **Geo track map + telemetry compare** — 2D circuit map from geolocation data;
   full-resolution telemetry with lap-vs-lap comparison.
5. **3D topography, flags, start lines** — interactive 3D track from baked
   elevation; yellow-zone highlights in 2D and 3D; start/finish markers on every
   map.
6. **Liquid-glass UI &amp; landing page** — an iOS-style glass theme throughout,
   and an F1 home page with parallax, a local-time countdown, and the live season
   calendar.

---

## 8. Known issues &amp; limitations

- **F1's historical archive is geo-gated (since ~Oct 2026).** F1 added a
  CloudFront **edge-function access gate** on `livetiming.formula1.com/static/`:
  requests from blocked regions get an immediate **`401 Unauthorized`**
  (`x-cache: FunctionGeneratedResponse`), regardless of User-Agent or headers.
  This is **not rate limiting** (that is `429`) — it is region/IP-based, it hit us
  only after the gate was deployed (a same-URL fetch succeeded days earlier), and
  it affects **every** tool reading the static archive (FastF1 included). The
  **live** feed (`/signalrcore`) is unaffected. Hotlap mitigates it three ways,
  most-reliable first:
  1. **A trusted proxy** via `HOTLAP_ARCHIVE_PROXY` (http/https/socks5, allowed
     region) — only the archive host is proxied.
  2. **Automatic proxy discovery** — fetches a public free-proxy list and tests
     candidates against the archive in parallel, caching the first that connects
     (`HOTLAP_NO_AUTO_PROXY=1` to disable). *Free proxies rarely succeed:* F1 also
     **WAF-blocks datacenter IPs** (a `403`), and free lists are almost all
     datacenter, so a residential/paid proxy is usually needed.
  3. **Ergast/Jolpica basic replay** — offered via a user prompt: positions, lap
     times and gaps, but **no telemetry, map, sectors, weather or race control**.
  Cached sessions still load fully; the season index is TTL-cached with a
  last-good fallback so the calendar survives outages.
- **Large race timelines.** A full race compiles to a ~50 MB client-side timeline
  (car/position thinned 2×); fine locally, enable HTTP compression for remote
  hosting.
- **Backward seek** re-folds the timeline from lap 1 (no keyframes yet) — a brief
  synchronous pass on a long race.
- **Live car telemetry/positions** still need an F1 TV cookie (2025+).

## 9. Status &amp; roadmap

**Working today**

- **Live mode** from the web (Live button, track-local clock, elapsed/remaining).
- **Per-tab client-side replay**: the server compiles a session to a patch
  timeline the browser folds on its own clock — independent per tab, instant
  seek rebuilding full history, no per-seek server load.
- Replay / historical on any cached public session; geo-gate mitigations above.
- Both front-ends against one engine; 2D/3D maps, Track Clock, telemetry +
  comparison, race chart, commentary; landing page + full weekend calendar.

**Next**

- Reduce timeline size (keyframes for backward seek; optional HTTP compression).
- Investigate whether the archive gate is permanent (vs. geo rollout) and, if so,
  an authenticated-archive path.

**Later**

- F1 TV auth for the live car channels; reconnect/backoff.
- Saveable named layouts; packaging (binaries, Docker).

---

*Hotlap is an unofficial, fan-made tool. It is not associated with, authorized,
or endorsed by Formula 1 companies. "F1" and "Formula 1" are trademarks of
Formula One Licensing B.V. It reads the same publicly reachable feed as FastF1,
f1-dash and undercut-f1. Licensed MIT.*
