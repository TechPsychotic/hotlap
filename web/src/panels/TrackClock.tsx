// Track Clock — a "Circle of Doom" (MultiViewer-style) view: the ring is one
// lap of the circuit with the start/finish at the top. The leader sweeps around
// the ring at its own track position (from the mini-sectors it has cleared), and
// every other car is placed *behind* the leader by its real time gap converted
// to a fraction of a lap — so clusters and big gaps on track read at a glance,
// and the whole field rotates like clock hands as the race runs. Lapped cars
// fall back to their own mini-sector position. Center shows lap, track status,
// reference lap and the reference driver (the leader, or any car you click).

import { useMemo } from "react";
import { useStore, orderByPosition, teamColour, lapMs } from "../store";

const CX = 200;
const CY = 200;
const R = 132;
const R_DOT = 132;
const R_LABEL = 158;

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
    // Reference lap: the session's fastest lap, else the leader's last lap.
    // It converts a time gap into a fraction of the ring.
    let refLap: number | null = null;
    for (const n of order) {
      const ms = lapMs(timing[n]?.bestLapTime?.value);
      if (ms != null && (refLap == null || ms < refLap)) refLap = ms;
    }
    if (refLap == null && order[0]) refLap = lapMs(timing[order[0]]?.lastLapTime?.value);
    refLap = refLap ?? 90000;

    // The track's mini-sector layout (segment counts give sector arc lengths).
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (const n of order) {
      const secs = timing[n]?.sectors ?? [];
      s1 = Math.max(s1, secs[0]?.segments?.length ?? 0);
      s2 = Math.max(s2, secs[1]?.segments?.length ?? 0);
      s3 = Math.max(s3, secs[2]?.segments?.length ?? 0);
    }
    const total = s1 + s2 + s3;
    const f1 = total ? s1 / total : 1 / 3;
    const f2 = total ? (s1 + s2) / total : 2 / 3;

    // A car's own physical track fraction (0..1), from mini-sectors cleared.
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

    // Time (ms) a car is behind the leader, plus whether it's a lap or more down.
    const gap = (n: string): { ms: number; lapped: boolean } => {
      const s = String(timing[n]?.gapToLeader ?? "").trim();
      const lap = s.match(/(\d+)\s*L\b/i);
      if (lap) return { ms: parseInt(lap[1], 10) * (refLap as number), lapped: true };
      const sec = s.match(/\+?\s*(\d+(?:\.\d+)?)/);
      return { ms: sec ? parseFloat(sec[1]) * 1000 : 0, lapped: false };
    };

    const leader = order[0];
    const leaderFrac = leader ? miniFrac(leader) : 0;

    // Time behind leader (for gap labels); the reference is the leader or a click.
    const behind: Record<string, number> = {};
    for (const n of order) behind[n] = n === leader ? 0 : gap(n).ms;
    const ref = focus && behind[focus] != null ? focus : leader;
    const refBehind = behind[ref] ?? 0;

    // Place each car on the ring: the leader at its own track position, everyone
    // else behind it by their time gap, lapped cars by their own mini-sectors.
    let anyProgress = leaderFrac > 0;
    const cars = order.map((n) => {
      const g = gap(n);
      let frac: number;
      if (n === leader) frac = leaderFrac;
      else if (g.lapped) frac = miniFrac(n);
      else frac = leaderFrac - g.ms / (refLap as number);
      frac = ((frac % 1) + 1) % 1; // wrap into [0,1)
      if (frac > 0) anyProgress = true;
      const rel = (behind[n] ?? 0) - refBehind;
      return { n, angle: frac * 360, rel, behindLeader: behind[n] ?? 0 };
    });
    return { refLap, ref, cars, f1, f2, anyProgress };
  }, [state.timing, order, focus]);

  const { refLap, ref, cars, f1, f2, anyProgress } = model;
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

  return (
    <div className="panel tclock">
      <svg viewBox="0 0 400 400" className="tclock-svg">
        {/* ring + status tint */}
        <circle cx={CX} cy={CY} r={R} className="tclock-ring" style={{ stroke: st.color }} />
        {/* sector boundaries at their real lengths + S1/S2/S3 labels mid-arc */}
        {[0, f1 * 360, f2 * 360].map((a, i) => {
          const [x1, y1] = pt(a, R - 8);
          const [x2, y2] = pt(a, R + 8);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={i === 0 ? "tclock-sf" : "tclock-tick"} />;
        })}
        {([
          [(f1 / 2) * 360, "S1"],
          [((f1 + f2) / 2) * 360, "S2"],
          [((f2 + 1) / 2) * 360, "S3"],
        ] as const).map(([a, lab]) => {
          const [lx, ly] = pt(a, R - 20);
          return (
            <text key={lab} x={lx} y={ly} className="tclock-sec" textAnchor="middle" dominantBaseline="middle">
              {lab}
            </text>
          );
        })}
        {/* start/finish marker at top */}
        <text x={CX} y={CY - R - 14} className="tclock-sf-l" textAnchor="middle">S/F</text>

        {/* center */}
        <text x={CX} y={CY - 18} className="tclock-lap" textAnchor="middle">
          {state.lapCount?.currentLap != null ? `${state.lapCount.currentLap}` : "—"}
          {state.lapCount?.totalLaps ? <tspan className="tclock-lap-t">/{state.lapCount.totalLaps}</tspan> : null}
        </text>
        <text x={CX} y={CY + 8} className="tclock-status" textAnchor="middle" style={{ fill: st.color }}>
          {st.label.toUpperCase()}
        </text>
        <text x={CX} y={CY + 26} className="tclock-ref" textAnchor="middle">Ref lap {refLapStr}</text>
        <text x={CX} y={CY + 42} className="tclock-ref dim" textAnchor="middle">Gap to {refTla}</text>

        {/* cars */}
        {cars.map(({ n, rel, angle, behindLeader }) => {
          const [dx, dy] = pt(angle, R_DOT);
          const [lx, ly] = pt(angle, R_LABEL);
          const right = Math.sin((angle * Math.PI) / 180) >= 0;
          const d = state.drivers?.[n] ?? {};
          const t = state.timing?.[n] ?? {};
          const col = teamColour(d.teamColour);
          const isRef = n === ref;
          const lapsDown = Math.floor(behindLeader / refLap);
          return (
            <g key={n} className="tclock-car" onClick={() => setFocus(n)} style={{ cursor: "pointer" }}>
              <circle cx={dx} cy={dy} r={isRef ? 6 : focus === n ? 6 : 4.5} fill={col} stroke={isRef ? "#fff" : "rgba(0,0,0,.5)"} strokeWidth={isRef ? 1.6 : 1} />
              <g transform={`translate(${lx}, ${ly})`}>
                <text
                  className={`tclock-tla ${t.inPit ? "pit" : ""}`}
                  textAnchor={right ? "start" : "end"}
                  x={right ? 6 : -6}
                  y={-1}
                  style={{ fill: col }}
                >
                  {d.tla ?? n}
                </text>
                <text
                  className="tclock-gap"
                  textAnchor={right ? "start" : "end"}
                  x={right ? 6 : -6}
                  y={9}
                >
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
