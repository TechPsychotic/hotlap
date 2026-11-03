// Prediction window. Qualifying: projects the elimination cut-off line and who's
// in danger / provisionally out, flagging drivers on a live improving lap.
// Race: win / podium probabilities from the offline-trained winner model
// (grid→result curves + a rating adjustment, sharpened by race progress) plus
// per-driver strategy calls (box window, undercut) from the tyre-degradation
// and pit-loss model. See web/src/ml.ts and ml/build_models.py.

import { useEffect, useMemo, useState } from "react";
import { useStore, orderByPosition, teamColour, lapMs } from "../store";
import type { SectorDelta } from "../store";
import type { SessionState } from "../types.gen";
import {
  loadModels,
  winProbabilities,
  stintPlan,
  type Models,
  type WinRow,
  type StintPlan,
} from "../ml";

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

function pct(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p < 0.005) return p > 0 ? "<1%" : "—";
  return `${(p * 100).toFixed(0)}%`;
}

const STRAT_LABEL: Record<StintPlan["recommend"], string> = {
  "box-now": "BOX NOW",
  "pit-soon": "PIT SOON",
  hold: "HOLD",
  "run-to-end": "RUN",
  na: "",
};

function Race({
  state,
  order,
  models,
}: {
  state: SessionState;
  order: string[];
  models: Models | null;
}) {
  const timing = state.timing ?? {};
  const drivers = state.drivers ?? {};
  const stints = state.stints ?? {};
  const lap = state.lapCount?.currentLap;
  const total = state.lapCount?.totalLaps;

  const tla = (n: string) => drivers[n]?.tla ?? n;
  const compound = (n: string) => stints[n]?.[stints[n].length - 1]?.compound ?? undefined;

  // Model outputs (recomputed when the order/lap/tyres change).
  const probs = useMemo<Record<string, WinRow>>(
    () => (models ? winProbabilities(models, state) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, state.timing, state.lapCount, state.drivers],
  );
  const plans = useMemo<Record<string, StintPlan>>(() => {
    if (!models) return {};
    const out: Record<string, StintPlan> = {};
    for (const n of order) out[n] = stintPlan(models, state, n);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, state.stints, state.currentTyres, state.lapCount, order.join(",")]);

  const rows = order.map((n, i) => {
    const ahead = i > 0 ? order[i - 1] : null;
    const interval = parseSecs(timing[n]?.intervalToAhead);
    return { n, pos: i + 1, interval, ahead };
  });

  const podium = order.slice(0, 3);
  const favourite = order.reduce(
    (best, n) => ((probs[n]?.win ?? 0) > (probs[best]?.win ?? -1) ? n : best),
    order[0],
  );

  // Undercut: within reach of the car ahead and holding a fresh-tyre edge over
  // it (interval recoverable inside roughly two laps of the learned deg delta).
  const boxing = rows
    .filter((r) => r.ahead && (plans[r.n]?.recommend === "box-now" || plans[r.n]?.recommend === "pit-soon"))
    .map((r) => r.n);

  let summary = `Lap ${lap ?? "?"}/${total ?? "?"}. `;
  if (favourite && probs[favourite]) {
    summary += `Win: ${tla(favourite)} ${pct(probs[favourite].win)}`;
    const second = order.filter((n) => n !== favourite).sort((a, b) => (probs[b]?.win ?? 0) - (probs[a]?.win ?? 0))[0];
    if (second && (probs[second]?.win ?? 0) > 0.05) summary += `, ${tla(second)} ${pct(probs[second].win)}`;
    summary += ". ";
  } else {
    summary += `Projected podium: ${podium.map(tla).join(" · ") || "—"}. `;
  }
  if (boxing.length) summary += `Pit window: ${boxing.slice(0, 3).map(tla).join(", ")}.`;

  return (
    <>
      <div className="pred-summary">{summary}</div>
      <div className="panel-scroll">
        <div className="podium">
          {podium.map((n, i) => {
            const d = drivers[n] ?? {};
            const w = probs[n]?.win;
            return (
              <div key={n} className={`podium-step p${i + 1}`}>
                <div className="podium-pos">P{i + 1}</div>
                <span className="bar" style={{ background: teamColour(d.teamColour) }} />
                <div className="podium-tla">{d.tla ?? n}</div>
                {w != null && <div className="pred-conf dim">{pct(w)} win</div>}
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
              <th className="r">Win</th>
              <th className="r">Pod</th>
              <th>Strategy</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((r) => {
              const d = drivers[r.n] ?? {};
              const comp = compound(r.n);
              const p = probs[r.n];
              const plan = plans[r.n];
              const rec = plan?.recommend ?? "na";
              const note =
                rec === "box-now" || rec === "pit-soon"
                  ? `${STRAT_LABEL[rec]}${plan?.pitLap ? ` L${plan.pitLap}` : ""}${plan?.altCompound ? ` → ${TYRE_LETTER[plan.altCompound] ?? plan.altCompound[0]}` : ""}`
                  : rec === "run-to-end"
                    ? "run to end"
                    : rec === "hold" && plan?.pitLap
                      ? `hold · pit ~L${plan.pitLap}`
                      : "";
              const urgent = rec === "box-now";
              return (
                <tr key={r.n} className="pred-row">
                  <td className="r dim tnum">{r.pos}</td>
                  <td className="drv">
                    <span className="bar" style={{ background: teamColour(d.teamColour) }} />
                    <b>{d.tla ?? r.n}</b>
                  </td>
                  <td className="c">
                    {comp ? TYRE_LETTER[comp] ?? comp[0] : ""}
                    {plan && plan.age > 0 && <span className="dim tnum"> {plan.age}</span>}
                  </td>
                  <td className="r tnum">{p ? pct(p.win) : ""}</td>
                  <td className="r tnum muted">{p ? pct(p.podium) : ""}</td>
                  <td className={`pred-st ${urgent ? "st-danger" : ""}`}>{note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="pred-note dim">
          Win/podium from the trained grid→result model (rating-adjusted, sharpened
          by race progress); strategy from learned tyre-deg + pit-loss curves.
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

  const [models, setModels] = useState<Models | null>(null);
  useEffect(() => {
    let ok = true;
    loadModels().then((m) => ok && setModels(m));
    return () => {
      ok = false;
    };
  }, []);

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
        <Race state={state} order={order} models={models} />
      ) : quali ? (
        <Quali pred={quali} />
      ) : null}
    </div>
  );
}
