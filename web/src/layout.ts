// Thin controller around the dockview API so the top bar can open panels and
// reset the layout without prop-drilling the api everywhere.

import type { DockviewApi } from "dockview";
import { PANELS, type PanelDef } from "./panels";

const LS_KEY = "pw.layout.v1";
let api: DockviewApi | null = null;

export function setApi(a: DockviewApi) {
  api = a;
}

/** Open a panel by definition, focusing it if already present. */
export function openPanel(def: PanelDef) {
  if (!api) return;
  const existing = api.getPanel(def.id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({ id: def.id, component: def.component, title: def.title });
}

/** Lay out the default workspace: timing left, track map + telemetry/race
 *  control grouped on the right. */
export function buildDefault(a: DockviewApi) {
  a.clear();
  a.addPanel({ id: "timing", component: "timingTower", title: "Timing Tower" });
  a.addPanel({
    id: "trackmap",
    component: "trackMap",
    title: "Track Map",
    position: { referencePanel: "timing", direction: "right" },
  });
  a.addPanel({
    id: "telemetry",
    component: "telemetry",
    title: "Telemetry",
    position: { referencePanel: "trackmap", direction: "below" },
  });
  a.addPanel({
    id: "racecontrol",
    component: "raceControl",
    title: "Race Control",
    position: { referencePanel: "telemetry", direction: "within" },
  });
  // Give the timing tower a bit more room.
  api?.getPanel("timing")?.api.setActive();
}

export function resetLayout() {
  if (!api) return;
  buildDefault(api);
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/** Restore a saved layout, or build the default. Called once on ready. */
export function restoreOrDefault(a: DockviewApi) {
  let restored = false;
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      a.fromJSON(JSON.parse(saved));
      // If every panel was closed previously, fall back to default.
      restored = a.panels.length > 0;
    }
  } catch {
    restored = false;
  }
  if (!restored) buildDefault(a);
}

export function persistLayout() {
  if (!api) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(api.toJSON()));
  } catch {
    /* ignore */
  }
}

export const ALL_PANELS = PANELS;
