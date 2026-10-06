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
}

export const PANELS: PanelDef[] = [
  { id: "timing", title: "Timing Tower", component: "timingTower" },
  { id: "trackdetails", title: "Track Details", component: "trackDetails" },
  { id: "telemetry", title: "Telemetry", component: "telemetry" },
  { id: "strategy", title: "Strategy", component: "strategy" },
  { id: "weather", title: "Weather", component: "weather" },
];

const KEY = "pw.windows.v2";
const MIN_W = 240;
const MIN_H = 140;
export const TASKBAR_H = 34;
const TOPBAR_H = 46;

/** A sensible tiled layout computed from the current viewport. */
export function layout(): Record<string, WinRect> {
  const g = 10;
  const W = Math.max(window.innerWidth || 1680, 760);
  const H = Math.max((window.innerHeight || 900) - TOPBAR_H - TASKBAR_H, 420);
  const leftW = Math.round(W * 0.37);
  const rightX = leftW + 2 * g;
  const rightW = W - rightX - g;
  const tdH = Math.round(H * 0.52);
  const botY = g + tdH + g;
  const botH = H - botY - g;
  const telW = Math.round(rightW * 0.62);
  const sideX = rightX + telW + g;
  const sideW = rightW - telW - g;
  const stratH = Math.round(botH * 0.58);
  return {
    timing: { x: g, y: g, w: leftW, h: H - g },
    trackdetails: { x: rightX, y: g, w: rightW, h: tdH },
    telemetry: { x: rightX, y: botY, w: telW, h: botH },
    strategy: { x: sideX, y: botY, w: sideW, h: stratH },
    weather: { x: sideX, y: botY + stratH + g, w: sideW, h: botH - stratH - g },
  };
}

interface WinStore {
  wins: Record<string, WinState>;
  topZ: number;
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
    wins[p.id] = { ...rects[p.id], id: p.id, z: z++, open: true, min: false, max: false };
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

  return {
    ...load(),
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
