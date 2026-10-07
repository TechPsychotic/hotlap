import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { useStore, orderByPosition, teamColour } from "../store";

const MAX_SAMPLES = 900;
const DRS_ON = new Set([8, 10, 12, 14]);

const C_SPEED = "#4aa8ff";
const C_THR = "#28d17c";
const C_BRK = "#e10600";

// A time grid plus one array per plotted series, sampled at the primary
// driver's cadence (each driver contributes its latest value at that instant).
interface Buf {
  t: number[];
  cols: Record<string, (number | null)[]>;
}
const newBuf = (keys: string[]): Buf => ({ t: [], cols: Object.fromEntries(keys.map((k) => [k, []])) });

export default function Telemetry() {
  const state = useStore((s) => s.state);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const [compare, setCompare] = useState<string[]>([]);

  const order = orderByPosition(state);
  const primary = focus ?? order[0] ?? null;
  const car = primary ? state.car?.[primary] : undefined;
  const driver = primary ? state.drivers?.[primary] : undefined;

  // Pin the primary to the current leader once, so it doesn't drift as the
  // running order changes while the user is comparing.
  const didInit = useRef(false);
  useEffect(() => {
    if (!didInit.current && !focus && order[0]) {
      didInit.current = true;
      setFocus(order[0]);
    }
  }, [focus, order, setFocus]);

  // Drivers being plotted (primary first), and whether we're comparing.
  const plotted = useMemo(
    () => (primary ? [primary, ...compare.filter((n) => n !== primary)] : []),
    [primary, compare],
  );
  const comparing = plotted.length > 1;
  const key = plotted.join(",") + (comparing ? "|cmp" : "|solo");

  // Series column keys for the buffer, in uPlot order.
  const colKeys = useMemo(() => {
    if (!comparing) return ["speed", "thr", "brk"];
    return plotted.map((n) => `sp_${n}`);
  }, [plotted, comparing]);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const buf = useRef<Buf>(newBuf(colKeys));
  const lastT = useRef<number>(-1);

  const asData = (): uPlot.AlignedData =>
    [buf.current.t, ...colKeys.map((k) => buf.current.cols[k])] as uPlot.AlignedData;

  // (Re)create the chart whenever the plotted set / mode changes.
  useEffect(() => {
    if (!plotRef.current) return;
    buf.current = newBuf(colKeys);
    lastT.current = -1;

    const axis = {
      stroke: "var(--dim)",
      grid: { stroke: "rgba(255,255,255,0.05)" },
      ticks: { show: false },
      font: "10px ui-monospace, monospace",
    };
    const series: uPlot.Series[] = [{}];
    if (!comparing) {
      series.push({ scale: "speed", stroke: C_SPEED, width: 1.75, label: "Speed" });
      series.push({ scale: "pct", stroke: C_THR, width: 1.5, label: "Throttle" });
      series.push({ scale: "pct", stroke: C_BRK, width: 1.5, label: "Brake" });
    } else {
      for (const n of plotted) {
        series.push({ scale: "speed", stroke: teamColour(state.drivers?.[n]?.teamColour), width: 1.75 });
      }
    }
    const axes: uPlot.Axis[] = [{ ...axis }, { ...axis, scale: "speed", size: 34 }];
    if (!comparing) axes.push({ ...axis, scale: "pct", side: 1, size: 30 });

    const opts: uPlot.Options = {
      width: plotRef.current.clientWidth || 300,
      height: plotRef.current.clientHeight || 160,
      padding: [8, 6, 0, 6],
      cursor: { show: true, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false }, speed: { range: [0, 360] }, pct: { range: [0, 105] } },
      axes,
      series,
    };
    const u = new uPlot(opts, asData(), plotRef.current);
    uplotRef.current = u;
    const ro = new ResizeObserver(() => {
      if (plotRef.current) u.setSize({ width: plotRef.current.clientWidth, height: plotRef.current.clientHeight });
    });
    ro.observe(plotRef.current);
    return () => {
      ro.disconnect();
      u.destroy();
      uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Append a grid row when the primary driver gets a new sample.
  useEffect(() => {
    if (!car || car.offsetMs == null) return;
    const t = car.offsetMs / 1000;
    if (t === lastT.current) return;
    lastT.current = t;
    const b = buf.current;
    b.t.push(t);
    if (!comparing) {
      b.cols["speed"].push(car.speed ?? null);
      b.cols["thr"].push(car.throttle ?? null);
      b.cols["brk"].push(car.brake ?? null);
    } else {
      for (const n of plotted) b.cols[`sp_${n}`].push(state.car?.[n]?.speed ?? null);
    }
    if (b.t.length > MAX_SAMPLES) {
      b.t.shift();
      for (const k of colKeys) b.cols[k].shift();
    }
    uplotRef.current?.setData(asData());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [car]);

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
        <span className="tel-name">{driver?.fullName ?? ""}</span>
        <span className={`badge ${drs ? "drs-on" : ""}`}>DRS {drs ? "OPEN" : "—"}</span>
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

      {!comparing ? (
        <>
          <div className="tel-readouts">
            <div className="ro"><div className="ro-v tnum">{car?.speed ?? "—"}</div><div className="ro-l">km/h</div></div>
            <div className="ro"><div className="ro-v tnum">{car?.gear ?? "—"}</div><div className="ro-l">gear</div></div>
            <div className="ro"><div className="ro-v tnum">{car?.rpm ?? "—"}</div><div className="ro-l">rpm</div></div>
          </div>
          <div className="tel-legend">
            <span style={{ color: C_SPEED }}>● Speed</span>
            <span style={{ color: C_THR }}>● Throttle</span>
            <span style={{ color: C_BRK }}>● Brake</span>
          </div>
        </>
      ) : (
        <div className="tel-legend">
          {plotted.map((n) => (
            <span key={n} style={{ color: teamColour(state.drivers?.[n]?.teamColour) }}>
              ● {state.drivers?.[n]?.tla ?? n} {state.car?.[n]?.speed ?? "—"}
            </span>
          ))}
          <span className="dim">(speed)</span>
        </div>
      )}

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
