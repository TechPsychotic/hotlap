// Global app store: a single WebSocket connection feeds a zustand store that
// panels subscribe to with fine-grained selectors.

import { create } from "zustand";
import { mergePatch } from "./merge";
import type {
  ReplayControl,
  ReplayStatus,
  ServerMessage,
  SessionState,
} from "./types.gen";

export type ConnState = "connecting" | "open" | "closed";

export interface XY {
  x: number;
  y: number;
  /** Optional elevation (from Position `Z`), used by the 3D track view. */
  z?: number;
}

/** A driver's running lap delta at the latest completed sector of the current
 *  lap, vs the session-best cumulative time to that sector. */
export interface SectorDelta {
  /** 0-based index of the latest completed sector (0=S1, 1=S2, 2=lap). */
  sector: number;
  /** Signed delta in milliseconds (negative = up on the benchmark). */
  deltaMs: number;
}

interface Store {
  conn: ConnState;
  /** The normalized session state; replaced immutably on every patch. */
  state: SessionState;
  replay: ReplayStatus | null;
  /** Accumulated unique track positions (the circuit outline), maintained in
   *  the store so it survives panels being hidden/unmounted. */
  trail: XY[];
  /** Ordered racing line of a reference car — a clean path for the SVG track. */
  trackPath: XY[];
  /** Live sector delta per driver (racing number), updated as sectors complete. */
  sectorDeltas: Record<string, SectorDelta>;
  /** The driver (racing number) focused by detail panels. */
  focus: string | null;
  setFocus: (num: string | null) => void;
  /** True when the workspace was entered via the live feed (vs a replay). */
  live: boolean;
  setLive: (b: boolean) => void;
  sendControl: (control: ReplayControl) => void;
  /** @internal wired by connect() */
  _ingest: (msg: ServerMessage) => void;
  _setConn: (c: ConnState) => void;
}

const EMPTY_STATE = {} as SessionState;

// Trail accumulation lives outside React so it is cheap and panel-independent.
const TRAIL_GRID = 55;
const TRAIL_CAP = 5000;
let trailKeys = new Set<string>();
let trailPts: XY[] = [];

function accumulateTrail(state: SessionState): boolean {
  const pos = state.position ?? {};
  let changed = false;
  for (const p of Object.values(pos)) {
    if (p.x == null || p.y == null || (p.x === 0 && p.y === 0)) continue;
    const key = `${Math.round(p.x / TRAIL_GRID)},${Math.round(p.y / TRAIL_GRID)}`;
    if (!trailKeys.has(key) && trailKeys.size < TRAIL_CAP) {
      trailKeys.add(key);
      trailPts.push({ x: p.x, y: p.y });
      changed = true;
    }
  }
  return changed;
}

function resetTrail() {
  trailKeys = new Set();
  trailPts = [];
}

// An ordered path traced by a single reference car — a clean circuit outline.
let trackRef: string | null = null;
let trackPts: XY[] = [];

function hasPos(p?: { x?: number | null; y?: number | null }): boolean {
  return !!p && p.x != null && p.y != null && (p.x !== 0 || p.y !== 0);
}

function accumulateTrackPath(state: SessionState): boolean {
  const pos = state.position ?? {};
  if (!trackRef) {
    // Prefer the leader (runs clean racing laps) so the traced line is a full,
    // tidy lap rather than an out/in-lap around a pit stop.
    const timing = state.timing ?? {};
    const leader = Object.keys(timing).find((n) => timing[n]?.position === 1 && hasPos(pos[n]));
    trackRef = leader ?? Object.keys(pos).find((n) => hasPos(pos[n])) ?? null;
  }
  const p = trackRef ? pos[trackRef] : undefined;
  if (!p || p.x == null || p.y == null || (p.x === 0 && p.y === 0)) return false;
  const last = trackPts[trackPts.length - 1];
  const moved = last ? Math.hypot(p.x - last.x, p.y - last.y) : Infinity;
  if (moved > 80 && trackPts.length < 3000) {
    trackPts.push({ x: p.x, y: p.y, z: p.z ?? undefined });
    return true;
  }
  return false;
}

function resetTrackPath() {
  trackRef = null;
  trackPts = [];
}

