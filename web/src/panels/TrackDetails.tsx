// Track Details: a clean SVG track map (2D/3D), current weather, and the
// race-control log — all inline and compact.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { XY } from "../store";
import type { RaceControlMessage } from "../types.gen";
import { loadCircuits, matchCircuit, geoToPlanar, type LngLat } from "../circuits";
import type { Highlight } from "./Track3D";

// three.js is heavy; only load it when the 3D view is actually opened.
const Track3D = lazy(() => import("./Track3D"));

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

/** Marshalling sectors currently showing yellow, from the net race-control
 *  state (a YELLOW/DOUBLE YELLOW sets a sector, a CLEAR/GREEN resets it). */
function activeYellows(rc: RaceControlMessage[]): { sector: number; double: boolean }[] {
  const st = new Map<number, boolean>(); // sector -> is double
  for (const m of rc) {
    const s = m.sector;
    if (typeof s !== "number") continue;
    const f = (m.flag ?? "").toUpperCase();
    if (f.includes("YELLOW")) st.set(s, f.includes("DOUBLE"));
    else if (f.includes("CLEAR") || f.includes("GREEN")) st.delete(s);
  }
  return [...st.entries()].map(([sector, double]) => ({ sector, double }));
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

function TrackMapView({
  view3d,
  circuit,
  highlights,
}: {
  view3d: boolean;
  circuit: LngLat[] | null;
  highlights: Highlight[];
}) {
  const trail = useStore((s) => s.trail);
  const path = useStore((s) => s.trackPath);

  // Both 2D and 3D use the real circuit geolocation outline. 3D adds the baked
  // elevation; 2D falls back to the traced line only if no circuit matched.
  const geo = useMemo(() => (circuit && circuit.length > 2 ? geoToPlanar(circuit) : null), [circuit]);
  const outline: XY[] = geo ?? (path.length > 10 ? path : trail);
  const b = useMemo(() => bounds(outline), [outline]);

  const project = (x: number, y: number) => {
    if (!b) return { cx: VB / 2, cy: VB / 2 };
    // Don't floor the span at 1 — geo coords are in degrees (span ≪ 1).
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) || 1;
    const scale = (VB - 2 * PAD) / span;
    const ox = (VB - (b.maxX - b.minX) * scale) / 2;
    const oy = (VB - (b.maxY - b.minY) * scale) / 2;
    return { cx: ox + (x - b.minX) * scale, cy: VB - oy - (y - b.minY) * scale };
  };

  const d = useMemo(() => {
    const pts: XY[] | null = geo ?? (path.length >= 10 ? path : null);
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
  }, [geo, path, b]);

  // The flagged stretches of track, highlighted over the outline.
  const hiPaths = useMemo(() => {
    if (!highlights.length || !geo || geo.length < 3) return [];
    const N = geo.length;
    return highlights
      .map((h) => {
        const i0 = Math.max(0, Math.floor(h.start * N));
        const i1 = Math.min(N - 1, Math.ceil(h.end * N));
        if (i1 - i0 < 1) return null;
        const d = geo
          .slice(i0, i1 + 1)
          .map((p, idx) => {
            const { cx, cy } = project(p.x, p.y);
            return `${idx === 0 ? "M" : "L"}${cx.toFixed(1)} ${cy.toFixed(1)}`;
          })
          .join(" ");
        return { d, double: h.double };
      })
      .filter((x): x is { d: string; double: boolean } => x != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights, geo, b]);

  // Start/finish line: a bar across the track at the outline's first point.
  const start = useMemo(() => {
    const src = geo ?? (path.length >= 10 ? path : null);
    if (!src || src.length < 2 || !b) return null;
    const a = src[0];
    let dx = src[1].x - a.x;
    let dy = src[1].y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L;
    dy /= L;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) || 1;
    const half = span * 0.03; // bar half-width in data units
    const p1 = project(a.x - dy * half, a.y + dx * half);
    const p2 = project(a.x + dy * half, a.y - dx * half);
    return { p1, p2 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, path, b]);

  if (view3d) {
    if (!circuit || circuit.length < 4) {
      return <div className="empty">No circuit geometry matched for this session.</div>;
    }
    return (
      <div className="td-map-inner">
        <Suspense fallback={<div className="empty">Loading 3D…</div>}>
          <Track3D circuit={circuit} highlights={highlights} />
        </Suspense>
      </div>
    );
  }

  if (!outline || outline.length < 3) {
    return <div className="empty">No circuit outline matched for this session.</div>;
  }

  return (
    <div className="td-map-inner">
      <svg viewBox={`0 0 ${VB} ${VB}`} className="trackmap">
        {d ? (
          <path d={d} className="tm-line" />
        ) : (
          trail.map((p, i) => {
            const { cx, cy } = project(p.x, p.y);
            return <circle key={i} cx={cx} cy={cy} r={3.5} className="tm-track" />;
          })
        )}
        {hiPaths.map((h, i) => (
          <path key={i} d={h.d} className={h.double ? "tm-hi-double" : "tm-hi"} />
        ))}
        {start && (
          <line x1={start.p1.cx} y1={start.p1.cy} x2={start.p2.cx} y2={start.p2.cy} className="tm-start" />
        )}
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

  // Highlight the flagged stretches of track during yellows. Race control
  // reports marshalling-sector numbers; map each currently-yellow sector to a
  // lap fraction using the highest sector seen this session as the sector
  // count. (Approximate: it assumes the outline starts at the start/finish line
  // and runs in the outline's point order.)
  const highlights: Highlight[] = useMemo(() => {
    if (track?.status !== "2") return [];
    let max = 0;
    for (const m of messages) if (typeof m.sector === "number" && m.sector > max) max = m.sector;
    if (max <= 0) return [];
    return activeYellows(messages).map(({ sector, double }) => ({
      start: (sector - 1) / max,
      end: sector / max,
      double,
    }));
  }, [messages, track?.status]);

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
          <TrackMapView view3d={view3d} circuit={circuit} highlights={highlights} />
          {overlayKind !== "none" && <div className={`flag-overlay flag-${overlayKind}`} />}
        </div>
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
  );
}
