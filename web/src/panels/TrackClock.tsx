// Track Clock — a "Circle of Doom" view: the ring is one lap of the circuit
// with the start/finish at the top, and every car sits at its real position on
// track. When the session carries Position telemetry (recorded and most live
// sessions) each car is placed by projecting its (x,y) onto the track line — so
// motion is smooth and accurate instead of snapping between mini-sectors. Only
// when there's no position data do we fall back to mini-sectors + gap.
//
// Motion is eased frame-by-frame; overlapping dots are nudged apart radially so
// you can tell them apart and click them; labels are decluttered with
// connectors. Click a car (in a race) to project its pit window at green, VSC
// and Safety-Car pit-loss, with the car it would rejoin behind.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, orderByPosition, teamColour, lapMs } from "../store";
import type { XY } from "../store";

const VB = 440;
const CX = VB / 2;
const CY = VB / 2;
const R = 170; // ring radius
const R_DOT = 170;
const R_LABEL = 187;
const DEFAULT_PIT_LOSS_MS = 22000;
// Pit loss relative to green under neutralisations (the field is slow, so less
// is lost): rough but useful multipliers.
const VSC_FACTOR = 0.55;
const SC_FACTOR = 0.42;

function pt(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}
function fmtRel(ms: number, refLap: number): string {
  const abs = Math.abs(ms);
  if (abs >= refLap) {
    const laps = Math.round(ms / refLap);
    return `${laps > 0 ? "+" : ""}${laps}L`;
  }
  const s = ms / 1000;
  return `${s >= 0 ? "+" : ""}${s.toFixed(1)}`;
}
function angDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

// ---- track centreline (one lap, in feed coordinates) --------------------
interface Loop {
  segs: { ax: number; ay: number; vx: number; vy: number; len: number; cum: number }[];
  total: number;
}
/** Extract one clean lap from the accumulated reference path (which may contain
 *  several), then precompute per-segment cumulative arc length for projection. */
function buildLoop(path: XY[]): Loop | null {
  if (path.length < 24) return null;
  const win = path.slice(0, Math.min(path.length, 1200));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of win) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const closeT = diag * 0.05;
  const awayT = diag * 0.3;
  const s0 = path[0];
  let away = false;
  let end = -1;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - s0.x, path[i].y - s0.y);
    if (d > awayT) away = true;
    if (away && d < closeT && i > 40) { end = i; break; }
  }
  const pts = end > 40 ? path.slice(0, end + 1) : path;
  const segs: Loop["segs"] = [];
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, ay = pts[i].y;
    const vx = pts[i + 1].x - ax, vy = pts[i + 1].y - ay;
    const len = Math.hypot(vx, vy);
    segs.push({ ax, ay, vx, vy, len, cum });
    cum += len;
  }
  if (cum <= 0 || segs.length < 10) return null;
  return { segs, total: cum };
}
/** Fraction (0..1) around the lap of the point nearest (x,y) on the loop. */
function projectFrac(loop: Loop, x: number, y: number): number {
  let best = Infinity;
  let bestFrac = 0;
  for (const s of loop.segs) {
    const t = s.len > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * s.vx + (y - s.ay) * s.vy) / (s.len * s.len))) : 0;
    const px = s.ax + t * s.vx, py = s.ay + t * s.vy;
    const dx = x - px, dy = y - py;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bestFrac = (s.cum + t * s.len) / loop.total; }
  }
  return bestFrac;
}

