# Pitwall — TODO / next-session roadmap

Feature requests captured 2026-10-07. Grouped by area, with data sources, likely
code locations, approach, and open questions so it can be executed directly.

## Requested next (2026-10-07 — partly done)

- [x] **Telemetry fixed** — responsive layout; compare now **lap-aligned** (x =
  seconds into each driver's own lap, reset on lap increment).
- [x] **Default layout** — Team Radio in the old Weather slot; Weather closed by
  default (also inline in Track Details) + on the taskbar.
- [x] **Session picker** (`pitwall serve` + top-bar dropdowns): a server **Hub**
  swaps the current replay at runtime; REST `GET /api/years`,
  `GET /api/index/:year`, `POST /api/session/load`, `GET /api/session/status`;
  control routes to the current replay; WS resyncs on the new snapshot. Verified
  loading 2024 Spanish GP Race from the dropdowns.
- [x] **Commentary** (`TlaRcm` ticker): fetched (historical + live), parsed into
  `SessionState.commentary`, shown in a Commentary window. ScribbleLive (the
  ContentStreams text commentary) is dead, so TlaRcm is the source. *Later: HLS
  audio-stream player from ContentStreams for live sessions.*

## Progress (2026-10-07, same day)

- [x] **P5 — `historical` in core** (`pitwall historical <year> <gp> <session>`):
  Rust port of the export tool in `pitwall-core::historical` — resolves the
  session from the season Index, downloads the archived `.jsonStream` topics
  (percent-encoding + exact-name matching), parses + windows/downsamples into a
  Recording, caches raw downloads under the OS cache dir, and replays through
  both UIs. **Verified end-to-end** on 2023 Monaco Qualifying (public archive, no
  login). *Later: Jolpica/Ergast for nicer event lookup; a historical browser
  panel.*
- [x] **P4 — Live ingest** (`pitwall live`): F1 Live Timing **SignalR client**
  (negotiate → ws connect → Subscribe → parse `R`/`M` frames → RawMessage),
  wired to the engine + optional recorder, decoupled via an mpsc channel.
  Frame parsing unit-tested. **Caveat**: since 2025 the live feed returns **401**
  without an authenticated F1 TV session — handled gracefully with a clear
  message; `--auth`/`$PITWALL_F1_COOKIE` forwards a session cookie. Could not be
  end-to-end verified here (no F1 TV creds / no guaranteed live session); the
  static archive path it shares *is* verified. *Later: real F1 TV OAuth login
  flow (`pitwall login`), reconnect/backoff.*
- [x] **P3 — TUI** (`pitwall tui --replay <dir>`): ratatui dashboard sharing the
  engine in-process — timing tower (team colours, lap/sector colours, tyres),
  track-map braille canvas, telemetry (gauges), conditions, race control, and
  keyboard transport (play/pause/seek/speed/driver-focus). *Later: resizable
  panels/workspaces, `--live`/`--connect`, Sixel track map, prediction pane.*


- [x] **#1 Telemetry throttle/brake graphs** — Speed+Throttle+Brake traces.
- [x] **#1b Multi-driver telemetry compare** — overlay up to 3 drivers' speed
  (time-aligned on the primary's cadence). *Later: distance-aligned lap compare.*
- [x] **#4 Track Details** — weather inline (map left, weather right) + flag-state
  map highlighting (red/yellow/double/SC/VSC/green + sector badge).
  *Later: per-sector map-region tinting (needs marshal-sector → map mapping).*
- [x] **#5 Team radio** — SessionInfo `path` exposed; TeamRadio exported; clips
  play inline from F1's static host.
- [x] **#2 Timing-tower live sector delta** — per-driver running delta vs the
  session-best cumulative at the latest completed sector (S1/S2/Lap).
- [~] **#3 Prediction window** — deterministic v1 done for **both modes**:
  - Quali: cut-off predictor (segment inference, cut line, SAFE/DANGER/OUT,
    bubble narrative).
  - Race: projected podium + threats, undercut-window flags (~2.5s of car
    ahead), tyre/pit/interval table, templated summary. Pit loss hardcoded 22s.
    Verified on real 2023 São Paulo GP.
  - *Remaining: tyre-degradation model for smarter undercut/overcut + pace-based
    finish projection; per-track pit-loss table; then the **SLM narrative**
    (phase 2 — user chose deterministic-first); consider moving the math into a
    Rust `predict.rs` so the TUI/SLM share it.*
  - Race data is large (~10MB full race) so it's exported to the gitignored
    `data/` dir, not committed: `tools/export_session.py 2023 "Paulo" Race data/…`.
    The committed default stays Monaco quali.

## Where the project stands (context for next session)

- Branch `feat/core-pipeline` (not pushed). Commits: P0 scaffold → P1 core
  pipeline → P2 web GUI → polish → **window manager + real data** → quali polish.
- **Core (Rust)**: `crates/pitwall-{schema,core,signalr,server,tui,cli}`. Pipeline =
  source → `parser` → `engine` (state + RFC7386 merge-patch broadcast) → axum WS/REST.
  Replay clock with play/pause/seek/speed. 22 tests green.
- **Web (`web/`)**: React + TS, **free-floating window manager** (react-rnd,
  `src/windows.ts` + `src/components/WindowManager.tsx`), zustand store
  (`src/store.ts`, applies merge patches, keeps a position `trail`). Panels in
  `src/panels/`: TimingTower, Telemetry (uPlot speed trace), TrackDetails (map +
  status + race control), Strategy, Weather. Types generated from Rust schema
  (`src/types.gen.ts`, `npm run gen:types`).
- **Data**: real sessions via `tools/export_session.py` (pulls F1 archived
  `.jsonStream` from `livetiming.formula1.com/static/...`). Default fixture
  `fixtures/monaco-2023-quali/`. `fixtures/sample/` is the tiny test fixture.
- Run: `cd web && npm run build`, then `cargo run -p pitwall-cli -- replay fixtures/monaco-2023-quali/`.
  Stop a running core: `pkill -f 'pitwall replay'`.
- Still unbuilt from the original plan: **P3 TUI**, **P4 live ingest**, **P5
  `pitwall historical` as a first-class command** (fold `export_session.py` into Rust).

---

## 1. Telemetry graphs — throttle & braking, multi-driver compare

- **Add throttle + brake traces** to the Telemetry window (today it only plots
  speed). Data already in state: `car[num].throttle`, `.brake` (`CarTelemetry`).
  Extend the rolling buffer in `web/src/panels/Telemetry.tsx` to also buffer
  throttle/brake; render as a second uPlot (0–100 scale) or stacked panels, or a
  shared uPlot with multiple y-scales. Consider adding gear/RPM too.
- **Compare with other drivers**: overlay 2–3 drivers' speed/throttle/brake for
  the current lap.
  - Need per-driver channel history (buffer multiple drivers, not just focus).
  - Alignment: by **lap distance** is ideal but we have no distance channel —
    options: integrate speed over time to approximate distance, or align by
    time-into-lap (detect lap start from `TimingData.NumberOfLaps` increment /
    sector 1 start). Start with time-into-current-lap alignment; note it's
    approximate.
  - UI: a compare mode with a driver multi-select; colour traces by team.
- Open Q: live (streaming) compare vs lap-over-lap compare. Start with live
  current-lap overlay.

## 2. Timing tower — live lap-time delta between all drivers

- Add a **delta** indicator per row: how each driver's pace compares live
  (gaining/losing vs the car ahead or vs leader), and/or last-lap delta to their
  own best / to the session best.
- Data: track a short history of `gapToLeader` / `intervalToAhead` (race) or
  best-lap deltas (quali). Compute trend (▲/▼ + tenths) over the last N updates.
- Code: `web/src/panels/TimingTower.tsx`; may need the store to keep a small
  rolling history of gaps per driver (like `trail`), or compute from successive
  patches. Colour green when gaining, red when losing.

## 3. Prediction window (analytics + SLM narrative) — BIG, phase it

New **Prediction** window. Split into a Rust analytics module (deterministic
math, exposed via REST/WS) + an SLM layer (natural language) + the web panel.

- **Race podium (P1/P2/P3)**: project finishing order from current positions,
  recent lap pace, gaps, remaining laps, pit-stop status, tyre age/deg. Simple
  model first (extrapolate gaps + mandatory stop deltas), refine later.
- **Quali cut-off (Q1/Q2)**: predict the elimination line (P15 in Q1, P10 in Q2)
  from current best laps + improvement trend of drivers still on track / yet to
  set a time. Show predicted cut-off time and who's provisionally out.
- **Tyre strategy** (extend the Strategy window): predicted optimal strategies,
  **undercut / overcut** chances per driver pair (gap vs pit-loss vs tyre-deg
  model + track position). Needs a pit-loss constant per circuit + a deg model.
- **Natural-language predictions via a small LM (SLM)**: feed the structured
  predictions + race state into an SLM to produce readable summaries, including
  **edge cases: weather change, SC, VSC**. 
  - Open Q: which SLM and how to host — local (llama.cpp / Ollama, a small
    Qwen/Llama/Gemma) for offline, or the Claude API. Decide hosting; keep the
    numeric predictions deterministic and use the LM only for phrasing/reasoning
    over the computed facts (avoid hallucinated numbers).
  - Core: add `crates/pitwall-core/src/predict.rs` (deterministic) + an optional
    predictions feed/endpoint; LM integration likely a separate service/crate.
- Big feature — build in stages: (a) quali cut-off (simplest, deterministic),
  (b) race podium projection, (c) undercut/overcut, (d) SLM narrative.

## 4. Track Details — weather inline + flag highlighting + sectors

- **Layout**: restructure Track Details to **map on the left, weather on the
  right** (move/duplicate the Weather content in), with race control below.
  (The standalone Weather window can stay as an option, or be removed — decide.)
- **Flag-state map highlighting** driven by `TrackStatus.status` + sector info
  from `RaceControlMessages` (Flag + Scope=Sector + Sector N; distinguish
  `YELLOW` vs `DOUBLE YELLOW`). Visual states on the map:
  | Condition | Visual |
  |-----------|--------|
  | Red flag (status 5) | gentle **blinking red** overlay |
  | Single yellow (RC Flag YELLOW) | **steady yellow**, + show which sector |
  | Double yellow (RC Flag DOUBLE YELLOW) | gentle **blinking yellow** |
  | Safety Car (status 4) | **steady orange-yellow** |
  | Virtual SC (status 6) | gentle **blinking orange-yellow** |
  | Back to green (status 1) | flash **green for ~1s** then clear |
  - Implement as a CSS overlay on the map container with keyframe blink
    animations; a small state machine maps TrackStatus/RC → visual state.
  - Sector-specific tinting on the map geometry needs marshal-sector → map-region
    mapping, which we don't have. **Start with**: whole-map tint + a text badge
    ("Yellow — Sector 7"). Per-sector map regions = later (needs marshal sector
    position data / track segmentation).

## 5. Team radio

- Show **team radio** clips. We already parse `TeamRadioClip { utc, racingNumber,
  path }` (`TeamRadio` topic). Add a radio feed (new window or inside Track
  Details / Race Control) listing clips with driver + timestamp + a play button.
- Audio URL: `https://livetiming.formula1.com/static/<session-path>/<path>` — the
  session path is in `meta.json` (`path`) for exported sessions. For live it's the
  current session base. Play via an HTML `<audio>` element.
- Open Q: expose the session base path to the web (add to SessionInfo/state or a
  REST endpoint) so the client can build audio URLs. For replay/historical the
  clips exist on the F1 static host; confirm CORS (may need the core to proxy the
  audio).

---

## Suggested order next session
1. Quick wins: throttle/brake graphs (#1 first half), team radio feed (#5),
   weather-into-Track-Details + flag highlighting whole-map tint (#4).
2. Timing-tower live delta (#2).
3. Multi-driver telemetry compare (#1 second half).
4. Prediction window in stages (#3): quali cut-off → podium → undercut/overcut →
   SLM narrative.
