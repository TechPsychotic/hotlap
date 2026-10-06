import { useStore } from "../store";

function Stat({ label, value, unit }: { label: string; value?: number | null; unit?: string }) {
  return (
    <div className="wx-stat">
      <div className="wx-v tnum">
        {value != null ? value : "—"}
        {value != null && unit ? <span className="wx-u">{unit}</span> : null}
      </div>
      <div className="wx-l">{label}</div>
    </div>
  );
}

export default function Weather() {
  const w = useStore((s) => s.state.weather) ?? {};
  const rain = w.rainfall;
  return (
    <div className="panel wx">
      <div className="panel-scroll wx-grid">
        <Stat label="Air" value={w.airTemp} unit="°C" />
        <Stat label="Track" value={w.trackTemp} unit="°C" />
        <Stat label="Humidity" value={w.humidity} unit="%" />
        <Stat label="Pressure" value={w.pressure} unit="mb" />
        <div className="wx-stat">
          <div className="wx-v">
            <span
              className="wx-wind"
              style={{ transform: `rotate(${w.windDirection ?? 0}deg)` }}
              title={`${w.windDirection ?? "?"}°`}
            >
              ↑
            </span>
            <span className="tnum">{w.windSpeed ?? "—"}</span>
            <span className="wx-u">m/s</span>
          </div>
          <div className="wx-l">Wind</div>
        </div>
        <div className="wx-stat">
          <div className={`wx-v ${rain ? "blue" : ""}`}>{rain ? "WET" : "DRY"}</div>
          <div className="wx-l">Rainfall</div>
        </div>
      </div>
    </div>
  );
}
