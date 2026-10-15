// Telemetry: the live trace of a single selected driver's current lap —
// speed, throttle and brake against time into the lap — plus live car stats.
// Multi-driver overlays live in the separate Driver Comparison panel.

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import { useStore, orderByPosition, getCurrentLap } from "../store";

const DRS_ON = new Set([8, 10, 12, 14]);
const C_SPEED = "#4aa8ff";
const C_THR = "#28d17c";
const C_BRK = "#e10600";

export default function Telemetry() {
  const state = useStore((s) => s.state);
  const live = useStore((s) => s.live);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  const order = orderByPosition(state);
  const primary = focus ?? order[0] ?? null;
  const car = primary ? state.car?.[primary] : undefined;

  // Pin the primary to the leader once so it doesn't drift.
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current && !focus && order[0]) {
      didInit.current = true;
      setFocus(order[0]);
    }
  }, [focus, order, setFocus]);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);

  // Build the chart once (its series never change in single-driver mode).
  useEffect(() => {
    if (!plotRef.current) return;
    const axis = {
      stroke: "var(--dim)",
      grid: { stroke: "rgba(255,255,255,0.05)" },
      ticks: { show: false },
      font: "10px ui-monospace, monospace",
    };
    const opts: uPlot.Options = {
      width: plotRef.current.clientWidth || 300,
      height: Math.max(60, plotRef.current.clientHeight || 140),
      padding: [6, 6, 0, 4],
      cursor: { show: true, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false }, speed: { range: [0, 360] }, pct: { range: [0, 105] } },
      axes: [
        { ...axis },
        { ...axis, scale: "speed", size: 30 },
        { ...axis, scale: "pct", side: 1, size: 26 },
      ],
      series: [
        {},
        { scale: "speed", stroke: C_SPEED, width: 1.75 },
        { scale: "pct", stroke: C_THR, width: 1.5 },
        { scale: "pct", stroke: C_BRK, width: 1.5 },
      ],
    };
    const u = new uPlot(opts, [[], [], [], []], plotRef.current);
    uplotRef.current = u;
    const ro = new ResizeObserver(() => {
      if (plotRef.current) {
        u.setSize({ width: plotRef.current.clientWidth, height: Math.max(60, plotRef.current.clientHeight) });
      }
    });
    ro.observe(plotRef.current);
    return () => {
      ro.disconnect();
      u.destroy();
      uplotRef.current = null;
    };
  }, []);

  // Feed the primary driver's current lap on every telemetry tick.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u || !primary) return;
    const tr = getCurrentLap(primary);
    if (!tr) return;
    u.setData([tr.t, tr.speed, tr.thr, tr.brk]);
    const span = tr.t.length ? tr.t[tr.t.length - 1] : 30;
    u.setScale("x", { min: 0, max: Math.max(30, span + 2) });
  }, [state.car, primary]);

  const drs = car?.drs != null && DRS_ON.has(car.drs);
  const options = useMemo(
    () => order.map((n) => ({ n, label: state.drivers?.[n]?.tla ?? n })),
    [order, state.drivers],
  );

  if (live) {
    return (
      <div className="panel tel">
        <div className="empty tel-gated">
          Live car telemetry (speed / throttle / brake) is gated behind F1&nbsp;TV.
          <br />
          Set <code>HOTLAP_F1_COOKIE</code> on the server to enable it, or watch a replay.
        </div>
      </div>
    );
  }

  return (
    <div className="panel tel">
      <div className="tel-head">
        <select value={primary ?? ""} onChange={(e) => setFocus(e.target.value || null)}>
          {options.length === 0 && <option value="">—</option>}
          {options.map((o) => (
            <option key={o.n} value={o.n}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="tel-stat">
          <b className="tnum">{car?.speed ?? "—"}</b> km/h
        </span>
        <span className="tel-stat">
          <b className="tnum">{car?.gear ?? "—"}</b> gear
        </span>
        <span className="tel-stat">
          <b className="tnum">{car?.rpm ?? "—"}</b> rpm
        </span>
        <span className={`badge ${drs ? "drs-on" : ""}`}>DRS {drs ? "OPEN" : "—"}</span>
        <span className="tel-name dim">current lap</span>
      </div>

      <div className="tel-legend">
        <span style={{ color: C_SPEED }}>● Speed</span>
        <span style={{ color: C_THR }}>● Throttle</span>
        <span style={{ color: C_BRK }}>● Brake</span>
      </div>

      <div ref={plotRef} className="tel-plot" />

      <div className="tel-meters">
        <Meter label="THR" value={car?.throttle ?? 0} color="var(--green)" />
        <Meter label="BRK" value={car?.brake ?? 0} color="var(--accent)" />
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
