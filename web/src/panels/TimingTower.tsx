import { useStore, orderByPosition, teamColour, lapMs } from "../store";
import type { LapTime, Sector } from "../types.gen";

function lapClass(l?: LapTime | null): string {
  if (!l) return "";
  if (l.overallBest) return "ob";
  if (l.personalBest) return "pb";
  return "";
}

function fmtDelta(ms: number): string {
  return `+${(ms / 1000).toFixed(3)}`;
}

function fmtSigned(ms: number): string {
  return `${ms >= 0 ? "+" : ""}${(ms / 1000).toFixed(3)}`;
}

const SECTOR_TAG = ["S1", "S2", "Lap"];

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
  const sectorDeltas = useStore((s) => s.sectorDeltas);
  const order = orderByPosition(state);

  // Best-lap times drive a quali-style "gap to pole" when the feed doesn't send
  // race gaps (it doesn't in qualifying).
  const bestMs: Record<string, number | null> = {};
  let pole: number | null = null;
  for (const num of order) {
    const ms = lapMs(state.timing?.[num]?.bestLapTime?.value);
    bestMs[num] = ms;
    if (ms != null && (pole == null || ms < pole)) pole = ms;
  }

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
              <th>Δ</th>
              <th className="c">Tyre</th>
              <th className="r">Lap</th>
            </tr>
          </thead>
          <tbody>
            {order.map((num, i) => {
              const d = state.drivers?.[num] ?? {};
              const t = state.timing?.[num] ?? {};
              const stints = state.stints?.[num] ?? [];
              const tyre = stints[stints.length - 1]?.compound ?? undefined;
              const retired = t.retired || t.stopped;
              const sectors = t.sectors ?? [];

              // Gap / interval: prefer the feed's values; fall back to best-lap deltas.
              const my = bestMs[num];
              const prev = i > 0 ? bestMs[order[i - 1]] : null;
              const gap =
                t.gapToLeader ||
                (my != null && pole != null ? (my === pole ? "" : fmtDelta(my - pole)) : "");
              const intv =
                t.intervalToAhead ||
                (my != null && prev != null ? fmtDelta(my - prev) : "");
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
                    {t.inPit ? "IN PIT" : gap}
                  </td>
                  <td className="tnum muted">{intv}</td>
                  <SectorCell sector={sectors[0]} />
                  <SectorCell sector={sectors[1]} />
                  <SectorCell sector={sectors[2]} />
                  <td className={`tnum ${lapClass(t.lastLapTime)}`}>{t.lastLapTime?.value ?? ""}</td>
                  <td className="sd">
                    {(() => {
                      const sd = sectorDeltas[num];
                      if (!sd) return null;
                      const cls = sd.deltaMs <= 0 ? "pb" : sd.deltaMs < 300 ? "yellow" : "lose";
                      return (
                        <span className="tnum">
                          <span className="sd-tag">{SECTOR_TAG[sd.sector]}</span>
                          <span className={cls}>{fmtSigned(sd.deltaMs)}</span>
                        </span>
                      );
                    })()}
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