// ---- per-lap telemetry history ------------------------------------------
// Telemetry samples are bucketed into per-driver, per-lap traces so the
// Telemetry panel can show the *current* lap and overlay any completed lap
// (a specific lap, the driver's best, or the session's fastest).

export interface LapTrace {
  /** Lap number this trace belongs to (the driver's Nth lap). */
  lap: number;
  /** Seconds since the lap's start, per sample. */
  t: number[];
  speed: (number | null)[];
  thr: number[];
  brk: number[];
  /** Lap time in ms (set once the lap completes), else null. */
  timeMs: number | null;
  complete: boolean;
  /** Seconds-into-lap at which S1, S2, S3 completed (null until crossed), used
   *  to plot telemetry against sector position rather than raw time. */
  bounds: (number | null)[];
}

const TEL_CAP = 800; // max samples retained per lap

let telLaps: Record<string, Map<number, LapTrace>> = {}; // completed laps per driver
let telCur: Record<string, LapTrace> = {}; // in-progress lap per driver
let telLapNum: Record<string, number> = {}; // last seen numberOfLaps
let telLapStart: Record<string, number> = {}; // offsetMs at current lap start
let telLastOff: Record<string, number> = {}; // last processed CarData offset
let telSecBase: Record<string, (string | null)[]> = {}; // sector values at lap start
let telSecDone: Record<string, boolean[]> = {}; // which sectors recorded this lap

function newTrace(lap: number): LapTrace {
  return { lap, t: [], speed: [], thr: [], brk: [], timeMs: null, complete: false, bounds: [null, null, null] };
}

function sectorValues(state: SessionState, n: string): (string | null)[] {
  const secs = state.timing?.[n]?.sectors ?? [];
  return [secs[0]?.value ?? null, secs[1]?.value ?? null, secs[2]?.value ?? null];
}

function resetTelemetry() {
  telLaps = {};
  telCur = {};
  telLapNum = {};
  telLapStart = {};
  telLastOff = {};
  telSecBase = {};
  telSecDone = {};
}

function accumulateTelemetry(state: SessionState) {
  const cars = state.car ?? {};
  const timing = state.timing ?? {};
  for (const [n, c] of Object.entries(cars)) {
    if (c.offsetMs == null) continue;
    if (telLastOff[n] === c.offsetMs) continue; // de-dupe repeated frames
    telLastOff[n] = c.offsetMs;
    const laps = timing[n]?.numberOfLaps ?? 0;

    if (telLapNum[n] === undefined) {
      telLapNum[n] = laps;
      telLapStart[n] = c.offsetMs;
      telCur[n] = newTrace(laps + 1);
      telSecBase[n] = sectorValues(state, n);
      telSecDone[n] = [false, false, false];
    } else if (laps > telLapNum[n]) {
      // The car crossed the line: finalize the lap just run, start the next.
      const done = telCur[n];
      if (done && done.t.length > 3) {
        done.lap = laps;
        done.complete = true;
        done.timeMs = lapMs(timing[n]?.lastLapTime?.value ?? null);
        // Close out S3 at the lap's last sample if the boundary wasn't caught.
        if (done.bounds[2] == null) done.bounds[2] = done.t[done.t.length - 1] ?? null;
        (telLaps[n] ??= new Map()).set(laps, done);
      }
      telLapNum[n] = laps;
      telLapStart[n] = c.offsetMs;
      telCur[n] = newTrace(laps + 1);
      telSecBase[n] = sectorValues(state, n);
      telSecDone[n] = [false, false, false];
    }

    const cur = telCur[n];
    if (cur && cur.t.length < TEL_CAP) {
      const ts = (c.offsetMs - telLapStart[n]) / 1000;
      if (cur.t[cur.t.length - 1] !== ts) {
        cur.t.push(ts);
        cur.speed.push(c.speed ?? null);
        cur.thr.push(c.throttle ?? 0);
        cur.brk.push(c.brake ?? 0);
        // Record a sector boundary when its time first appears for this lap.
        const base = telSecBase[n] ?? [null, null, null];
        const done = telSecDone[n] ?? [false, false, false];
        const vals = sectorValues(state, n);
        for (let i = 0; i < 3; i++) {
          if (!done[i] && vals[i] && vals[i] !== base[i]) {
            done[i] = true;
            cur.bounds[i] = ts;
          }
        }
        telSecDone[n] = done;
      }
    }
  }
}

