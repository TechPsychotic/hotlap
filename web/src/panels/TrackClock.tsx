// Track Clock: every driver placed around a ring by their position on the lap
// (derived from the on-track time gaps), "like a clock". Inspired by the
// F1-MultiViewer track-position view. Center shows lap, status, reference lap and
// the reference driver; the reference is the leader, or any driver you click.

import { useMemo } from "react";
import { useStore, orderByPosition, teamColour, lapMs } from "../store";

const CX = 200;
const CY = 200;
const R = 132;
const R_DOT = 132;
const R_LABEL = 158;

/** Total time (ms) a car is behind the leader, from its gap-to-leader string. */
function gapMs(s: string | null | undefined, refLap: number): number {
  if (!s) return 0;
  const str = String(s).trim();
  const lap = str.match(/(\d+)\s*L(?:AP)?/i);
  const laps = lap ? parseInt(lap[1], 10) : 0;
  const sec = str.match(/\+?\s*(\d+(?:\.\d+)?)\s*$/);
  const seconds = sec && !/L/i.test(str.slice(sec.index ?? 0)) ? parseFloat(sec[1]) : 0;
  return laps * refLap + seconds * 1000;
}

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
    let refLap: number | null = null;
    for (const n of order) {
      const ms = lapMs(timing[n]?.bestLapTime?.value);
      if (ms != null && (refLap == null || ms < refLap)) refLap = ms;
    }
    if (refLap == null && order[0]) refLap = lapMs(timing[order[0]]?.lastLapTime?.value);
    refLap = refLap ?? 90000;

    // Absolute time behind the leader for each car (leader = 0).
    const behind: Record<string, number> = {};
    let anyGap = false;
    for (let i = 0; i < order.length; i++) {
      const n = order[i];
      if (i === 0) {
        behind[n] = 0;
        continue;
      }
      const g = timing[n]?.gapToLeader;
      if (g) anyGap = true;
      behind[n] = gapMs(g, refLap);
    }

    const ref = focus && behind[focus] != null ? focus : order[0];
    const refBehind = behind[ref] ?? 0;

    const cars = order.map((n) => {
      const rel = (behind[n] ?? 0) - refBehind;
      const angle = ((((rel / refLap) * 360) % 360) + 360) % 360;
      return { n, rel, angle, behindLeader: behind[n] ?? 0 };
    });
    return { refLap, ref, cars, anyGap };
  }, [state.timing, order, focus]);

  const { refLap, ref, cars, anyGap } = model;
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
        {/* sector / start-finish ticks (even thirds) */}
        {[0, 120, 240].map((a) => {
          const [x1, y1] = pt(a, R - 8);
          const [x2, y2] = pt(a, R + 8);
          const [lx, ly] = pt(a + 60, R - 20);
          return (
            <g key={a}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} className={a === 0 ? "tclock-sf" : "tclock-tick"} />
              <text x={lx} y={ly} className="tclock-sec" textAnchor="middle" dominantBaseline="middle">
                {a === 0 ? "S1" : a === 120 ? "S2" : "S3"}
              </text>
            </g>
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
      {!anyGap && (
        <div className="tclock-note dim">
          On-track gaps appear during a race — in practice/qualifying everyone sits near the line.
        </div>
      )}
    </div>
  );
}
