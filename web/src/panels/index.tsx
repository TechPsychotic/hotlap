import type { FC } from "react";
import type { IDockviewPanelProps } from "dockview";
import TimingTower from "./TimingTower";
import TrackMap from "./TrackMap";
import Telemetry from "./Telemetry";
import RaceControl from "./RaceControl";
import Weather from "./Weather";
import Strategy from "./Strategy";

/** Component registry handed to dockview. */
export const components: Record<string, FC<IDockviewPanelProps>> = {
  timingTower: () => <TimingTower />,
  trackMap: () => <TrackMap />,
  telemetry: () => <Telemetry />,
  raceControl: () => <RaceControl />,
  weather: () => <Weather />,
  strategy: () => <Strategy />,
};

/** Metadata for the default layout and the "add panel" menu. */
export interface PanelDef {
  id: string;
  component: string;
  title: string;
}

export const PANELS: PanelDef[] = [
  { id: "timing", component: "timingTower", title: "Timing Tower" },
  { id: "trackmap", component: "trackMap", title: "Track Map" },
  { id: "telemetry", component: "telemetry", title: "Telemetry" },
  { id: "racecontrol", component: "raceControl", title: "Race Control" },
  { id: "weather", component: "weather", title: "Weather" },
  { id: "strategy", component: "strategy", title: "Strategy" },
];
