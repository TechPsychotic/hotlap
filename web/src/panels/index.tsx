import type { ComponentType } from "react";
import TimingTower from "./TimingTower";
import Telemetry from "./Telemetry";
import Strategy from "./Strategy";
import Weather from "./Weather";
import TrackDetails from "./TrackDetails";

/** Maps a window's `component` name to its React component. */
export const COMPONENTS: Record<string, ComponentType> = {
  timingTower: TimingTower,
  telemetry: Telemetry,
  strategy: Strategy,
  weather: Weather,
  trackDetails: TrackDetails,
};
