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

interface Store {
  conn: ConnState;
  /** The normalized session state; replaced immutably on every patch. */
  state: SessionState;
  replay: ReplayStatus | null;
  /** Accumulated unique track positions (the circuit outline), maintained in
   *  the store so it survives panels being hidden/unmounted. */
  trail: XY[];
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

export const useStore = create<Store>((set, get) => ({
  conn: "connecting",
  state: EMPTY_STATE,
  replay: null,
  trail: [],
  focus: null,
  setFocus: (num) => set({ focus: num }),
  sendControl: (control) => socket?.send(JSON.stringify({ type: "replayControl", control })),
  _ingest: (msg) => {
    switch (msg.type) {
      case "snapshot": {
        // A snapshot means a fresh/reseeked session: restart the trail.
        resetTrail();
        accumulateTrail(msg.state);
        set({ state: msg.state, trail: [...trailPts] });
        break;
      }
      case "update": {
        const next = mergePatch(get().state, msg.patch);
        const changed = accumulateTrail(next);
        set(changed ? { state: next, trail: [...trailPts] } : { state: next });
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