function declutter(cars: { n: string; angle: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const nn = cars.length;
  if (nn === 0) return out;
  if (nn === 1) { out[cars[0].n] = cars[0].angle; return out; }
  const minSep = Math.min(15, 350 / nn);
  const arr = cars.map((c) => ({ n: c.n, a: ((c.angle % 360) + 360) % 360 })).sort((x, y) => x.a - y.a);
  let maxGap = -1;
  let cut = 0;
  for (let k = 0; k < nn; k++) {
    const next = arr[(k + 1) % nn].a + (k + 1 === nn ? 360 : 0);
    const g = next - arr[k].a;
    if (g > maxGap) { maxGap = g; cut = (k + 1) % nn; }
  }
  const seq: { n: string; a: number }[] = [];
  for (let k = 0; k < nn; k++) {
    const idx = (cut + k) % nn;
    let a = arr[idx].a;
    while (seq.length && a < seq[seq.length - 1].a) a += 360;
    seq.push({ n: arr[idx].n, a });
  }
  const origSpan = seq[nn - 1].a - seq[0].a;
  for (let k = 1; k < nn; k++) {
    if (seq[k].a - seq[k - 1].a < minSep) seq[k].a = seq[k - 1].a + minSep;
  }
  const shift = -((seq[nn - 1].a - seq[0].a - origSpan) / 2);
  for (const s of seq) out[s.n] = (((s.a + shift) % 360) + 360) % 360;
  return out;
}

const STATUS: Record<string, { label: string; color: string }> = {
  "1": { label: "Track Clear", color: "var(--green)" },
  "2": { label: "Yellow", color: "var(--yellow)" },
  "4": { label: "Safety Car", color: "#ff9d2f" },
  "5": { label: "Red Flag", color: "var(--accent)" },
  "6": { label: "Virtual SC", color: "#ff9d2f" },
  "7": { label: "VSC Ending", color: "#ff9d2f" },
};

export default function TrackClock() {
  const state = useStore((s) => s.state);
  const trackPath = useStore((s) => s.trackPath);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const order = orderByPosition(state);

  const loop = useMemo(() => buildLoop(trackPath), [trackPath]);

  const model = useMemo(() => {
    const timing = state.timing ?? {};
    const position = state.position ?? {};
    const active = order.filter((n) => {
      const t = timing[n];
      return !(t?.retired || t?.stopped);
    });

    let refLap: number | null = null;
    for (const n of active) {
      const ms = lapMs(timing[n]?.bestLapTime?.value);
      if (ms != null && (refLap == null || ms < refLap)) refLap = ms;
    }
    if (refLap == null && active[0]) refLap = lapMs(timing[active[0]]?.lastLapTime?.value);
    refLap = refLap ?? 90000;

    // Mini-sector layout — still used for the S1/S2/S3 guide arcs and as the
    // positioning fallback when a car has no (x,y).
    let s1 = 0, s2 = 0, s3 = 0;
    for (const n of active) {
      const secs = timing[n]?.sectors ?? [];
      s1 = Math.max(s1, secs[0]?.segments?.length ?? 0);
      s2 = Math.max(s2, secs[1]?.segments?.length ?? 0);
      s3 = Math.max(s3, secs[2]?.segments?.length ?? 0);
    }
    const total = s1 + s2 + s3;
    const f1 = total ? s1 / total : 1 / 3;
    const f2 = total ? (s1 + s2) / total : 2 / 3;
    const miniFrac = (n: string): number => {
      const secs = timing[n]?.sectors ?? [];
      let passed = 0;
      for (let si = 0; si < 3; si++) {
        for (const seg of secs[si]?.segments ?? []) if (seg.status != null && seg.status > 0) passed++;
      }
      return total > 0 ? Math.min(0.999, passed / total) : 0;
    };

    const gap = (n: string): { ms: number; lapped: boolean } => {
      const s = String(timing[n]?.gapToLeader ?? "").trim();
      const lap = s.match(/(\d+)\s*L\b/i);
      if (lap) return { ms: parseInt(lap[1], 10) * (refLap as number), lapped: true };
      const sec = s.match(/\+?\s*(\d+(?:\.\d+)?)/);
      return { ms: sec ? parseFloat(sec[1]) * 1000 : 0, lapped: false };
    };

    const leader = active[0];
    const behind: Record<string, number> = {};
    for (const n of active) behind[n] = n === leader ? 0 : gap(n).ms;
    const ref = focus && behind[focus] != null ? focus : leader;
    const refBehind = behind[ref] ?? 0;

    const validPos = (n: string) => {
      const p = position[n];
      return p && p.x != null && p.y != null && (p.x !== 0 || p.y !== 0);
    };
    const lp = leader ? position[leader] : undefined;
    const leaderFrac = leader
      ? (loop && lp && validPos(leader) ? projectFrac(loop, lp.x as number, lp.y as number) : miniFrac(leader))
      : 0;

    let anyProgress = leaderFrac > 0;
    const cars = active.map((n) => {
      let frac: number;
      const p = position[n];
      if (loop && p && validPos(n)) {
        frac = projectFrac(loop, p.x as number, p.y as number); // accurate, smooth
      } else {
        // Fallback: leader at its mini-sector position, others behind by gap.
        const g = gap(n);
        if (n === leader) frac = leaderFrac;
        else if (g.lapped) frac = miniFrac(n);
        else frac = leaderFrac - g.ms / (refLap as number);
      }
      frac = ((frac % 1) + 1) % 1;
      if (frac > 0) anyProgress = true;
      const rel = (behind[n] ?? 0) - refBehind;
      return { n, angle: frac * 360, rel, behindLeader: behind[n] ?? 0 };
    });

    const durations = Object.values(state.pitLaneTimes ?? {})
      .map((p) => parseFloat(String(p?.duration ?? "")))
      .filter((x) => Number.isFinite(x) && x > 10 && x < 40)
      .sort((a, b) => a - b);
    const pitLossMs = durations.length ? durations[Math.floor(durations.length / 2)] * 1000 : DEFAULT_PIT_LOSS_MS;

    return { refLap, ref, leader, cars, behind, f1, f2, anyProgress, pitLossMs, usingPos: !!loop };
  }, [state.timing, state.position, state.pitLaneTimes, loop, order, focus]);

  const { refLap, ref, cars, behind, f1, f2, anyProgress, pitLossMs, usingPos } = model;

  // ---- eased motion -------------------------------------------------------
  const dispRef = useRef<Map<string, number>>(new Map());
  const targetRef = useRef<Map<string, number>>(new Map());
  const [, setFrame] = useState(0);
  const liveIds = new Set(cars.map((c) => c.n));
  for (const c of cars) {
    targetRef.current.set(c.n, c.angle);
    if (!dispRef.current.has(c.n)) dispRef.current.set(c.n, c.angle);
  }
  for (const id of [...dispRef.current.keys()]) {
    if (!liveIds.has(id)) { dispRef.current.delete(id); targetRef.current.delete(id); }
  }
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      let moved = false;
      for (const [id, target] of targetRef.current) {
        const cur = dispRef.current.get(id) ?? target;
        const d = angDelta(cur, target);
        if (Math.abs(d) < 0.05) { if (cur !== target) dispRef.current.set(id, target); continue; }
        dispRef.current.set(id, (cur + d * 0.16 + 360) % 360);
        moved = true;
      }
      if (moved) setFrame((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const dispAngle = (n: string, fallback: number) => dispRef.current.get(n) ?? fallback;
  const labelAngles = declutter(cars.map((c) => ({ n: c.n, angle: dispAngle(c.n, c.angle) })));

  // Nudge dots that sit on top of each other apart radially so each stays
  // visible and clickable (the track is physically that tight, not a glitch).
  const dotR: Record<string, number> = {};
  {
    const seq = cars
      .map((c) => ({ n: c.n, a: dispAngle(c.n, c.angle) }))
      .sort((x, y) => x.a - y.a);
    let stack = 0;
    for (let i = 0; i < seq.length; i++) {
      const prev = i > 0 ? seq[i - 1].a : -999;
      stack = seq[i].a - prev < 2.6 ? stack + 1 : 0;
      const step = Math.ceil(stack / 2) * 7 * (stack % 2 === 1 ? 1 : -1);
      dotR[seq[i].n] = R_DOT + step;
    }
  }

  // ---- pit windows (green / VSC / SC) ------------------------------------
  const sessionType = state.session?.sessionType ?? state.session?.sessionName ?? "";
  const isRace = /race|sprint/i.test(sessionType);
  const pitWin = useMemo(() => {
    if (!isRace || !focus || !liveIds.has(focus)) return null;
    const focusAngle = dispAngle(focus, cars.find((c) => c.n === focus)?.angle ?? 0);
    const mk = (loss: number) => {
      const lossFrac = Math.min(0.95, loss / refLap);
      const rejoinAngle = (focusAngle - lossFrac * 360 + 360) % 360;
      const projected = (behind[focus] ?? 0) + loss;
      let out: string | null = null;
      let outVal = -1;
      for (const c of cars) {
        if (c.n === focus) continue;
        const b = behind[c.n] ?? 0;
        if (b <= projected && b > outVal) { outVal = b; out = c.n; }
      }
      return { rejoinAngle, out };
    };
    return {
      focusAngle,
      green: mk(pitLossMs),
      vsc: mk(pitLossMs * VSC_FACTOR),
      sc: mk(pitLossMs * SC_FACTOR),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRace, focus, cars, behind, pitLossMs, refLap]);

  const st = STATUS[state.trackStatus?.status ?? ""] ?? { label: state.trackStatus?.message ?? "—", color: "var(--dim)" };
  const refTla = state.drivers?.[ref]?.tla ?? ref;
  const refLapStr = (() => {
    const m = Math.floor(refLap / 60000);
    const s = (refLap % 60000) / 1000;
    return `${m}:${s.toFixed(3).padStart(6, "0")}`;
  })();

  if (order.length === 0) {
    return <div className="panel"><div className="empty">Waiting for timing data…</div></div>;
  }

  const focusCol = pitWin ? teamColour(state.drivers?.[focus!]?.teamColour) : "";
  const arc = (ang: number, r: number) => {
    const [sx, sy] = pt(ang, r);
    const [ex, ey] = pt(pitWin!.focusAngle, r);
    const span = (pitWin!.focusAngle - ang + 360) % 360;
    return `M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  };
  const PIT_BANDS = pitWin
    ? ([
        { k: "sc", w: pitWin.sc, r: R - 10, color: "#ffd23f", tag: "SC" },
        { k: "vsc", w: pitWin.vsc, r: R - 19, color: "#ff9d2f", tag: "VSC" },
        { k: "green", w: pitWin.green, r: R - 28, color: focusCol, tag: "" },
      ] as const)
    : [];

  return (
    <div className="panel tclock">
      <svg viewBox={`0 0 ${VB} ${VB}`} className="tclock-svg">
        <circle cx={CX} cy={CY} r={R} className="tclock-ring" style={{ stroke: st.color }} />

        {/* pit-window bands + rejoin markers (SC outer, VSC, green inner) */}
        {PIT_BANDS.map((b) => {
          const [ox, oy] = pt(b.w.rejoinAngle, b.r);
          return (
            <g key={b.k}>
              <path d={arc(b.w.rejoinAngle, b.r)} className="tclock-pitwin" style={{ stroke: b.color }} />
              <circle cx={ox} cy={oy} r={4} className="tclock-pitout" style={{ fill: b.color }} />
              {b.tag && (
                <text x={ox} y={oy - 7} className="tclock-pittag" textAnchor="middle" style={{ fill: b.color }}>
                  {b.tag}
                </text>
              )}
            </g>
          );
        })}

        {/* sector boundaries + labels */}
        {[0, f1 * 360, f2 * 360].map((a, i) => {
          const [x1, y1] = pt(a, R - 9);
          const [x2, y2] = pt(a, R + 9);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={i === 0 ? "tclock-sf" : "tclock-tick"} />;
        })}
        {([
          [(f1 / 2) * 360, "S1"],
          [((f1 + f2) / 2) * 360, "S2"],
          [((f2 + 1) / 2) * 360, "S3"],
        ] as const).map(([a, lab]) => {
          const [lx, ly] = pt(a, R - 22);
          return (
            <text key={lab} x={lx} y={ly} className="tclock-sec" textAnchor="middle" dominantBaseline="middle">{lab}</text>
          );
        })}
        <text x={CX} y={CY - R - 16} className="tclock-sf-l" textAnchor="middle">S/F</text>

        {/* center */}
        <text x={CX} y={CY - 18} className="tclock-lap" textAnchor="middle">
          {state.lapCount?.currentLap != null ? `${state.lapCount.currentLap}` : "—"}
          {state.lapCount?.totalLaps ? <tspan className="tclock-lap-t">/{state.lapCount.totalLaps}</tspan> : null}
        </text>
        <text x={CX} y={CY + 8} className="tclock-status" textAnchor="middle" style={{ fill: st.color }}>
          {st.label.toUpperCase()}
        </text>
        {pitWin ? (
          <>
            <text x={CX} y={CY + 28} className="tclock-ref" textAnchor="middle" style={{ fill: focusCol }}>
              {refTla} pit window · ~{(pitLossMs / 1000).toFixed(0)}s
            </text>
            <text x={CX} y={CY + 44} className="tclock-ref dim" textAnchor="middle">
              {pitWin.green.out
                ? `green → behind ${state.drivers?.[pitWin.green.out]?.tla ?? pitWin.green.out}`
                : "green → into the lead"}
            </text>
          </>
        ) : (
          <>
            <text x={CX} y={CY + 28} className="tclock-ref" textAnchor="middle">Ref lap {refLapStr}</text>
            <text x={CX} y={CY + 44} className="tclock-ref dim" textAnchor="middle">
              {usingPos ? "live track positions · click a car" : "click a car"}
            </text>
          </>
        )}

        {/* cars */}
        {cars.map(({ n, rel, behindLeader }) => {
          const angle = dispAngle(n, 0);
          const labelAngle = labelAngles[n] ?? angle;
          const [dx, dy] = pt(angle, dotR[n] ?? R_DOT);
          const [lx, ly] = pt(labelAngle, R_LABEL);
          const right = Math.sin((labelAngle * Math.PI) / 180) >= 0;
          const d = state.drivers?.[n] ?? {};
          const t = state.timing?.[n] ?? {};
          const col = teamColour(d.teamColour);
          const isRef = n === ref;
          const lapsDown = Math.floor(behindLeader / refLap);
          let dl = Math.abs(labelAngle - angle) % 360;
          if (dl > 180) dl = 360 - dl;
          const [cx0, cy0] = pt(angle, (dotR[n] ?? R_DOT) + 2);
          const [cx1, cy1] = pt(labelAngle, R_LABEL - 8);
          return (
            <g key={n} className="tclock-car" onClick={() => setFocus(n)} style={{ cursor: "pointer" }}>
              {dl > 4 && <line x1={cx0} y1={cy0} x2={cx1} y2={cy1} stroke={col} strokeOpacity={0.3} strokeWidth={0.7} />}
              {/* invisible larger hit target so tight dots are still clickable */}
              <circle cx={dx} cy={dy} r={11} fill="transparent" />
              <circle cx={dx} cy={dy} r={isRef || focus === n ? 7 : 5} fill={col} stroke={isRef ? "#fff" : "rgba(0,0,0,.5)"} strokeWidth={isRef ? 1.8 : 1} />
              <g transform={`translate(${lx}, ${ly})`}>
                <text className={`tclock-tla ${t.inPit ? "pit" : ""}`} textAnchor={right ? "start" : "end"} x={right ? 7 : -7} y={-1} style={{ fill: col }}>
                  {d.tla ?? n}
                </text>
                <text className="tclock-gap" textAnchor={right ? "start" : "end"} x={right ? 7 : -7} y={10}>
                  {t.inPit ? "PIT" : isRef ? "" : lapsDown >= 1 ? `${lapsDown}L ${fmtRel(rel, refLap)}` : fmtRel(rel, refLap)}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
      {!anyProgress && (
        <div className="tclock-note dim">
          Cars sweep around the clock as they move around the lap — this fills in once a session is running.
        </div>
      )}
    </div>
  );
}
