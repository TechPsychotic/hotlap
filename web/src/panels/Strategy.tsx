import { useStore, orderByPosition, teamColour } from "../store";

const TYRE: Record<string, string> = {
  SOFT: "#ff4d4d",
  MEDIUM: "#ffd23f",
  HARD: "#e8ebf0",
  INTERMEDIATE: "#28d17c",
  WET: "#4aa8ff",
};

export default function Strategy() {
  const state = useStore((s) => s.state);
  const setFocus = useStore((s) => s.setFocus);
  const focus = useStore((s) => s.focus);
  const order = orderByPosition(state);
  const totalLaps = state.lapCount?.totalLaps ?? undefined;

  return (
    <div className="panel strat">
      <div className="panel-scroll">
        {order.length === 0 && <div className="empty">Waiting for strategy data…</div>}
        {order.map((num) => {
          const d = state.drivers?.[num] ?? {};
          const stints = state.stints?.[num] ?? [];
          const done = state.timing?.[num]?.numberOfLaps ?? 0;
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
            </div>
          );
        })}
      </div>
      {totalLaps && <div className="strat-foot dim">Race length: {totalLaps} laps</div>}
    </div>
  );
}
