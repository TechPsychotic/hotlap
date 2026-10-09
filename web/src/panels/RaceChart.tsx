// Position-change chart (from the LapSeries topic): each driver's track position
// at every lap, plus a broadcast top-three strip (TopThree topic).

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import { useStore, teamColour } from "../store";

function cssVar(name: string, fb: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  } catch {
    return fb;
  }
}

export default function RaceChart() {
  const lapSeries = useStore((s) => s.state.lapSeries);
  const drivers = useStore((s) => s.state.drivers);
  const topThree = useStore((s) => s.state.topThree);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  const ls = lapSeries ?? {};
  const nums = useMemo(
    () => Object.keys(ls).filter((n) => (ls[n]?.lapPosition?.length ?? 0) > 0),
    [ls],
  );
  const maxLap = useMemo(() => nums.reduce((m, n) => Math.max(m, ls[n].lapPosition.length), 0), [nums, ls]);
  const maxPos = useMemo(() => {
    let m = Object.keys(drivers ?? {}).length || 20;
    for (const n of nums) for (const p of ls[n].lapPosition) m = Math.max(m, Number(p) || 0);
    return m;
  }, [nums, ls, drivers]);

  const plotRef = useRef<HTMLDivElement | null>(null);
  const uplotRef = useRef<uPlot | null>(null);
  const key = nums.join(",") + "|" + maxLap + "|" + maxPos + "|" + (focus ?? "");

  // (Re)build when the driver set / lap count / focus changes.
  useEffect(() => {
    if (!plotRef.current || maxLap < 1) return;
    const stroke = cssVar("--fg-dim", "#9aa4b2");
    const axis = { stroke, grid: { stroke: "rgba(255,255,255,0.06)" }, ticks: { show: false }, font: "10px ui-monospace, monospace" };
    const series: uPlot.Series[] = [{}];
    for (const n of nums) {
      const col = teamColour(drivers?.[n]?.teamColour);
      const dim = focus != null && focus !== n;
      series.push({
        stroke: dim ? `${col}44` : col,
        width: focus === n ? 3.5 : 1.5,
        points: { show: false },
      });
    }
    const splits: number[] = [1, 5, 10, 15, 20].filter((v) => v <= maxPos);
    const u = new uPlot(
      {
        width: plotRef.current.clientWidth || 400,
        height: Math.max(80, plotRef.current.clientHeight || 200),
        padding: [8, 10, 0, 2],
        cursor: { show: true, points: { show: false } },
        legend: { show: false },
        scales: { x: { time: false }, y: { dir: -1, range: [0.5, maxPos + 0.5] } },
        axes: [
          { ...axis },
          { ...axis, size: 26, splits: () => splits, values: (_u, s) => s.map((v) => `P${v}`) },
        ],
        series,
      },
      [Array.from({ length: maxLap }, (_, i) => i + 1), ...nums.map(() => new Array(maxLap).fill(null))] as uPlot.AlignedData,
      plotRef.current,
    );
    uplotRef.current = u;
    const ro = new ResizeObserver(() => {
      if (plotRef.current) u.setSize({ width: plotRef.current.clientWidth, height: Math.max(80, plotRef.current.clientHeight) });
    });
    ro.observe(plotRef.current);
    return () => {
      ro.disconnect();
      u.destroy();
      uplotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Feed data on every update.
  useEffect(() => {
    const u = uplotRef.current;
    if (!u || maxLap < 1) return;
    const cols = nums.map((n) => {
      const lp = ls[n].lapPosition;
      const arr: (number | null)[] = new Array(maxLap).fill(null);
      for (let i = 0; i < Math.min(lp.length, maxLap); i++) {
        const v = Number(lp[i]);
        if (v > 0) arr[i] = v;
      }
      return arr;
    });
    u.setData([Array.from({ length: maxLap }, (_, i) => i + 1), ...cols] as uPlot.AlignedData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lapSeries, key]);

  const tt = (topThree ?? []).filter((l) => l.tla);

  return (
    <div className="panel rc3">
      {tt.length > 0 && (
        <div className="rc3-top">
          {tt.map((l, i) => (
            <div
              key={i}
              className={`rc3-pod ${focus === l.racingNumber ? "focus" : ""}`}
              onClick={() => l.racingNumber && setFocus(l.racingNumber)}
            >
              <span className="rc3-pos">P{l.position}</span>
              <span className="rc3-bar" style={{ background: l.teamColour ? `#${l.teamColour}` : "var(--dim)" }} />
              <span className="rc3-tla">{l.tla}</span>
              <span className={`rc3-lap tnum ${l.overallFastest ? "ob" : ""}`}>{l.lapTime || l.diffToLeader || ""}</span>
            </div>
          ))}
        </div>
      )}
      {maxLap < 1 ? (
        <div className="empty">No lap-by-lap positions yet (fills in once laps are completed).</div>
      ) : (
        <>
          <div className="rc3-h dim">Position by lap</div>
          <div ref={plotRef} className="rc3-plot" />
        </>
      )}
    </div>
  );
}
