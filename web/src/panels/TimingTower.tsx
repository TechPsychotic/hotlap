import { useStore, orderByPosition, teamColour } from "../store";
import type { LapTime, Sector } from "../types.gen";

function lapClass(l?: LapTime | null): string {
  if (!l) return "";
  if (l.overallBest) return "ob";
  if (l.personalBest) return "pb";
  return "";
}

// Feed mini-sector status codes -> colour.
function segColor(status?: number | null): string {
  switch (status) {
    case 2051:
    case 2052:
      return "var(--purple)";
    case 2049:
      return "var(--green)";
    case 2048:
      return "var(--yellow)";
    case 2064:
      return "var(--blue)"; // pit / other
    default:
      return "var(--line-2)";
  }
}

function SectorCell({ sector }: { sector?: Sector }) {
  const segs = sector?.segments ?? [];
  const cls = sector?.overallBest ? "ob" : sector?.personalBest ? "pb" : "muted";
  return (
    <td className="sec">
      <div className="seg-strip">
        {segs.map((s, i) => (
          <span key={i} className="seg" style={{ background: segColor(s.status) }} />
        ))}
      </div>
      <span className={`sec-t tnum ${cls}`}>{sector?.value ?? ""}</span>
    </td>
  );
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
              <th>S1</th>
              <th>S2</th>
              <th>S3</th>
              <th>Last</th>
              <th className="c">Tyre</th>
              <th className="r">Lap</th>
            </tr>
          </thead>
          <tbody>
            {order.map((num) => {
              const d = state.drivers?.[num] ?? {};
              const t = state.timing?.[num] ?? {};
              const stints = state.stints?.[num] ?? [];
              const tyre = stints[stints.length - 1]?.compound ?? undefined;
              const retired = t.retired || t.stopped;
              const sectors = t.sectors ?? [];
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
                  <SectorCell sector={sectors[0]} />
                  <SectorCell sector={sectors[1]} />
                  <SectorCell sector={sectors[2]} />
                  <td className={`tnum ${lapClass(t.lastLapTime)}`}>{t.lastLapTime?.value ?? ""}</td>
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
