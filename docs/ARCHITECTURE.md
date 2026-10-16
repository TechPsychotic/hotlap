# Hotlap — Architecture

This document describes how Hotlap is put together: the data pipeline, the
crates, the wire protocol, the data sources, and the web/TUI front-ends. For a
task-level roadmap see [`TODO.md`](TODO.md); for build/run instructions see the
[README](../README.md).

---

## 1. The idea

Hotlap renders Formula 1 timing and telemetry from three kinds of source —
**live**, **recorded**, and **historical** — through **one pipeline**. Live and
replay share the same parser and state model, so a session you record replays
through the exact code that rendered it live. Two front-ends (a browser window
manager and a terminal UI) are thin clients over one normalized state stream.

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

---

## 2. Crates (Rust workspace)

| Crate | Responsibility |
|-------|----------------|
| `hotlap-schema` | Single source of truth for the data types (`SessionState`, `RawMessage`, `ReplayControl`, the wire `ServerMessage`/`ClientMessage`, …). Derives `schemars::JsonSchema`, exported to TypeScript so Rust and the web never drift. |
| `hotlap-core` | The pipeline: ingest adapters, the per-topic **parser**, the **engine** (state store + merge-patch broadcaster), the **recorder**, the **replay clock**, historical fetch/index, event detection, commentary, telemetry densification. |
| `hotlap-signalr` | F1 Live Timing SignalR client: negotiate → websocket connect → `Subscribe` → parse `R` (snapshot) / `M` (message) frames into `RawMessage`s. |
| `hotlap-server` | axum HTTP server: the `/ws` snapshot+patch stream, the REST API, a runtime session **Hub**, and it serves the built web GUI from `web/dist`. |
| `hotlap-tui` | A ratatui terminal dashboard that links `hotlap-core` in-process (no network needed). |
| `hotlap-cli` | The `hotlap` binary wiring it together: `serve`, `live`, `replay`, `historical`, `tui`. |

~4,300 lines of Rust, ~3,300 lines of TypeScript/TSX.

---

## 3. The pipeline in detail

### 3.1 RawMessage

Every source normalizes to one shape:

```rust
struct RawMessage {
    topic: String,          // e.g. "TimingData", "CarData.z"
    payload: serde_json::Value,
    utc: Option<String>,    // feed wall-clock, when present
    offset_ms: u64,         // monotonic ms from session start (the replay clock)
}
```

Live, recorded, and historical sources differ **only** in the adapter that
produces these. `offset_ms` is the clock the replay engine seeks against.

### 3.2 Parser

`parser::apply(&mut SessionState, &RawMessage)` folds a message into the state.
Per-topic decoders cover `TimingData`, `TimingAppData`, `CarData`, `Position`,
`SessionInfo/Status/Data`, `TrackStatus`, `RaceControlMessages`, `WeatherData`,
`ExtrapolatedClock`, `DriverList`, `TeamRadio`, `LapCount`, and a synthetic
`Commentary` topic.

- **`CarData.z` / `Position.z`** arrive as base64 of **raw DEFLATE** (no zlib
  header), matching FastF1's `zlib.decompress(b64decode(x), -MAX_WBITS)`. Decoded
  in `decode::inflate_z`.
- The channel map for car telemetry is `0=RPM, 2=Speed, 3=nGear, 4=Throttle,
  5=Brake, 45=DRS`.

### 3.3 Telemetry densification (`expand.rs`)

Each `CarData` message actually bundles an `Entries` array of ~4 timestamped
samples (~5 Hz native). The engine folds a whole message in as one state step
and broadcasts only the latest value, which would collapse telemetry to ~1 Hz
and make traces look coarse. `expand::expand_telemetry` splits each message into
**one message per entry**, timed by the entry's own `Utc` (anchored so the last
entry sits at the message offset), run once at load. Traces then render at full
resolution.

### 3.4 Engine (state store + broadcaster)

The engine holds the normalized `SessionState` as JSON, applies a batch of
messages sharing one `offset_ms`, computes an **RFC 7386 merge-patch** diff
against the previous state, and broadcasts it. New subscribers get a full
**snapshot** then the live **patch** stream. A seek replaces the whole state and
rebroadcasts a snapshot.

### 3.5 Replay clock

`replay::spawn` drives recorded/historical sources on a virtual clock:
play / pause / `seek(offset_ms)` / `setSpeed(x)`. It sleeps until the next
message's offset (scaled by speed) and applies due messages.

