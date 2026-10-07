import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { useStore, orderByPosition, teamColour } from "../store";

const DRS_ON = new Set([8, 10, 12, 14]);
const C_SPEED = "#4aa8ff";
const C_THR = "#28d17c";
const C_BRK = "#e10600";

// Compare mode aligns every driver's CURRENT lap to its lap start, so the same
// point on the lap lines up regardless of when each car is on track.
const GRID_STEP = 0.5; // seconds
const GRID_MAX = 170; // seconds into a lap
const GRID: number[] = Array.from({ length: Math.floor(GRID_MAX / GRID_STEP) + 1 }, (_, i) => i * GRID_STEP);
const ROLL_MAX = 900; // solo rolling-window samples

export default function Telemetry() {
  const state = useStore((s) => s.state);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const [compare, setCompare] = useState<string[]>([]);

  const order = orderByPosition(state);
  const primary = focus ?? order[0] ?? null;
  const car = primary ? state.car?.[primary] : undefined;

  // Pin the primary to the leader once so it doesn't drift while comparing.
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current && !focus && order[0]) {
      didInit.current = true;
      setFocus(order[0]);
    }
  }, [focus, order, setFocus]);

  const plotted = useMemo(
    () => (primary ? [primary, ...compare.filter((n) => n !== primary)] : []),
    [primary, compare],
  );
  const comparing = plotted.length > 1;
  const key = plotted.join(",") + (comparing ? "|cmp" : "|solo");

  const plotRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const solo = useRef({ t: [] as number[], speed: [] as (number | null)[], thr: [] as number[], brk: [] as number[] });
  const cmp = useRef<Record<string, (number | null)[]>>({});
  const lap = useRef<Record<string, { num: number; start: number }>>({});
  const lastOff = useRef<Record<string, number>>({});

  // (Re)build the chart when the plotted set / mode changes.
  useEffect(() => {
    if (!plotRef.current) return;
    solo.current = { t: [], speed: [], thr: [], brk: [] };
    cmp.current = {};
    lap.current = {};
    lastOff.current = {};
    for (const n of plotted) cmp.current[n] = new Array(GRID.length).fill(null);

    const axis = {
      stroke: "var(--dim)",
      grid: { stroke: "rgba(255,255,255,0.05)" },
      ticks: { show: false },
      font: "10px ui-monospace, monospace",
    };
    const series: uPlot.Series[] = [{}];
    const axes: uPlot.Axis[] = [{ ...axis }];
    let data: uPlot.AlignedData;
    if (!comparing) {
      series.push({ scale: "speed", stroke: C_SPEED, width: 1.75 });
      series.push({ scale: "pct", stroke: C_THR, width: 1.5 });
      series.push({ scale: "pct", stroke: C_BRK, width: 1.5 });
      axes.push({ ...axis, scale: "speed", size: 30 });
      axes.push({ ...axis, scale: "pct", side: 1, size: 26 });
      data = [[], [], [], []];
    } else {
      for (const n of plotted) {
        series.push({ scale: "speed", stroke: teamColour(state.drivers?.[n]?.teamColour), width: 1.75 });
      }
      axes.push({ ...axis, scale: "speed", size: 30 });
      data = [GRID, ...plotted.map((n) => cmp.current[n])] as uPlot.AlignedData;
    }
    const opts: uPlot.Options = {
      width: plotRef.current.clientWidth || 300,
      height: Math.max(60, plotRef.current.clientHeight || 140),
      padding: [6, 6, 0, 4],
      cursor: { show: true, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false }, speed: { range: [0, 360] }, pct: { range: [0, 105] } },
      axes,
      series,
    };
    const u = new uPlot(opts, data, plotRef.current);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Feed samples on every telemetry tick.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u) return;
    if (!comparing) {
      if (!car || car.offsetMs == null) return;
      const b = solo.current;
      const t = car.offsetMs / 1000;
      if (b.t[b.t.length - 1] === t) return;
      b.t.push(t);
      b.speed.push(car.speed ?? null);
      b.thr.push(car.throttle ?? 0);
      b.brk.push(car.brake ?? 0);
      if (b.t.length > ROLL_MAX) {
        b.t.shift();
        b.speed.shift();
        b.thr.shift();
        b.brk.shift();
      }
      u.setData([b.t, b.speed, b.thr, b.brk]);
    } else {
      let changed = false;
      let maxIdx = 60; // keep at least ~30s of x-axis
      for (const n of plotted) {
        const c = state.car?.[n];
        if (!c || c.offsetMs == null) continue;
        if (lastOff.current[n] !== c.offsetMs) {
          lastOff.current[n] = c.offsetMs;
          const lapNum = state.timing?.[n]?.numberOfLaps ?? 0;
          const prev = lap.current[n];
          if (!prev || lapNum > prev.num) {
            lap.current[n] = { num: lapNum, start: c.offsetMs };
            cmp.current[n] = new Array(GRID.length).fill(null);
            changed = true;
          }
          const idx = Math.round((c.offsetMs - lap.current[n].start) / 1000 / GRID_STEP);
          if (idx >= 0 && idx < GRID.length && c.speed != null) {
            cmp.current[n][idx] = c.speed;
            changed = true;
          }
        }
        // Track the furthest filled sample for a tight x-axis.
        const arr = cmp.current[n];
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] != null) {
            maxIdx = Math.max(maxIdx, i);
            break;
          }
        }
      }
      if (changed) {
        u.setData([GRID, ...plotted.map((n) => cmp.current[n])] as uPlot.AlignedData);
        u.setScale("x", { min: 0, max: (maxIdx + 2) * GRID_STEP });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.car]);

  const drs = car?.drs != null && DRS_ON.has(car.drs);
  const options = useMemo(
    () => order.map((n) => ({ n, label: state.drivers?.[n]?.tla ?? n })),
    [order, state.drivers],
  );
  const toggleCompare = (n: string) =>
    setCompare((c) => (c.includes(n) ? c.filter((x) => x !== n) : c.length < 2 ? [...c, n] : c));

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
        {!comparing ? (
          <>
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
          </>
        ) : (
          <span className="tel-name dim">speed vs lap distance (s into lap)</span>
        )}
      </div>

      <div className="tel-compare">
        <span className="dim">compare:</span>
        {options
          .filter((o) => o.n !== primary)
          .map((o) => (
            <button
              key={o.n}
              className={`cmp-chip ${compare.includes(o.n) ? "on" : ""}`}
              style={compare.includes(o.n) ? { borderColor: teamColour(state.drivers?.[o.n]?.teamColour) } : undefined}
              onClick={() => toggleCompare(o.n)}
            >
              {o.label}
            </button>
          ))}
      </div>

      <div className="tel-legend">
        {!comparing ? (
          <>
            <span style={{ color: C_SPEED }}>● Speed</span>
            <span style={{ color: C_THR }}>● Throttle</span>
            <span style={{ color: C_BRK }}>● Brake</span>
          </>
        ) : (
          plotted.map((n) => (
            <span key={n} style={{ color: teamColour(state.drivers?.[n]?.teamColour) }}>
              ● {state.drivers?.[n]?.tla ?? n} {state.car?.[n]?.speed ?? "—"}
            </span>
          ))
        )}
      </div>

      <div ref={plotRef} className="tel-plot" />

      {!comparing && (
        <div className="tel-meters">
          <Meter label="THR" value={car?.throttle ?? 0} color="var(--green)" />
          <Meter label="BRK" value={car?.brake ?? 0} color="var(--accent)" />
        </div>
      )}
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
