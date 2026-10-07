// Prediction window (deterministic v1). Qualifying: projects the elimination
// cut-off line and who's in danger / provisionally out, flagging drivers on a
// live improving lap. Race: a naive podium projection from the current order.
// A templated summary stands in for the SLM narrative (phase 2).

import { useMemo } from "react";
import { useStore, orderByPosition, teamColour, lapMs } from "../store";
import type { SectorDelta } from "../store";
import type { SessionState } from "../types.gen";

type Status = "safe" | "danger" | "out" | "nolap";

interface QualiRow {
  num: string;
  tla: string;
  colour?: string | null;
  best: string | null;
  bestMs: number | null;
  gapToLine: number | null; // ms, + = slower than the cut line
  status: Status;
  improving: boolean;
}

interface QualiPrediction {
  segment: "Q1" | "Q2" | "Q3";
  cutPosition: number | null; // last position that survives
  cutoffMs: number | null;
  rows: QualiRow[];
  summary: string;
}

function fmt(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}` : s.toFixed(3);
}

function fmtGap(ms: number | null): string {
  if (ms == null) return "";
  return `${ms >= 0 ? "+" : ""}${(ms / 1000).toFixed(3)}`;
}

function computeQuali(
  state: SessionState,
  order: string[],
  deltas: Record<string, SectorDelta>,
): QualiPrediction {
  const timing = state.timing ?? {};
  const classified = order.filter((n) => !timing[n]?.retired && !timing[n]?.stopped);
  const n = classified.length;
  // Infer the segment (and elimination line) from how many cars are running.
  const segment = n > 15 ? "Q1" : n > 10 ? "Q2" : "Q3";
  const cutPosition = segment === "Q1" ? 15 : segment === "Q2" ? 10 : null;

  const bestOf = (num: string) => lapMs(timing[num]?.bestLapTime?.value);
  const cutoffNum = cutPosition ? classified[cutPosition - 1] : null;
  const cutoffMs = cutoffNum ? bestOf(cutoffNum) : null;

  const rows: QualiRow[] = classified.map((num, i) => {
    const d = state.drivers?.[num] ?? {};
    const bestMs = bestOf(num);
    const pos = i + 1;
    let status: Status = "safe";
    if (bestMs == null) status = "nolap";
    else if (cutPosition && pos > cutPosition) status = "out";
    else if (cutPosition && pos > cutPosition - 3) status = "danger";
    const improving = (deltas[num]?.deltaMs ?? 1) < 0;
    return {
      num,
      tla: d.tla ?? num,
      colour: d.teamColour,
      best: timing[num]?.bestLapTime?.value ?? null,
      bestMs,
      gapToLine: bestMs != null && cutoffMs != null ? bestMs - cutoffMs : null,
      status,
      improving,
    };
  });

  // Templated narrative (SLM replaces this later).
  const danger = rows.filter((r) => r.status === "danger").map((r) => r.tla);
  const onTrack = rows.filter((r) => (r.status === "out" || r.status === "danger") && r.improving);
  let summary: string;
  if (segment === "Q3") {
    summary = "Q3 — pole shootout, no elimination.";
  } else {
    summary = `${segment} cut-off ~${fmt(cutoffMs)} (P${cutPosition}).`;
    if (danger.length) summary += ` On the bubble: ${danger.join(", ")}.`;
    if (onTrack.length) summary += ` ${onTrack.map((r) => r.tla).join(", ")} on a flying lap — could advance.`;
  }

  return { segment, cutPosition, cutoffMs, rows, summary };
}

function Quali({ pred }: { pred: QualiPrediction }) {
  const setFocus = useStore((s) => s.setFocus);
  const cut = pred.cutPosition;
  return (
    <>
      <div className="pred-summary">{pred.summary}</div>
      <div className="panel-scroll">
        <table className="pred-table">
          <thead>
            <tr>
              <th className="r">P</th>
              <th>Drv</th>
              <th>Best</th>
              <th>vs line</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {pred.rows.map((r, i) => {
              const pos = i + 1;
              const lineAfter = cut != null && pos === cut;
              return (
                <tr
                  key={r.num}
                  className={`pred-row st-${r.status} ${lineAfter ? "cutline" : ""}`}
                  onClick={() => setFocus(r.num)}
                >
                  <td className="r dim tnum">{pos}</td>
                  <td className="drv">
                    <span className="bar" style={{ background: teamColour(r.colour) }} />
                    <b>{r.tla}</b>
                    {r.improving && <span className="pred-live" title="on a flying lap">▲</span>}
                  </td>
                  <td className="tnum">{r.best ?? "—"}</td>
                  <td className="tnum muted">{fmtGap(r.gapToLine)}</td>
                  <td className={`pred-st st-${r.status}`}>{r.status === "nolap" ? "NO TIME" : r.status.toUpperCase()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Approximate time lost on a pit stop (track-dependent); used for undercut math.
const PIT_LOSS_S = 22;
const UNDERCUT_WINDOW_S = 2.5; // within this of the car ahead, a stop likely jumps it
const TYRE_LETTER: Record<string, string> = {
  SOFT: "S",
  MEDIUM: "M",
  HARD: "H",
  INTERMEDIATE: "I",
  WET: "W",
};

function parseSecs(v?: string | null): number | null {
  if (!v || /L/i.test(v)) return null; // "" or lapped ("1L"/"LAP n")
  const m = v.match(/-?\d+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

function Race({
  state,
  order,
}: {
  state: SessionState;
  order: string[];
}) {
  const timing = state.timing ?? {};
  const drivers = state.drivers ?? {};
  const stints = state.stints ?? {};
  const lap = state.lapCount?.currentLap;
  const total = state.lapCount?.totalLaps;

  const tla = (n: string) => drivers[n]?.tla ?? n;
  const lastMs = (n: string) => lapMs(timing[n]?.lastLapTime?.value);
  const compound = (n: string) => stints[n]?.[stints[n].length - 1]?.compound ?? undefined;
  const gapLeader = (n: string) => parseSecs(timing[n]?.gapToLeader) ?? 0;

  const podium = order.slice(0, 3);
  const p3 = podium[2];

  // Podium threats: cars just behind P3 and lapping quicker than the P3 runner.
  const threats = p3
    ? order.slice(3, 9).filter((n) => {
        const behind = gapLeader(n) - gapLeader(p3);
        const lm = lastMs(n);
        const pm = lastMs(p3);
        return behind > 0 && behind < 5 && lm != null && pm != null && lm < pm;
      })
    : [];

  // Undercut windows: a driver within UNDERCUT_WINDOW_S of the car ahead.
  const rows = order.map((n, i) => {
    const ahead = i > 0 ? order[i - 1] : null;
    const interval = parseSecs(timing[n]?.intervalToAhead);
    const undercut = ahead != null && interval != null && interval > 0 && interval <= UNDERCUT_WINDOW_S;
    return { n, pos: i + 1, interval, undercut, ahead };
  });
  const undercuts = rows.filter((r) => r.undercut);

  let summary = `Lap ${lap ?? "?"}/${total ?? "?"}. Projected podium: ${podium.map(tla).join(" · ") || "—"}.`;
  if (threats.length) summary += ` Threat: ${threats.map(tla).join(", ")} closing on the podium.`;
  if (undercuts.length)
    summary += ` Undercut window: ${undercuts.slice(0, 3).map((r) => `${tla(r.n)} on ${tla(r.ahead!)}`).join(", ")}.`;

  return (
    <>
      <div className="pred-summary">{summary}</div>
      <div className="panel-scroll">
        <div className="podium">
          {podium.map((n, i) => {
            const d = drivers[n] ?? {};
            return (
              <div key={n} className={`podium-step p${i + 1}`}>
                <div className="podium-pos">P{i + 1}</div>
                <span className="bar" style={{ background: teamColour(d.teamColour) }} />
                <div className="podium-tla">{d.tla ?? n}</div>
                {threats.length === 0 && i === 2 && <div className="pred-conf dim">clear</div>}
              </div>
            );
          })}
        </div>

        <table className="pred-table">
          <thead>
            <tr>
              <th className="r">P</th>
              <th>Drv</th>
              <th className="c">Tyre</th>
              <th className="r">Pit</th>
              <th>Int</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => {
              const d = drivers[r.n] ?? {};
              const comp = compound(r.n);
              const isThreat = threats.includes(r.n);
              return (
                <tr key={r.n} className="pred-row">
                  <td className="r dim tnum">{r.pos}</td>
                  <td className="drv">
                    <span className="bar" style={{ background: teamColour(d.teamColour) }} />
                    <b>{d.tla ?? r.n}</b>
                  </td>
                  <td className="c">{comp ? TYRE_LETTER[comp] ?? comp[0] : ""}</td>
                  <td className="r tnum muted">{timing[r.n]?.numberOfPitStops ?? ""}</td>
                  <td className="tnum muted">{r.interval != null ? `+${r.interval.toFixed(1)}` : ""}</td>
                  <td className="pred-st">
                    {r.undercut && <span className="st-danger">UNDERCUT</span>}
                    {isThreat && <span className="st-safe"> THREAT</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="pred-note dim">
          Heuristic v1 (pit loss ≈ {PIT_LOSS_S}s). Tyre-deg model and SLM-generated
          narrative to follow.
        </div>
      </div>
    </>
  );
}

export default function Prediction() {
  const state = useStore((s) => s.state);
  const deltas = useStore((s) => s.sectorDeltas);
  const order = orderByPosition(state);
  const type = (state.session?.sessionType ?? "").toLowerCase();
  const isRace = type.includes("race") || type.includes("sprint");

  const quali = useMemo(
    () => (isRace ? null : computeQuali(state, order, deltas)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.timing, state.drivers, deltas, isRace],
  );

  return (
    <div className="panel pred">
      {order.length === 0 ? (
        <div className="empty">Waiting for session data…</div>
      ) : isRace ? (
        <Race state={state} order={order} />
      ) : quali ? (
        <Quali pred={quali} />
      ) : null}
    </div>
  );
}