**Fast seek:** rebuilding state to an arbitrary point would re-inflate thousands
of `.z` frames. Instead, seek applies every non-telemetry message up to the
target but only the **latest** `CarData`/`Position` before it (earlier ones are
overwritten anyway) — so scrubs are ~instant.

### 3.6 Recorder

Writes the raw stream to `session.jsonl` (+ a `subscribe.json`) in an
undercut-f1-compatible layout, so recordings replay through the same path and
existing recordings can be imported.

---

## 4. Wire protocol

`ServerMessage` (core → client):

- `snapshot` — full `SessionState`, on connect and after a seek.
- `update` — a merge-patch to apply.
- `replayStatus` — `{ source, playing, speed, positionMs, durationMs }`.
- `error`.

`ClientMessage` (client → core): `replayControl` carrying a `ReplayControl`
(`play` / `pause` / `seek{offsetMs}` / `setSpeed{speed}`). The same commands are
available over REST.

### REST API (`hotlap-server`)

| Route | Purpose |
|-------|---------|
| `GET /ws` | snapshot + merge-patch stream; accepts replay control upstream |
| `GET /api/health` | liveness |
| `GET /api/state` | current `SessionState` snapshot |
| `GET /api/replay/status` | current `ReplayStatus` (or 204) |
| `POST /api/replay/control` | a `ReplayControl` command |
| `GET /api/years` | seasons with a public archive |
| `GET /api/index/:year` | events + sessions for the picker |
| `GET /api/calendar/:year` | season race calendar (proxied from Jolpica/Ergast) |
| `POST /api/session/load` | load a historical session at runtime |
| `GET /api/session/status` | load progress |
| `GET /api/events` | timeline event markers (flags/SC/VSC/start/finish) |
| `GET /*` | the built web GUI |

The **Hub** owns the engine + the current replay handle; `session/load` swaps
the replay at runtime (aborts the old one, resets the engine, spawns the new),
so `hotlap serve` can start empty and switch sessions from the UI.

---

## 5. Schema → TypeScript (no drift)

`hotlap-schema` derives `schemars::JsonSchema`; a tiny exporter emits JSON
Schema, and `json-schema-to-typescript` generates `web/src/types.gen.ts`
(`npm run gen:types`). The web store and panels consume these generated types, so
a Rust field rename surfaces as a TypeScript error rather than a silent mismatch.

---

## 6. Data sources

| Data | Source | Notes |
|------|--------|-------|
| Live timing/telemetry | `livetiming.formula1.com` SignalR | 2025+ returns **401** without an authenticated F1 TV cookie; handled gracefully (`--auth` / `$HOTLAP_F1_COOKIE`). |
| Historical sessions | `livetiming.formula1.com/static/<year>/<path>/<Topic>.jsonStream` + season `Index.json` | Same format as live. Was public; since ~Oct 2026 F1 **geo-gates** it at the CloudFront edge (a `401` from blocked regions, `x-cache: FunctionGeneratedResponse` — not rate limiting). Reached via an optional/auto-discovered proxy (`HOTLAP_ARCHIVE_PROXY`, archive host only); the `Index.json` is TTL-cached with a last-good fallback. Session files cached under the OS cache dir. See §10. |
| Basic replay fallback | Jolpica/Ergast `…/{year}/{round}/results` + `…/laps` | When the archive is unreachable, a user prompt can build a basic timeline (positions, lap times, gaps) — no telemetry/map/sectors/weather/race-control. Paced + retried (public API throttles). |
| Live-blog commentary | Monterosa (F1's provider since 2024): `ContentStreams.json` → commentary URI → `/events/{id[:2]}/{id}/history.json` | Time-synced to the playhead by anchoring post epochs to a feed `Utc`+offset pair. Pre-2024 used the now-defunct ScribbleLive. |
| Circuit outlines | `bacinger/f1-circuits` GeoJSON (40 circuits) | Bundled at `web/public/circuits.geojson`; matched to a session by circuit/country/meeting name (stopword-filtered). |
| Circuit **elevation** | Open-Meteo elevation API (Open-Elevation fallback) | Fetched once and **baked** into the GeoJSON as `[lng, lat, elevation]`; drives the 3D topography view. |
| Race calendar | Jolpica (Ergast successor), via the `/api/calendar/:year` server proxy | Dates/times (UTC) rendered in the viewer's local time zone; Jolpica sends no CORS header, hence the proxy. |

---

## 7. Web GUI

**Stack:** React 19 + TypeScript + Vite · `zustand` (one store fed by one WS) ·
`react-rnd` (floating/resizable windows) · `uPlot` (telemetry charts) ·
`three.js` (3D track, lazy-loaded).

### Store

A single WebSocket feeds the zustand store: a snapshot replaces state, patches
are merge-applied (`merge.ts`, RFC 7386). Derived state is maintained outside
React for cheapness and panel independence: the accumulated **position trail**,
an ordered **reference-car track path** (with elevation), **per-lap telemetry
history** (`getCurrentLap/getLapTrace/getBestLap/getFastestLap`), and live
**sector deltas**.

### Window manager

Panels are floating windows (move / resize / overlap / minimize) with a taskbar;
the layout persists per browser. Panels:

| Panel | Shows |
|-------|-------|
| Timing Tower | order, gaps/intervals, sectors + mini-sector strips, tyres, live sector delta |
| Track Details | the circuit map (2D/3D), weather, and the race-control log, inline |
| Telemetry | speed/throttle/brake for a lap, with lap comparison (best / fastest / specific / another driver) |
| Strategy | tyre stints per driver |
| Team Radio | radio clips, played inline from F1's static host |
| Weather | air/track temp, humidity, wind, rain |
| Commentary | the real F1 live-blog, time-synced to the playhead |
| Prediction | simple projections |

### Track maps

- **2D** — the real circuit outline from the bundled GeoJSON (cos-lat corrected
  planar projection), with the **start/finish line**, and **yellow / double-yellow
  zone highlights** derived from the net per-marshalling-sector race-control
  state.
- **3D** — an interactive `three.js` scene built from the circuit geo + **baked
  elevation** (a tube on a ground grid, a start/finish gate, orbit/zoom/pan),
  plus the same flag highlights. Lazy-loaded so three.js isn't in the main bundle.

### Landing page

An F1-themed home page with mouse **parallax**, the **next-race countdown** in the
viewer's local time zone, and the full **season calendar** (from the calendar
proxy), rendered in the liquid-glass style.