/** The driver's current (in-progress) lap trace. */
export function getCurrentLap(n: string): LapTrace | null {
  return telCur[n] ?? null;
}

/** A specific completed lap trace for a driver. */
export function getLapTrace(n: string, lap: number): LapTrace | null {
  return telLaps[n]?.get(lap) ?? null;
}

/** Completed laps for a driver, ascending by lap number. */
export function getLapList(n: string): LapTrace[] {
  const m = telLaps[n];
  return m ? [...m.values()].sort((a, b) => a.lap - b.lap) : [];
}

/** The driver's own fastest completed lap. */
export function getBestLap(n: string): LapTrace | null {
  let best: LapTrace | null = null;
  for (const l of telLaps[n]?.values() ?? []) {
    if (l.timeMs != null && (!best || l.timeMs < best.timeMs!)) best = l;
  }
  return best;
}

/** The session's fastest completed lap across all drivers. */
export function getFastestLap(): { driver: string; trace: LapTrace } | null {
  let best: { driver: string; trace: LapTrace } | null = null;
  for (const [n, m] of Object.entries(telLaps)) {
    for (const l of m.values()) {
      if (l.timeMs != null && (!best || l.timeMs < best.trace.timeMs!)) best = { driver: n, trace: l };
    }
  }
  return best;
}

// ---- starting grid snapshot ---------------------------------------------
// "Places gained / lost" must be measured from the *race start*, not the last
// lap. The feed's `DriverList.line` tracks the *current* order, so it is
// useless here; `LapSeries.lapPosition[0]` is the grid slot and is stable.
// We lock each driver's grid position once so it can never drift.
let gridPos: Record<string, number> = {};

function resetGrid() {
  gridPos = {};
}

function accumulateGrid(state: SessionState) {
  const ls = state.lapSeries ?? {};
  const timing = state.timing ?? {};
  for (const n of Object.keys(timing)) {
    // The authoritative grid slot, once LapSeries arrives — always trust it.
    const g0 = ls[n]?.lapPosition?.[0];
    if (g0 != null && g0 !== "") {
      const v = parseInt(g0, 10);
      if (!Number.isNaN(v)) {
        gridPos[n] = v;
        continue;
      }
    }
    // Before LapSeries exists, fall back to the first position we ever see
    // (early-race this is the grid); never overwrite once set.
    if (gridPos[n] == null && timing[n]?.position != null) {
      gridPos[n] = timing[n]!.position!;
    }
  }
}

/** A driver's starting-grid position (locked at race start), or null. */
export function getGrid(n: string): number | null {
  return gridPos[n] ?? null;
}

/** Parse "M:SS.mmm" or "SS.mmm" to milliseconds. */
export function lapMs(v?: string | null): number | null {
  if (!v) return null;
  const m = v.match(/^(?:(\d+):)?(\d+)\.(\d+)$/);
  if (!m) return null;
  const min = m[1] ? +m[1] : 0;
  return (min * 60 + +m[2]) * 1000 + +(m[3] + "000").slice(0, 3);
}

// Live sector tracking: per-driver current-lap sector times + session-best
// cumulative times, maintained outside React.
let secPrev: Record<string, (string | null)[]> = {}; // last feed sector strings
let secLive: Record<string, (number | null)[]> = {}; // current-lap sector ms
let bestCum: (number | null)[] = [null, null, null]; // best S1, best S1+S2, best lap

function resetSectors() {
  secPrev = {};
  secLive = {};
  bestCum = [null, null, null];
}

/** Fold sector completions into the live-delta tracker; returns the per-driver
 *  deltas when anything changed, else null. */
