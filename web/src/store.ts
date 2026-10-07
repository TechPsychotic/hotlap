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
    trackPts.push({ x: p.x, y: p.y });
    return true;
  }
  return false;
}

function resetTrackPath() {
  trackRef = null;
  trackPts = [];
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
  sendControl: (control) => socket?.send(JSON.stringify({ type: "replayControl", control })),
  _ingest: (msg) => {
    switch (msg.type) {
      case "snapshot": {
        // A snapshot means a fresh/reseeked session: restart derived state.
        resetTrail();
        resetTrackPath();
        resetSectors();
        accumulateTrail(msg.state);
        accumulateTrackPath(msg.state);
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
