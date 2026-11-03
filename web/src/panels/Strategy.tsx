// Strategy panel: each driver's stint history (tyre bars) plus, in a race, a
// live strategy call from the learned models — current tyre loss (s/lap vs a
// fresh set) and the recommended pit window from a one-stop-from-here simulation
// over the tyre-degradation and pit-loss curves. See web/src/ml.ts.

import { useEffect, useMemo, useState } from "react";
import { useStore, orderByPosition, teamColour } from "../store";
import { loadModels, stintPlan, type Models, type StintPlan } from "../ml";

const TYRE: Record<string, string> = {
  SOFT: "#ff4d4d",
  MEDIUM: "#ffd23f",
  HARD: "#e8ebf0",
  INTERMEDIATE: "#28d17c",
  WET: "#4aa8ff",
};

const REC_LABEL: Record<StintPlan["recommend"], string> = {
  "box-now": "BOX NOW",
  "pit-soon": "PIT SOON",
  hold: "HOLD",
  "run-to-end": "RUN",
  na: "",
};

function recClass(rec: StintPlan["recommend"]): string {
  if (rec === "box-now") return "strat-rec box";
  if (rec === "pit-soon") return "strat-rec soon";
  return "strat-rec hold";
}

export default function Strategy() {
  const state = useStore((s) => s.state);
  const setFocus = useStore((s) => s.setFocus);
  const focus = useStore((s) => s.focus);
  const order = orderByPosition(state);
  const totalLaps = state.lapCount?.totalLaps ?? undefined;
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

  const plans = useMemo<Record<string, StintPlan>>(() => {
    if (!models || !isRace) return {};
    const out: Record<string, StintPlan> = {};
    for (const n of order) out[n] = stintPlan(models, state, n);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, isRace, state.stints, state.currentTyres, state.lapCount, order.join(",")]);

  return (
    <div className="panel strat">
      <div className="panel-scroll">
        {order.length === 0 && <div className="empty">Waiting for strategy data…</div>}
        {order.map((num) => {
          const d = state.drivers?.[num] ?? {};
          const stints = state.stints?.[num] ?? [];
          const done = state.timing?.[num]?.numberOfLaps ?? 0;
          const cur = state.currentTyres?.[num];
          const pit = state.pitLaneTimes?.[num];
          const curColor = cur?.compound ? TYRE[cur.compound] ?? "var(--dim)" : "var(--dim)";
          const plan = plans[num];
          // Tyre-loss meter: scale ~0..2.5 s/lap to a 0..100% fill.
          const lossPct = plan ? Math.min(100, (plan.curLossNow / 2.5) * 100) : 0;
          return (
            <div
              key={num}
              className={`strat-row ${focus === num ? "focus" : ""}`}
              onClick={() => setFocus(num)}
            >
              <span className="bar" style={{ background: teamColour(d.teamColour) }} />
              <span className="strat-tla">{d.tla ?? num}</span>
              <div className="strat-bars">
                {stints.length === 0 && <span className="dim">—</span>}
                {stints.map((st, i) => {
                  const laps = st.totalLaps || (i === stints.length - 1 ? done : 0) || 1;
                  const compound = st.compound ?? "?";
                  return (
                    <span
                      key={i}
                      className="stint"
                      style={{
                        background: `${TYRE[compound] ?? "var(--dim)"}22`,
                        borderColor: TYRE[compound] ?? "var(--dim)",
                        flexGrow: Math.max(1, laps),
                      }}
                      title={`${compound}${st.new ? " (new)" : ""} · ${laps} lap(s)`}
                    >
                      <b style={{ color: TYRE[compound] ?? "var(--fg)" }}>{compound[0]}</b>
                      <span className="dim">{laps}</span>
                    </span>
                  );
                })}
              </div>
              <div className="strat-meta">
                {cur?.compound && (
                  <span className="strat-cur" style={{ borderColor: curColor, color: curColor }} title={`Current: ${cur.compound}${cur.new ? " (new)" : " (used)"}`}>
                    {cur.compound[0]}
                    {cur.new ? "" : "·"}
                  </span>
                )}
                {pit?.duration && (
                  <span className="strat-pit tnum" title={`Pit lane time${pit.lap ? ` · lap ${pit.lap}` : ""}`}>
                    {Number(pit.duration).toFixed(1)}s
                  </span>
                )}
              </div>
              {isRace && plan && plan.recommend !== "na" && (
                <div className="strat-call">
                  <span
                    className="strat-loss"
                    title={`Current tyre loss ≈ ${plan.curLossNow.toFixed(2)} s/lap vs a fresh set`}
                  >
                    <span className="strat-loss-fill" style={{ width: `${lossPct}%` }} />
                  </span>
                  <span className={recClass(plan.recommend)} title={plan.gain > 0 ? `Projected net gain ≈ ${plan.gain.toFixed(1)} s` : "Staying out is quickest to the flag"}>
                    {REC_LABEL[plan.recommend]}
                    {(plan.recommend === "pit-soon" || plan.recommend === "hold") && plan.pitLap ? ` L${plan.pitLap}` : ""}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {totalLaps && (
        <div className="strat-foot dim">
          Race length: {totalLaps} laps{isRace && models ? " · pit calls from learned tyre-deg + pit-loss model" : ""}
        </div>
      )}
    </div>
  );
}
