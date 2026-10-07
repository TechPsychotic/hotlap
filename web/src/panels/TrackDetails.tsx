// Track Details: a clean SVG track map (2D/3D), current weather, and the
// race-control log — all inline and compact.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, teamColour } from "../store";
import type { XY } from "../store";
import type { RaceControlMessage } from "../types.gen";
import { loadCircuits, matchCircuit, type LngLat } from "../circuits";

const VB = 1000;
const PAD = 70;

type FlagKind = "none" | "green" | "yellow" | "double" | "sc" | "vsc" | "red";
interface FlagState {
  kind: FlagKind;
  sector?: number;
}

const FLAG_LABEL: Record<FlagKind, string> = {
  none: "Clear",
  green: "Green",
  yellow: "Yellow",
  double: "Double Yellow",
  sc: "Safety Car",
  vsc: "Virtual SC",
  red: "Red Flag",
};

function computeFlag(status: string | null | undefined, rc: RaceControlMessage[]): FlagState {
  switch (status) {
    case "5":
      return { kind: "red" };
    case "4":
      return { kind: "sc" };
    case "6":
    case "7":
      return { kind: "vsc" };
    case "2": {
      for (let i = rc.length - 1; i >= 0; i--) {
        const f = (rc[i].flag ?? "").toUpperCase();
        if (f.includes("DOUBLE YELLOW")) return { kind: "double", sector: rc[i].sector ?? undefined };
        if (f === "YELLOW") return { kind: "yellow", sector: rc[i].sector ?? undefined };
        if (f.includes("CLEAR") || f === "GREEN") break;
      }
      return { kind: "yellow" };
    }
    default:
      return { kind: "none" };
  }
}

function flagColor(flag?: string | null, category?: string | null): string {
  const f = (flag ?? "").toUpperCase();
  if (f.includes("RED")) return "var(--accent)";
  if (f.includes("YELLOW")) return "var(--yellow)";
  if (f.includes("GREEN") || f.includes("CLEAR")) return "var(--green)";
  if (f.includes("BLUE")) return "var(--blue)";
  if ((category ?? "").toUpperCase().includes("SAFETYCAR")) return "var(--yellow)";
  return "var(--dim)";
}

