import { useStore, orderByPosition, teamColour } from "../store";
import type { LapTime } from "../types.gen";

function lapClass(l?: LapTime | null): string {
  if (!l) return "";
  if (l.overallBest) return "ob";
  if (l.personalBest) return "pb";
  return "";
}

const TYRE: Record<string, string> = {
  SOFT: "#ff4d4d",
  MEDIUM: "#ffd23f",
  HARD: "#e8ebf0",
  INTERMEDIATE: "#28d17c",
  WET: "#4aa8ff",
};

export default function TimingTower() {
  const state = useStore((s) => s.state);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const order = orderByPosition(state);

  return (
    <div className="panel tt">
      <div className="panel-scroll">
        <table className="tt-table">
          <thead>
            <tr>
              <th className="r">P</th>
              <th>Driver</th>
              <th>Gap</th>
              <th>Int</th>
              <th>Last</th>
              <th>Best</th>
              <th className="c">Tyre</th>
              <th className="r">Lap</th>
              <th className="r">Pit</th>
            </tr>
          </thead>
          <tbody>
            {order.map((num) => {
              const d = state.drivers?.[num] ?? {};
              const t = state.timing?.[num] ?? {};
              const stints = state.stints?.[num] ?? [];
              const tyre = stints[stints.length - 1]?.compound ?? undefined;
              const retired = t.retired || t.stopped;
              return (
                <tr
                  key={num}
                  className={`${focus === num ? "focus" : ""} ${retired ? "out" : ""}`}
                  onClick={() => setFocus(num)}
                >
                  <td className="r dim tnum">{t.position ?? ""}</td>
                  <td className="drv">
                    <span className="bar" style={{ background: teamColour(d.teamColour) }} />
                    <b>{d.tla ?? num}</b>
                  </td>
                  <td className={`tnum ${t.inPit ? "yellow" : ""}`}>
                    {t.inPit ? "IN PIT" : (t.gapToLeader ?? "")}
                  </td>
                  <td className="tnum muted">{t.intervalToAhead ?? ""}</td>
                  <td className={`tnum ${lapClass(t.lastLapTime)}`}>{t.lastLapTime?.value ?? ""}</td>
                  <td className={`tnum ${t.bestLapTime?.overallBest ? "ob" : ""}`}>
                    {t.bestLapTime?.value ?? ""}
                  </td>
                  <td className="c">
                    {tyre ? (
                      <span className="tyre" style={{ color: TYRE[tyre] ?? "var(--fg)" }}>
                        {tyre[0]}
                      </span>
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="r tnum muted">{t.numberOfLaps ?? ""}</td>
                  <td className="r tnum muted">{t.numberOfPitStops ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {order.length === 0 && <div className="empty">Waiting for timing data…</div>}
      </div>
    </div>
  );
}
