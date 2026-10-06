// Track Details: the circuit map (from position data — present on recorded/
// historical sessions, gated on the live free feed) with live flag-state
// highlighting, current weather alongside, and the race-control log below.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, teamColour } from "../store";
import type { RaceControlMessage } from "../types.gen";

const VB = 1000;
const PAD = 60;

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

/** Derive the current flag state from track status + recent race control. */
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

function TrackMapView() {
  const positions = useStore((s) => s.state.position);
  const drivers = useStore((s) => s.state.drivers);
  const trail = useStore((s) => s.trail);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  const live = useMemo(() => {
    const pos = positions ?? {};
    return Object.entries(pos)
      .filter(([, p]) => p.x != null && p.y != null && (p.x !== 0 || p.y !== 0))
      .map(([num, p]) => ({ num, x: p.x as number, y: p.y as number }));
  }, [positions]);

  const bounds = useMemo(() => {
    const src = trail.length > 20 ? trail : live;
    if (src.length === 0) return null;
    const xs = src.map((p) => p.x);
    const ys = src.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [trail, live]);

  const project = (x: number, y: number) => {
    if (!bounds) return { cx: VB / 2, cy: VB / 2 };
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const scale = (VB - 2 * PAD) / span;
    const ox = (VB - (bounds.maxX - bounds.minX) * scale) / 2;
    const oy = (VB - (bounds.maxY - bounds.minY) * scale) / 2;
    return { cx: ox + (x - bounds.minX) * scale, cy: VB - oy - (y - bounds.minY) * scale };
  };

  if (live.length === 0 && trail.length === 0) {
    return <div className="empty">No position data (live positions require F1 TV; available on recorded sessions).</div>;
  }

  return (
    <svg viewBox={`0 0 ${VB} ${VB}`} className="trackmap">
      {trail.map((p, i) => {
        const { cx, cy } = project(p.x, p.y);
        return <circle key={i} cx={cx} cy={cy} r={3.5} className="tm-track" />;
      })}
      {live.map((p) => {
        const { cx, cy } = project(p.x, p.y);
        const d = drivers?.[p.num] ?? {};
        const isFocus = focus === p.num;
        const r = isFocus ? 13 : 9;
        return (
          <g key={p.num} onClick={() => setFocus(p.num)} style={{ cursor: "pointer" }}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={teamColour(d.teamColour)}
              stroke={isFocus ? "var(--fg)" : "rgba(0,0,0,0.55)"}
              strokeWidth={isFocus ? 3 : 1.5}
            />
            <text x={cx} y={cy - r - 5} className="tm-label" textAnchor="middle">
              {d.tla ?? p.num}
            </text>
          </g>
        );
      })}
    </svg>
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
      {row("Humidity", w.humidity, "%")}
      {row("Pressure", w.pressure)}
      <div className="tdw-row">
        <span className="tdw-l">Wind</span>
        <span className="tdw-v tnum">
          <span className="wx-wind" style={{ transform: `rotate(${w.windDirection ?? 0}deg)` }}>
            ↑
          </span>
          {w.windSpeed ?? "—"}
        </span>
      </div>
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

  const flag = computeFlag(track?.status, messages);

  // Flash green for ~1s when the track returns to green.
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
        {flag.sector != null && <span className="dim">Sector {flag.sector}</span>}
        <span className="dim td-status-msg">{track?.message ?? ""}</span>
      </div>
      <div className="td-top">
        <div className="td-mapwrap">
          <TrackMapView />
          {overlayKind !== "none" && <div className={`flag-overlay flag-${overlayKind}`} />}
        </div>
        <WeatherColumn />
      </div>
      <div className="td-rc">
        <div className="td-rc-head dim">Race Control</div>
        <div className="td-rc-list">
          {items.length === 0 && <div className="empty">No messages yet.</div>}
          {items.map((m, i) => (
            <div key={items.length - i} className="rc-row">
              <span className="rc-flag" style={{ background: flagColor(m.flag, m.category) }} />
              <div className="rc-body">
                <div className="rc-msg">{m.message}</div>
                <div className="rc-meta dim">
                  {m.lap != null && <span>L{m.lap}</span>}
                  {m.category && <span>{m.category}</span>}
                  {m.utc && <span>{m.utc.slice(11, 19)}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
