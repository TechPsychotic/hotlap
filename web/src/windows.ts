// Free-floating window manager state: overlapping, movable, resizable windows
// with z-order, minimize, open/close, and geometry persisted per viewer.

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
}

export interface PanelDef {
  id: string;
  title: string;
  component: string;
  default: WinRect;
}

/** The available windows and their default geometry (tuned for ~1680px wide). */
export const PANELS: PanelDef[] = [
  { id: "timing", title: "Timing Tower", component: "timingTower", default: { x: 12, y: 12, w: 600, h: 640 } },
  { id: "trackdetails", title: "Track Details", component: "trackDetails", default: { x: 624, y: 12, w: 736, h: 430 } },
  { id: "telemetry", title: "Telemetry", component: "telemetry", default: { x: 624, y: 452, w: 736, h: 380 } },
  { id: "strategy", title: "Strategy", component: "strategy", default: { x: 1372, y: 12, w: 300, h: 500 } },
  { id: "weather", title: "Weather", component: "weather", default: { x: 1372, y: 524, w: 300, h: 308 } },
];

const KEY = "pw.windows.v1";
const MIN_W = 240;
const MIN_H = 140;

interface WinStore {
  wins: Record<string, WinState>;
  topZ: number;
  focus: (id: string) => void;
  setRect: (id: string, rect: Partial<WinRect>) => void;
  open: (id: string) => void;
  close: (id: string) => void;
  toggleMin: (id: string) => void;
  toggle: (id: string) => void;
  reset: () => void;
}

function defaults(): { wins: Record<string, WinState>; topZ: number } {
  const wins: Record<string, WinState> = {};
  let z = 1;
  for (const p of PANELS) {
    wins[p.id] = { ...p.default, id: p.id, z: z++, open: true, min: false };
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
  const save = () => persist(get());
  return {
    ...load(),
    focus: (id) =>
      set((s) => {
        const topZ = s.topZ + 1;
        const next = { ...s, topZ, wins: { ...s.wins, [id]: { ...s.wins[id], z: topZ } } };
        persist(next);
        return next;
      }),
    setRect: (id, rect) =>
      set((s) => {
        const next = { ...s, wins: { ...s.wins, [id]: { ...s.wins[id], ...rect } } };
        persist(next);
        return next;
      }),
    open: (id) =>
      set((s) => {
        const topZ = s.topZ + 1;
        const next = {
          ...s,
          topZ,
          wins: { ...s.wins, [id]: { ...s.wins[id], open: true, min: false, z: topZ } },
        };
        persist(next);
        return next;
      }),
    close: (id) =>
      set((s) => {
        const next = { ...s, wins: { ...s.wins, [id]: { ...s.wins[id], open: false } } };
        persist(next);
        return next;
      }),
    toggleMin: (id) =>
      set((s) => {
        const next = { ...s, wins: { ...s.wins, [id]: { ...s.wins[id], min: !s.wins[id].min } } };
        persist(next);
        return next;
      }),
    toggle: (id) => {
      const w = get().wins[id];
      if (!w.open || w.min) get().open(id);
      else get().close(id);
    },
    reset: () => {
      const d = defaults();
      set(d);
      save();
    },
  };
});

export { MIN_W, MIN_H };
