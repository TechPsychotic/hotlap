// Track Clock — a "Circle of Doom" (MultiViewer-style) view: the ring is one
// lap of the circuit with the start/finish at the top. The leader sweeps around
// the ring at its own track position (from the mini-sectors it has cleared), and
// every other car is placed *behind* the leader by its real time gap converted
// to a fraction of a lap — so clusters and big gaps on track read at a glance,
// and the whole field rotates like clock hands as the race runs. Lapped cars
// fall back to their own mini-sector position.
//
// Motion is eased frame-by-frame toward each car's target angle, so the discrete
// mini-sector / gap updates glide instead of snapping. Click a car to make it the
// reference and (in a race) project its pit window — where it would rejoin after a
// stop, and which cars sit in that undercut/overcut battle.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, orderByPosition, teamColour, lapMs } from "../store";

const VB = 440;
const CX = VB / 2;
const CY = VB / 2;
const R = 170; // ring radius (bigger ring fills the panel)
const R_DOT = 170;
const R_LABEL = 187;
const DEFAULT_PIT_LOSS_MS = 22000; // typical pit-lane loss when the feed has none

// clockwise angle (deg, 0 = top) → SVG point at radius r.
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

// Shortest signed angular delta from a→b in degrees, result in (-180, 180].
function angDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Fan labels to a minimum angular separation so nose-to-tail cars don't stack.
 *  Cut the ring at its largest gap to give the spread room to fan out. */
