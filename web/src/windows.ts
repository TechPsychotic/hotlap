// Free-floating window manager state: overlapping, movable, resizable windows
// with z-order, minimize, maximize, open/close, and geometry persisted per viewer.

import { create } from "zustand";

export interface WinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WinState extends WinRect {
  id: string;
  z: number;
  open: boolean;
  min: boolean;
  max: boolean;
}

export interface PanelDef {
  id: string;
  title: string;
  component: string;
  /** Whether the window is open in a fresh/default layout (default true). */
  defaultOpen?: boolean;
}

export const PANELS: PanelDef[] = [
  { id: "timing", title: "Timing Tower", component: "timingTower" },
  { id: "trackclock", title: "Track Clock", component: "trackClock" },
  { id: "trackdetails", title: "Track Details", component: "trackDetails" },
  { id: "commentary", title: "Commentary", component: "commentary" },
  { id: "radio", title: "Team Radio", component: "radio" },
  // Closed by default — opened from the taskbar when wanted.
  { id: "telemetry", title: "Telemetry", component: "telemetry", defaultOpen: false },
  { id: "strategy", title: "Strategy", component: "strategy", defaultOpen: false },
  { id: "weather", title: "Weather", component: "weather", defaultOpen: false },
  { id: "racechart", title: "Race Chart", component: "raceChart", defaultOpen: false },
  { id: "prediction", title: "Prediction", component: "prediction", defaultOpen: false },
];

const KEY = "pw.windows.v4";
const MIN_W = 240;
const MIN_H = 140;
export const TASKBAR_H = 34;
const TOPBAR_H = 46;

/** A sensible tiled layout computed from the current viewport. */
export function layout(): Record<string, WinRect> {
  const g = 10;
  const W = Math.max(window.innerWidth || 1680, 760);
  const H = Math.max((window.innerHeight || 900) - TOPBAR_H - TASKBAR_H, 420);
  // Timing Tower wide enough that all columns are visible without scrolling.
  const leftW = Math.min(Math.max(Math.round(W * 0.42), 560), 720);
  const rx = leftW + 2 * g;
  const rw = W - rx - g;
  const tdH = Math.round(H * 0.46);
  const botY = g + tdH + g;
  const botH = H - botY - g;
  const clockW = Math.round(rw * 0.52);
  const commX = rx + clockW + g;
  const commW = rw - clockW - g;
  const commH = Math.round(botH * 0.62);
  return {
    timing: { x: g, y: g, w: leftW, h: H - g },
    trackdetails: { x: rx, y: g, w: rw, h: tdH },
    trackclock: { x: rx, y: botY, w: clockW, h: botH },
    commentary: { x: commX, y: botY, w: commW, h: commH },
    radio: { x: commX, y: botY + commH + g, w: commW, h: botH - commH - g },
    // Closed-by-default panels: sensible spot when opened from the taskbar.
    telemetry: { x: rx, y: botY, w: Math.round(rw * 0.62), h: botH },
    strategy: { x: commX, y: botY, w: commW, h: botH },
    weather: { x: rx, y: Math.round(botY + botH * 0.2), w: Math.min(360, clockW), h: Math.round(botH * 0.6) },
    racechart: { x: Math.round(W * 0.18), y: Math.round(g + H * 0.1), w: Math.round(W * 0.5), h: Math.round(H * 0.62) },
    prediction: { x: Math.round(W * 0.28), y: Math.round(g + H * 0.12), w: 380, h: Math.round(H * 0.7) },
  };
}

interface WinStore {
  wins: Record<string, WinState>;
  topZ: number;
  /** When true, dragging/resizing snaps to edges; toggle off for free placement. */
  snap: boolean;
  toggleSnap: () => void;
  focus: (id: string) => void;
  setRect: (id: string, rect: Partial<WinRect>) => void;
  open: (id: string) => void;
  close: (id: string) => void;
  toggleMin: (id: string) => void;
  toggleMax: (id: string) => void;
  toggle: (id: string) => void;
  reset: () => void;
}

function defaults(): { wins: Record<string, WinState>; topZ: number } {
  const rects = layout();
  const wins: Record<string, WinState> = {};
  let z = 1;
  for (const p of PANELS) {
    wins[p.id] = { ...rects[p.id], id: p.id, z: z++, open: p.defaultOpen ?? true, min: false, max: false };
  }
  return { wins, topZ: PANELS.length };
}

function load(): { wins: Record<string, WinState>; topZ: number } {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved?.wins) {
      for (const id of Object.keys(base.wins)) {
        if (saved.wins[id]) base.wins[id] = { ...base.wins[id], ...saved.wins[id], id };
      }
      base.topZ = Math.max(saved.topZ || 0, PANELS.length);
    }
  } catch {
    /* ignore */
  }
  return base;
}

function persist(state: { wins: Record<string, WinState>; topZ: number }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ wins: state.wins, topZ: state.topZ }));
  } catch {
    /* ignore */
  }
}

export const useWindows = create<WinStore>((set, get) => {
  const patch = (id: string, w: Partial<WinState>, raise = false) =>
    set((s) => {
      const topZ = raise ? s.topZ + 1 : s.topZ;
      const next = {
        ...s,
        topZ,
        wins: { ...s.wins, [id]: { ...s.wins[id], ...w, ...(raise ? { z: topZ } : {}) } },
      };
      persist(next);
      return next;
    });

  const snap0 = (() => {
    try {
      return JSON.parse(localStorage.getItem("pw.snap") || "true") !== false;
    } catch {
      return true;
    }
  })();

  return {
    ...load(),
    snap: snap0,
    toggleSnap: () =>
      set((s) => {
        const snap = !s.snap;
        try {
          localStorage.setItem("pw.snap", JSON.stringify(snap));
        } catch {
          /* ignore */
        }
        return { ...s, snap };
      }),
    focus: (id) => patch(id, {}, true),
    setRect: (id, rect) => patch(id, rect),
    open: (id) => patch(id, { open: true, min: false }, true),
    close: (id) => patch(id, { open: false }),
    toggleMin: (id) => patch(id, { min: !get().wins[id].min }),
    toggleMax: (id) => patch(id, { max: !get().wins[id].max }, true),
    toggle: (id) => {
      const w = get().wins[id];
      if (!w.open || w.min) get().open(id);
      else get().close(id);
    },
    reset: () => {
      const d = defaults();
      set(d);
      persist(d);
    },
  };
});

export { MIN_W, MIN_H };
