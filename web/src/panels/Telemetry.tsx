import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import { useStore, orderByPosition } from "../store";

const MAX_SAMPLES = 600;
const DRS_ON = new Set([8, 10, 12, 14]);

export default function Telemetry() {
  const state = useStore((s) => s.state);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  // Default focus to the leader.
  const order = orderByPosition(state);
  const num = focus ?? order[0] ?? null;
  const car = num ? state.car?.[num] : undefined;
  const driver = num ? state.drivers?.[num] : undefined;

  const plotRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const buf = useRef<{ t: number[]; speed: number[] }>({ t: [], speed: [] });

  // Create the chart once; keep it sized to the container.
  useEffect(() => {
    if (!plotRef.current) return;
    const opts: uPlot.Options = {
      width: plotRef.current.clientWidth || 300,
      height: plotRef.current.clientHeight || 160,
      padding: [8, 8, 0, 0],
      cursor: { show: true, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false }, speed: { range: [0, 360] } },
      axes: [
        { stroke: "var(--dim)", grid: { stroke: "rgba(255,255,255,0.05)" }, ticks: { show: false } },
        {
          scale: "speed",
          stroke: "var(--dim)",
          grid: { stroke: "rgba(255,255,255,0.05)" },
          ticks: { show: false },
        },
      ],
      series: [
        {},
        { scale: "speed", stroke: "#4aa8ff", width: 1.75, label: "Speed" },
      ],
    };
    const u = new uPlot(opts, [[], []], plotRef.current);
    uplotRef.current = u;
    const ro = new ResizeObserver(() => {
      if (plotRef.current) {
        u.setSize({ width: plotRef.current.clientWidth, height: plotRef.current.clientHeight });
      }
    });
    ro.observe(plotRef.current);
    return () => {
      ro.disconnect();
      u.destroy();
      uplotRef.current = null;
    };
  }, []);

  // Reset the rolling buffer when the focused driver changes.
  useEffect(() => {
    buf.current = { t: [], speed: [] };
    uplotRef.current?.setData([[], []]);
  }, [num]);

  // Append a sample whenever a new telemetry frame arrives.
  useEffect(() => {
    if (!car || car.offsetMs == null || car.speed == null) return;
    const b = buf.current;
    const last = b.t[b.t.length - 1];
    if (last === car.offsetMs) return;
    b.t.push(car.offsetMs / 1000);
    b.speed.push(car.speed);
    if (b.t.length > MAX_SAMPLES) {
      b.t.shift();
      b.speed.shift();
    }
    uplotRef.current?.setData([b.t, b.speed]);
  }, [car]);

  const drs = car?.drs != null && DRS_ON.has(car.drs);
  const throttle = car?.throttle ?? 0;
  const brake = car?.brake ?? 0;

  const options = useMemo(
    () =>
      order.map((n) => ({
        n,
        label: state.drivers?.[n]?.tla ?? n,
      })),
    [order, state.drivers],
  );

  return (
    <div className="panel tel">
      <div className="tel-head">
        <select value={num ?? ""} onChange={(e) => setFocus(e.target.value || null)}>
          {options.length === 0 && <option value="">—</option>}
          {options.map((o) => (
            <option key={o.n} value={o.n}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="tel-name">{driver?.fullName ?? ""}</span>
        <span className={`badge ${drs ? "drs-on" : ""}`}>DRS {drs ? "OPEN" : "—"}</span>
      </div>

      <div className="tel-readouts">
        <div className="ro">
          <div className="ro-v tnum">{car?.speed ?? "—"}</div>
          <div className="ro-l">km/h</div>
        </div>
        <div className="ro">
          <div className="ro-v tnum">{car?.gear ?? "—"}</div>
          <div className="ro-l">gear</div>
        </div>
        <div className="ro">
          <div className="ro-v tnum">{car?.rpm ?? "—"}</div>
          <div className="ro-l">rpm</div>
        </div>
      </div>

      <div ref={plotRef} className="tel-plot" />

      <div className="tel-meters">
        <Meter label="THR" value={throttle} color="var(--green)" />
        <Meter label="BRK" value={brake} color="var(--accent)" />
      </div>
    </div>
  );
}

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="meter">
      <span className="meter-l dim">{label}</span>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
      </div>
      <span className="meter-v tnum">{Math.round(value)}</span>
    </div>
  );
}