function declutter(cars: { n: string; angle: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const nn = cars.length;
  if (nn === 0) return out;
  if (nn === 1) {
    out[cars[0].n] = cars[0].angle;
    return out;
  }
  const minSep = Math.min(15, 350 / nn);
  const arr = cars.map((c) => ({ n: c.n, a: ((c.angle % 360) + 360) % 360 })).sort((x, y) => x.a - y.a);
  let maxGap = -1;
  let cut = 0;
  for (let k = 0; k < nn; k++) {
    const next = arr[(k + 1) % nn].a + (k + 1 === nn ? 360 : 0);
    const g = next - arr[k].a;
    if (g > maxGap) {
      maxGap = g;
      cut = (k + 1) % nn;
    }
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
  const shift = -((seq[nn - 1].a - seq[0].a - origSpan) / 2); // recenter the block
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
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const order = orderByPosition(state);

  const model = useMemo(() => {
    const timing = state.timing ?? {};
    const active = order.filter((n) => {
      const t = timing[n];
      return !(t?.retired || t?.stopped);
    });

    // Reference lap: the session's fastest lap, else the leader's last lap.
    let refLap: number | null = null;
    for (const n of active) {
      const ms = lapMs(timing[n]?.bestLapTime?.value);
      if (ms != null && (refLap == null || ms < refLap)) refLap = ms;
    }
    if (refLap == null && active[0]) refLap = lapMs(timing[active[0]]?.lastLapTime?.value);
    refLap = refLap ?? 90000;

    // Mini-sector layout (segment counts give sector arc lengths).
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
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
        for (const seg of secs[si]?.segments ?? []) {
          if (seg.status != null && seg.status > 0) passed++;
        }
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
    const leaderFrac = leader ? miniFrac(leader) : 0;

    const behind: Record<string, number> = {};
    for (const n of active) behind[n] = n === leader ? 0 : gap(n).ms;
    const ref = focus && behind[focus] != null ? focus : leader;
    const refBehind = behind[ref] ?? 0;

    let anyProgress = leaderFrac > 0;
    const cars = active.map((n) => {
      const g = gap(n);
      let frac: number;
      if (n === leader) frac = leaderFrac;
      else if (g.lapped) frac = miniFrac(n);
      else frac = leaderFrac - g.ms / (refLap as number);
      frac = ((frac % 1) + 1) % 1;
      if (frac > 0) anyProgress = true;
      const rel = (behind[n] ?? 0) - refBehind;
      return { n, angle: frac * 360, rel, behindLeader: behind[n] ?? 0 };
    });

    // Pit-loss estimate for the window projection: the median observed pit-lane
    // time this session, else a typical default.
    const durations = Object.values(state.pitLaneTimes ?? {})
      .map((p) => parseFloat(String(p?.duration ?? "")))
      .filter((x) => Number.isFinite(x) && x > 10 && x < 40)
      .sort((a, b) => a - b);
    const pitLossMs = durations.length
      ? durations[Math.floor(durations.length / 2)] * 1000
      : DEFAULT_PIT_LOSS_MS;

    return { refLap, ref, leader, cars, behind, f1, f2, anyProgress, pitLossMs };
  }, [state.timing, state.pitLaneTimes, order, focus]);

  const { refLap, ref, cars, behind, f1, f2, anyProgress, pitLossMs } = model;

  // ---- eased motion: glide displayed angles toward their targets ----------
  const dispRef = useRef<Map<string, number>>(new Map());
  const targetRef = useRef<Map<string, number>>(new Map());
  const [, setFrame] = useState(0);

  // Update targets each render; snap brand-new cars straight to their target.
  const liveIds = new Set(cars.map((c) => c.n));
  for (const c of cars) {
    targetRef.current.set(c.n, c.angle);
    if (!dispRef.current.has(c.n)) dispRef.current.set(c.n, c.angle);
  }
  for (const id of [...dispRef.current.keys()]) {
    if (!liveIds.has(id)) {
      dispRef.current.delete(id);
      targetRef.current.delete(id);
    }
  }

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      let moved = false;
      for (const [id, target] of targetRef.current) {
        const cur = dispRef.current.get(id) ?? target;
        const d = angDelta(cur, target);
        if (Math.abs(d) < 0.05) {
          if (cur !== target) dispRef.current.set(id, target);
          continue;
        }
        // Ease ~18% of the remaining arc per frame → a smooth glide that settles.
        dispRef.current.set(id, (cur + d * 0.18 + 360) % 360);
        moved = true;
      }
      if (moved) setFrame((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Displayed (eased) angle per car, and decluttered label angles derived from
  // those eased angles so dots and labels move together.
  const dispAngle = (n: string, fallback: number) => dispRef.current.get(n) ?? fallback;
  const labelAngles = declutter(cars.map((c) => ({ n: c.n, angle: dispAngle(c.n, c.angle) })));

  // ---- pit window for the focused car (race strategy) ---------------------
  const sessionType = state.session?.sessionType ?? state.session?.sessionName ?? "";
  const isRace = /race|sprint/i.test(sessionType);
  const pitWin = useMemo(() => {
    if (!isRace || !focus || !liveIds.has(focus)) return null;
    const focusAngle = dispAngle(focus, cars.find((c) => c.n === focus)?.angle ?? 0);
    const lossFrac = Math.min(0.95, pitLossMs / refLap);
    const rejoinAngle = (focusAngle - lossFrac * 360 + 360) % 360;
    // Project where it rejoins: its time-behind-leader plus the pit loss, then
    // find the car it would come out just behind.
    const projected = (behind[focus] ?? 0) + pitLossMs;
    let outBehind: string | null = null;
    let outBehindVal = -1;
    for (const c of cars) {
      if (c.n === focus) continue;
      const b = behind[c.n] ?? 0;
      if (b <= projected && b > outBehindVal) {
        outBehindVal = b;
        outBehind = c.n;
      }
    }
    return { focusAngle, rejoinAngle, outBehind };
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

  // Build the pit-window arc path — a band just inside the ring from the rejoin
  // point to the car's current position, so it reads distinctly from the ring.
  const R_PIT = R - 12;
  let pitArc = "";
  if (pitWin) {
    const [sx, sy] = pt(pitWin.rejoinAngle, R_PIT);
    const [ex, ey] = pt(pitWin.focusAngle, R_PIT);
    const sweepSpan = (pitWin.focusAngle - pitWin.rejoinAngle + 360) % 360;
    const large = sweepSpan > 180 ? 1 : 0;
    pitArc = `M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${R_PIT} ${R_PIT} 0 ${large} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}`;
  }
  const focusCol = pitWin ? teamColour(state.drivers?.[focus!]?.teamColour) : "";

  return (
    <div className="panel tclock">
      <svg viewBox={`0 0 ${VB} ${VB}`} className="tclock-svg">
        {/* ring + status tint */}
        <circle cx={CX} cy={CY} r={R} className="tclock-ring" style={{ stroke: st.color }} />

        {/* pit window band for the focused car */}
        {pitWin && (
          <>
            <path d={pitArc} className="tclock-pitwin" style={{ stroke: focusCol }} />
            {(() => {
              const [ox, oy] = pt(pitWin.rejoinAngle, R);
              return <circle cx={ox} cy={oy} r={5} className="tclock-pitout" style={{ fill: focusCol }} />;
            })()}
          </>
        )}

        {/* sector boundaries + S1/S2/S3 labels mid-arc */}
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
            <text key={lab} x={lx} y={ly} className="tclock-sec" textAnchor="middle" dominantBaseline="middle">
              {lab}
            </text>
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
              {pitWin.outBehind
                ? `rejoins behind ${state.drivers?.[pitWin.outBehind]?.tla ?? pitWin.outBehind}`
                : "rejoins in the lead"}
            </text>
          </>
        ) : (
          <>
            <text x={CX} y={CY + 28} className="tclock-ref" textAnchor="middle">Ref lap {refLapStr}</text>
            <text x={CX} y={CY + 44} className="tclock-ref dim" textAnchor="middle">Gap to {refTla} · click a car</text>
          </>
        )}

        {/* cars */}
        {cars.map(({ n, rel, behindLeader }) => {
          const angle = dispAngle(n, 0);
          const labelAngle = labelAngles[n] ?? angle;
          const [dx, dy] = pt(angle, R_DOT);
          const [lx, ly] = pt(labelAngle, R_LABEL);
          const right = Math.sin((labelAngle * Math.PI) / 180) >= 0;
          const d = state.drivers?.[n] ?? {};
          const t = state.timing?.[n] ?? {};
          const col = teamColour(d.teamColour);
          const isRef = n === ref;
          const lapsDown = Math.floor(behindLeader / refLap);
          let dl = Math.abs(labelAngle - angle) % 360;
          if (dl > 180) dl = 360 - dl;
          const [cx0, cy0] = pt(angle, R + 2);
          const [cx1, cy1] = pt(labelAngle, R_LABEL - 8);
          return (
            <g key={n} className="tclock-car" onClick={() => setFocus(n)} style={{ cursor: "pointer" }}>
              {dl > 4 && (
                <line x1={cx0} y1={cy0} x2={cx1} y2={cy1} stroke={col} strokeOpacity={0.3} strokeWidth={0.7} />
              )}
              <circle
                cx={dx}
                cy={dy}
                r={isRef || focus === n ? 7 : 5}
                fill={col}
                stroke={isRef ? "#fff" : "rgba(0,0,0,.5)"}
                strokeWidth={isRef ? 1.8 : 1}
              />
              <g transform={`translate(${lx}, ${ly})`}>
                <text
                  className={`tclock-tla ${t.inPit ? "pit" : ""}`}
                  textAnchor={right ? "start" : "end"}
                  x={right ? 7 : -7}
                  y={-1}
                  style={{ fill: col }}
                >
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
          Cars sweep around the clock as they complete mini-sectors — this fills in once a session is running.
        </div>
      )}
    </div>
  );
}
