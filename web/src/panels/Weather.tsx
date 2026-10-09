import { useStore } from "../store";

/** A tiny line of a numeric series, scaled to its own min/max. */
function Spark({ values, color, label, unit }: { values: number[]; color: string; label: string; unit: string }) {
  if (values.length < 2) return null;
  const W = 240;
  const H = 34;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * H).toFixed(1)}`)
    .join(" ");
  const last = values[values.length - 1];
  return (
    <div className="wx-spark">
      <div className="wx-spark-h">
        <span className="wx-l">{label}</span>
        <span className="tnum" style={{ color }}>
          {last.toFixed(1)}
          {unit} <span className="dim">· {min.toFixed(0)}–{max.toFixed(0)}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="wx-spark-svg">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

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
  const series = useStore((s) => s.state.weatherSeries) ?? [];
  const rain = w.rainfall;
  const track = series.map((s) => s.weather.trackTemp).filter((v): v is number => v != null);
  const air = series.map((s) => s.weather.airTemp).filter((v): v is number => v != null);
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
        {(track.length > 1 || air.length > 1) && (
          <div className="wx-sparks">
            <Spark values={track} color="#ff7a59" label="Track temp" unit="°" />
            <Spark values={air} color="#4aa8ff" label="Air temp" unit="°" />
          </div>
        )}
      </div>
    </div>
  );
}