function updateSectors(state: SessionState): Record<string, SectorDelta> | null {
  const timing = state.timing ?? {};
  let changed = false;
  for (const [num, t] of Object.entries(timing)) {
    const secs = t.sectors ?? [];
    const prev = secPrev[num] ?? [null, null, null];
    const live = secLive[num] ?? [null, null, null];
    for (let i = 0; i < 3; i++) {
      const v = secs[i]?.value ?? null;
      if (!v || v === prev[i]) continue;
      prev[i] = v;
      const ms = lapMs(v);
      if (i === 0) {
        // A new S1 marks a new lap: reset the live cumulative.
        live[0] = ms;
        live[1] = null;
        live[2] = null;
      } else {
        live[i] = ms;
      }
      if (ms != null) {
        if (i === 0 && (bestCum[0] == null || ms < bestCum[0]!)) bestCum[0] = ms;
        if (i === 1 && live[0] != null) {
          const c = live[0] + ms;
          if (bestCum[1] == null || c < bestCum[1]!) bestCum[1] = c;
        }
        if (i === 2 && live[0] != null && live[1] != null) {
          const c = live[0] + live[1] + ms;
          if (bestCum[2] == null || c < bestCum[2]!) bestCum[2] = c;
        }
      }
      changed = true;
    }
    secPrev[num] = prev;
    secLive[num] = live;
  }
  if (!changed) return null;

  const deltas: Record<string, SectorDelta> = {};
  for (const num of Object.keys(secLive)) {
    const live = secLive[num];
    let k = -1;
    for (let i = 0; i < 3; i++) {
      if (live[i] != null) k = i;
      else break; // only contiguous completed sectors from S1
    }
    if (k >= 0 && bestCum[k] != null) {
      let cum = 0;
      for (let i = 0; i <= k; i++) cum += live[i]!;
      deltas[num] = { sector: k, deltaMs: cum - bestCum[k]! };
    }
  }
  return deltas;
}

export const useStore = create<Store>((set, get) => ({
  conn: "connecting",
  state: EMPTY_STATE,
  replay: null,
  trail: [],
  trackPath: [],
  sectorDeltas: {},
  focus: null,
  setFocus: (num) => set({ focus: num }),
  live: false,
  setLive: (b) => set({ live: b }),
  sendControl: (control) => socket?.send(JSON.stringify({ type: "replayControl", control })),
  _ingest: (msg) => {
    switch (msg.type) {
      case "snapshot": {
        // A snapshot means a fresh/reseeked session: restart derived state.
        resetTrail();
        resetTrackPath();
        resetSectors();
        resetTelemetry();
        resetGrid();
        accumulateTrail(msg.state);
        accumulateTrackPath(msg.state);
        accumulateTelemetry(msg.state);
        accumulateGrid(msg.state);
        set({
          state: msg.state,
          trail: [...trailPts],
          trackPath: [...trackPts],
          sectorDeltas: updateSectors(msg.state) ?? {},
        });
        break;
      }
      case "update": {
        const next = mergePatch(get().state, msg.patch);
        const trailChanged = accumulateTrail(next);
        const pathChanged = accumulateTrackPath(next);
        accumulateTelemetry(next);
        accumulateGrid(next);
        const deltas = updateSectors(next);
        set({
          state: next,
          ...(trailChanged ? { trail: [...trailPts] } : {}),
          ...(pathChanged ? { trackPath: [...trackPts] } : {}),
          ...(deltas ? { sectorDeltas: deltas } : {}),
        });
        break;
      }
      case "replayStatus":
        set({ replay: msg.status });
        break;
      case "error":
        console.error("server error:", msg.message);
        break;
    }
  },
  _setConn: (c) => set({ conn: c }),
}));

let socket: WebSocket | null = null;

/** Open (and keep re-opening) the WebSocket to the core. */
export function connect() {
  const { _ingest, _setConn } = useStore.getState();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;

  const open = () => {
    _setConn("connecting");
    socket = new WebSocket(url);
    socket.onopen = () => _setConn("open");
    socket.onmessage = (ev) => {
      try {
        _ingest(JSON.parse(ev.data) as ServerMessage);
      } catch (e) {
        console.error("bad message", e);
      }
    };
    socket.onclose = () => {
      _setConn("closed");
      setTimeout(open, 1000);
    };
    socket.onerror = () => socket?.close();
  };
  open();
}

// ---- selector helpers ----------------------------------------------------

/** Driver numbers ordered by current track position. */
export function orderByPosition(state: SessionState): string[] {
  const timing = state.timing ?? {};
  return Object.keys(timing).sort(
    (a, b) => (timing[a]?.position ?? 999) - (timing[b]?.position ?? 999),
  );
}

export function teamColour(hex?: string | null): string {
  return hex ? `#${hex}` : "var(--dim)";
}