### Liquid-glass theme

Translucent, background-blurred, saturated panels and chrome with a specular
hairline highlight and depth shadow, over a themed F1 background. Driven by a
small set of `--glass-*` tokens in `theme.css`.

---

## 8. TUI

`hotlap tui` links `hotlap-core` in-process and renders a ratatui dashboard:
timing tower (team/sector colours, tyres), a braille track map, telemetry gauges,
conditions, race control, and keyboard transport (play/pause/seek/speed/focus).

---

## 9. Testing & correctness

- **Unit:** parser decodes fixtures (incl. `.z`) to expected state; merge-patch
  correctness; replay-clock seek/speed; telemetry entry expansion; event
  detection.
- **Integration:** spin the core on a fixture, connect a WS client, assert the
  snapshot + patch sequence.
- **Schema guard:** regenerate TS from the schema; a drift fails the build.
- **Shared code path:** a recording replays identically to how it rendered live —
  a cheap, strong correctness check.

---

## 10. Known issues & limitations

- **Historical archive geo-gate (since ~Oct 2026).** F1 put a CloudFront
  edge-function gate on `…/static/`; blocked regions get an immediate `401`
  (`x-cache: FunctionGeneratedResponse`) regardless of headers/User-Agent. It is
  **not** rate limiting (that is `429`) — it is region/IP-based, began only after
  the gate was deployed, and affects every static-archive reader (FastF1
  included). The live `/signalrcore` feed is unaffected. Mitigations, most
  reliable first: **(1)** a trusted proxy via `HOTLAP_ARCHIVE_PROXY`
  (http/https/socks5, allowed region, archive host only); **(2)** auto-discovery
  that fetches a public free-proxy list and tests candidates against the archive
  in parallel (`HOTLAP_NO_AUTO_PROXY=1` to disable) — but F1 also WAF-blocks
  datacenter IPs (`403`), so free lists (mostly datacenter) rarely succeed and a
  residential/paid proxy is usually required; **(3)** a prompted Ergast basic
  replay. Cached sessions still load fully.
- **Timeline size.** A full race compiles to a ~50 MB client-side timeline
  (car/position thinned 2×). Consider HTTP compression for remote hosting.
- **Backward seek** re-folds the client timeline from lap 1 (no keyframes yet).
- **Live car telemetry/positions** need an F1 TV cookie (2025+).
- **Observed, uncharacterized:** an idle open browser tab has occasionally issued
  stray session loads (visible in the server log, no user action) — cause not yet
  pinned down; a hard refresh clears it.
