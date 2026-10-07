import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import {
  useStore,
  orderByPosition,
  teamColour,
  getCurrentLap,
  getLapTrace,
  getLapList,
  getBestLap,
  getFastestLap,
  type LapTrace,
} from "../store";

const DRS_ON = new Set([8, 10, 12, 14]);
const C_SPEED = "#4aa8ff";
const C_THR = "#28d17c";
const C_BRK = "#e10600";

// Compare mode aligns every lap to its own start, so the same point on the
// lap lines up regardless of when each car set it.
const GRID_STEP = 0.5; // seconds
const GRID_MAX = 200; // seconds into a lap
const GRID: number[] = Array.from({ length: Math.floor(GRID_MAX / GRID_STEP) + 1 }, (_, i) => i * GRID_STEP);

// A lap to overlay: the driver plus which of their laps.
type LapKind = "current" | "best" | "fastest" | "lap";
interface Ref {
  driver: string;
  kind: LapKind;
  lap?: number;
}

function refKey(r: Ref): string {
  return `${r.driver}:${r.kind}:${r.lap ?? ""}`;
}

function fmtLap(ms: number | null): string {
  if (ms == null) return "";
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

/** Resolve a lap reference to its trace, source driver and a short label. */
function resolveRef(r: Ref): { trace: LapTrace | null; driver: string; tag: string } {
  switch (r.kind) {
    case "current":
      return { trace: getCurrentLap(r.driver), driver: r.driver, tag: "cur" };
    case "best": {
      const t = getBestLap(r.driver);
      return { trace: t, driver: r.driver, tag: t ? `best L${t.lap}` : "best" };
    }
    case "fastest": {
      const f = getFastestLap();
      return { trace: f?.trace ?? null, driver: f?.driver ?? r.driver, tag: f ? `FL L${f.trace.lap}` : "FL" };
    }
    case "lap": {
      const t = r.lap != null ? getLapTrace(r.driver, r.lap) : null;
      return { trace: t, driver: r.driver, tag: `L${r.lap}` };
    }
  }
}

/** Resample a trace's speed onto the shared seconds-into-lap grid. */
function resample(tr: LapTrace): (number | null)[] {
  const out: (number | null)[] = new Array(GRID.length).fill(null);
  for (let i = 0; i < tr.t.length; i++) {
    const idx = Math.round(tr.t[i] / GRID_STEP);
    if (idx >= 0 && idx < out.length && tr.speed[i] != null) out[idx] = tr.speed[i];
  }
  return out;
}

export default function Telemetry() {
  const state = useStore((s) => s.state);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const [refs, setRefs] = useState<Ref[]>([]);

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

  // Drop comparisons that point at the primary's own current lap (that's the
  // baseline) and de-dupe.
  const activeRefs = useMemo(() => {
    const seen = new Set<string>();
    const out: Ref[] = [];
    for (const r of refs) {
      if (r.driver === primary && r.kind === "current") continue;
      const k = refKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }, [refs, primary]);

  const comparing = activeRefs.length > 0;
  const key = (primary ?? "") + "|" + activeRefs.map(refKey).join(",") + (comparing ? "|cmp" : "|solo");

  // Lines to plot, in order: primary current lap first, then each reference.
  const lines = useMemo(() => {
    if (!primary) return [] as { driver: string; tag: string; dash?: number[] }[];
    const base: { driver: string; tag: string; dash?: number[] }[] = [{ driver: primary, tag: "cur" }];
    const used = new Map<string, number>(); // driver -> times seen (for dashing dupes)
    used.set(primary, 1);
    const extra = activeRefs.map((r) => {
      const { driver, tag } = resolveRef(r);
      const n = (used.get(driver) ?? 0) + 1;
      used.set(driver, n);
      return { driver, tag, dash: n > 1 ? [6, 4] : undefined };
    });
    return [...base, ...extra];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state.drivers]);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);

  // (Re)build the chart when the plotted set / mode changes.
  useEffect(() => {
    if (!plotRef.current) return;
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
      for (const l of lines) {
        series.push({
          scale: "speed",
          stroke: teamColour(state.drivers?.[l.driver]?.teamColour),
          width: 1.75,
          dash: l.dash,
        });
      }
      axes.push({ ...axis, scale: "speed", size: 30 });
      data = [GRID, ...lines.map(() => new Array(GRID.length).fill(null))] as uPlot.AlignedData;
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

  // Feed data on every telemetry tick.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u || !primary) return;
    if (!comparing) {
      const tr = getCurrentLap(primary);
      if (!tr) return;
      u.setData([tr.t, tr.speed, tr.thr, tr.brk]);
      const span = tr.t.length ? tr.t[tr.t.length - 1] : 30;
      u.setScale("x", { min: 0, max: Math.max(30, span + 2) });
    } else {
      let maxIdx = 60;
      const cols = lines.map((l, i) => {
        const tr = i === 0 ? getCurrentLap(l.driver) : resolveRef(activeRefs[i - 1]).trace;
        if (!tr) return new Array(GRID.length).fill(null);
        const col = resample(tr);
        for (let k = col.length - 1; k >= 0; k--) {
          if (col[k] != null) {
            maxIdx = Math.max(maxIdx, k);
            break;
          }
        }
        return col;
      });
      u.setData([GRID, ...cols] as uPlot.AlignedData);
      u.setScale("x", { min: 0, max: (maxIdx + 2) * GRID_STEP });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.car, key]);

  const drs = car?.drs != null && DRS_ON.has(car.drs);
  const options = useMemo(
    () => order.map((n) => ({ n, label: state.drivers?.[n]?.tla ?? n })),
    [order, state.drivers],
  );

  // "Add comparison" controls.
  const [addDriver, setAddDriver] = useState<string>("");
  const [addLap, setAddLap] = useState<string>("best");
  const effAddDriver = addDriver || primary || "";
  const lapOptions = useMemo(() => getLapList(effAddDriver).map((l) => l.lap), [effAddDriver, state.car]);

  const addRef = () => {
    if (!effAddDriver) return;
    let r: Ref;
    if (addLap === "current" || addLap === "best" || addLap === "fastest") {
      r = { driver: effAddDriver, kind: addLap };
    } else {
      r = { driver: effAddDriver, kind: "lap", lap: Number(addLap) };
    }
    setRefs((cur) => (cur.some((x) => refKey(x) === refKey(r)) ? cur : [...cur, r]));
  };
  const removeRef = (r: Ref) => setRefs((cur) => cur.filter((x) => refKey(x) !== refKey(r)));

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
        <span className="tel-name dim">{comparing ? "speed · s into lap" : "current lap"}</span>
      </div>

      <div className="tel-compare">
        <span className="dim">compare</span>
        <select value={addDriver || primary || ""} onChange={(e) => setAddDriver(e.target.value)}>
          {options.map((o) => (
            <option key={o.n} value={o.n}>
              {o.label}
            </option>
          ))}
        </select>
        <select value={addLap} onChange={(e) => setAddLap(e.target.value)}>
          <option value="current">Current lap</option>
          <option value="best">Best lap</option>
          <option value="fastest">Fastest (session)</option>
          {lapOptions.map((n) => (
            <option key={n} value={String(n)}>
              Lap {n}
            </option>
          ))}
        </select>
        <button className="cmp-add" onClick={addRef}>
          + Add
        </button>
        {activeRefs.map((r) => {
          const { driver, tag } = resolveRef(r);
          const tla = state.drivers?.[driver]?.tla ?? driver;
          return (
            <button
              key={refKey(r)}
              className="cmp-chip on"
              style={{ borderColor: teamColour(state.drivers?.[driver]?.teamColour) }}
              onClick={() => removeRef(r)}
              title="Remove"
            >
              {tla} {tag} ✕
            </button>
          );
        })}
      </div>

      <div className="tel-legend">
        {!comparing ? (
          <>
            <span style={{ color: C_SPEED }}>● Speed</span>
            <span style={{ color: C_THR }}>● Throttle</span>
            <span style={{ color: C_BRK }}>● Brake</span>
          </>
        ) : (
          lines.map((l, i) => {
            const res = i === 0 ? { trace: getCurrentLap(l.driver), tag: "cur" } : resolveRef(activeRefs[i - 1]);
            const tla = state.drivers?.[l.driver]?.tla ?? l.driver;
            return (
              <span key={`${l.driver}-${l.tag}-${i}`} style={{ color: teamColour(state.drivers?.[l.driver]?.teamColour) }}>
                ● {tla} {l.tag}
                {res.trace?.timeMs != null ? ` ${fmtLap(res.trace.timeMs)}` : ""}
              </span>
            );
          })
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
