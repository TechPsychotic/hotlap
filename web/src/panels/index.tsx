import type { ComponentType } from "react";
import TimingTower from "./TimingTower";
import Telemetry from "./Telemetry";
import Strategy from "./Strategy";
import Weather from "./Weather";
import TrackDetails from "./TrackDetails";
import Radio from "./Radio";
import Prediction from "./Prediction";
import Commentary from "./Commentary";
import RaceChart from "./RaceChart";
import TrackClock from "./TrackClock";

/** Maps a window's `component` name to its React component. */
export const COMPONENTS: Record<string, ComponentType> = {
  timingTower: TimingTower,
  telemetry: Telemetry,
  strategy: Strategy,
  weather: Weather,
  trackDetails: TrackDetails,
  radio: Radio,
  prediction: Prediction,
  commentary: Commentary,
  raceChart: RaceChart,
  trackClock: TrackClock,
};
