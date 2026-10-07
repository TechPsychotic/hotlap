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

function Race({ state, order }: { state: SessionState; order: string[] }) {
  const podium = order.slice(0, 3);
  const names = podium.map((n) => state.drivers?.[n]?.tla ?? n);
  return (
    <>
      <div className="pred-summary">
        Projected podium (naive, current order): {names.join(" · ") || "—"}.
      </div>
      <div className="panel-scroll">
        <div className="podium">
          {podium.map((n, i) => {
            const d = state.drivers?.[n] ?? {};
            return (
              <div key={n} className={`podium-step p${i + 1}`}>
                <div className="podium-pos">P{i + 1}</div>
                <span className="bar" style={{ background: teamColour(d.teamColour) }} />
                <div className="podium-tla">{d.tla ?? n}</div>
              </div>
            );
          })}
        </div>
        <div className="pred-note dim">
          Undercut/overcut and tyre-strategy projection: coming next. Narrative will
          be generated by a small language model in a later phase.
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