function bounds(pts: XY[]) {
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function TrackMapView({ view3d, circuit }: { view3d: boolean; circuit: LngLat[] | null }) {
  const positions = useStore((s) => s.state.position);
  const drivers = useStore((s) => s.state.drivers);
  const trail = useStore((s) => s.trail);
  const path = useStore((s) => s.trackPath);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  const live = useMemo(() => {
    const pos = positions ?? {};
    return Object.entries(pos)
      .filter(([, p]) => p.x != null && p.y != null && (p.x !== 0 || p.y !== 0))
      .map(([num, p]) => ({ num, x: p.x as number, y: p.y as number }));
  }, [positions]);

  const hasPositions = live.length > 0 || path.length > 0 || trail.length > 0;
  // Fall back to the static circuit outline when there's no position data
  // (e.g. live feeds with gated positions).
  const useStatic = !hasPositions && !!circuit && circuit.length > 2;

  const outline: XY[] = useMemo(() => {
    if (useStatic) return circuit!.map(([lng, lat]) => ({ x: lng, y: lat }));
    if (path.length > 10) return path;
    return trail.length ? trail : live;
  }, [useStatic, circuit, path, trail, live]);

  const b = useMemo(() => bounds(outline), [outline]);

  const project = (x: number, y: number) => {
    if (!b) return { cx: VB / 2, cy: VB / 2 };
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
    const scale = (VB - 2 * PAD) / span;
    const ox = (VB - (b.maxX - b.minX) * scale) / 2;
    const oy = (VB - (b.maxY - b.minY) * scale) / 2;
    return { cx: ox + (x - b.minX) * scale, cy: VB - oy - (y - b.minY) * scale };
  };

  const d = useMemo(() => {
    const pts: XY[] | null = useStatic
      ? circuit!.map(([lng, lat]) => ({ x: lng, y: lat }))
      : path.length >= 10
        ? path
        : null;
    if (!pts) return "";
    return (
      pts
        .map((p, i) => {
          const { cx, cy } = project(p.x, p.y);
          return `${i === 0 ? "M" : "L"}${cx.toFixed(1)} ${cy.toFixed(1)}`;
        })
        .join(" ") + " Z"
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useStatic, circuit, path, b]);

  if (!hasPositions && !useStatic) {
    return <div className="empty">No position data, and no circuit outline matched for this session.</div>;
  }

  return (
    <div className={`td-map-inner ${view3d ? "is-3d" : ""}`}>
      <svg viewBox={`0 0 ${VB} ${VB}`} className="trackmap">
        {d ? (
          <path d={d} className="tm-line" />
        ) : (
          trail.map((p, i) => {
            const { cx, cy } = project(p.x, p.y);
            return <circle key={i} cx={cx} cy={cy} r={3.5} className="tm-track" />;
          })
        )}
        {live.map((p) => {
          const { cx, cy } = project(p.x, p.y);
          const dr = drivers?.[p.num] ?? {};
          const isFocus = focus === p.num;
          const r = isFocus ? 13 : 9;
          return (
            <g key={p.num} onClick={() => setFocus(p.num)} style={{ cursor: "pointer" }}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={teamColour(dr.teamColour)}
                stroke={isFocus ? "var(--fg)" : "rgba(0,0,0,0.55)"}
                strokeWidth={isFocus ? 3 : 1.5}
              />
              {isFocus && (
                <text x={cx} y={cy - r - 5} className="tm-label" textAnchor="middle">
                  {dr.tla ?? p.num}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function WeatherColumn() {
  const w = useStore((s) => s.state.weather) ?? {};
  const row = (label: string, value?: number | null, unit = "") => (
    <div className="tdw-row">
      <span className="tdw-l">{label}</span>
      <span className="tdw-v tnum">{value != null ? `${value}${unit}` : "—"}</span>
    </div>
  );
  return (
    <div className="td-weather">
      <div className="td-weather-head dim">Weather</div>
      {row("Air", w.airTemp, "°")}
      {row("Track", w.trackTemp, "°")}
      {row("Hum", w.humidity, "%")}
      {row("Wind", w.windSpeed)}
      <div className="tdw-row">
        <span className="tdw-l">Rain</span>
        <span className={`tdw-v ${w.rainfall ? "blue" : ""}`}>{w.rainfall ? "WET" : "DRY"}</span>
      </div>
    </div>
  );
}

export default function TrackDetails() {
  const track = useStore((s) => s.state.trackStatus);
  const messages = useStore((s) => s.state.raceControl) ?? [];
  const items = [...messages].reverse();
  const [view3d, setView3d] = useState(false);

  // Match a static circuit outline for this session (used when positions are
  // unavailable). Select primitives so the effect only reruns on real changes.
  const circuitName = useStore((s) => s.state.session?.circuit);
  const country = useStore((s) => s.state.session?.country);
  const meetingName = useStore((s) => s.state.session?.meetingName);
  const [circuit, setCircuit] = useState<LngLat[] | null>(null);
  useEffect(() => {
    let ok = true;
    loadCircuits().then((f) => {
      if (ok) setCircuit(matchCircuit(f, { circuit: circuitName, country, meetingName }));
    });
    return () => {
      ok = false;
    };
  }, [circuitName, country, meetingName]);

  const flag = computeFlag(track?.status, messages);
  const [greenFlash, setGreenFlash] = useState(false);
  const prevStatus = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const s = track?.status;
    if (prevStatus.current !== undefined && prevStatus.current !== "1" && s === "1") {
      setGreenFlash(true);
      const t = setTimeout(() => setGreenFlash(false), 1000);
      prevStatus.current = s;
      return () => clearTimeout(t);
    }
    prevStatus.current = s;
  }, [track?.status]);

  const overlayKind: FlagKind = greenFlash ? "green" : flag.kind;

  return (
    <div className="panel td">
      <div className="td-status">
        <span className={`flag-chip flag-${overlayKind}`}>{FLAG_LABEL[overlayKind]}</span>
        {flag.sector != null && <span className="dim">S{flag.sector}</span>}
        <span className="dim td-status-msg">{track?.message ?? ""}</span>
        <div className="td-view">
          <button className={!view3d ? "on" : ""} onClick={() => setView3d(false)}>
            2D
          </button>
          <button className={view3d ? "on" : ""} onClick={() => setView3d(true)}>
            3D
          </button>
        </div>
      </div>
      <div className="td-main">
        <div className="td-mapwrap">
          <TrackMapView view3d={view3d} circuit={circuit} />
          {overlayKind !== "none" && <div className={`flag-overlay flag-${overlayKind}`} />}
        </div>
        <div className="td-side">
          <WeatherColumn />
          <div className="td-rc">
            <div className="td-rc-head dim">Race Control</div>
            <div className="td-rc-list">
              {items.length === 0 && <div className="empty">No messages.</div>}
              {items.map((m, i) => (
                <div key={items.length - i} className="rc-row">
                  <span className="rc-flag" style={{ background: flagColor(m.flag, m.category) }} />
                  <div className="rc-body">
                    <div className="rc-msg">{m.message}</div>
                    <div className="rc-meta dim">
                      {m.lap != null && <span>L{m.lap}</span>}
                      {m.utc && <span>{m.utc.slice(11, 19)}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
