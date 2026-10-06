import { useMemo, useRef } from "react";
import { useStore, teamColour } from "../store";

const VB = 1000;
const PAD = 70;
const GRID = 60; // dedup resolution for the accumulated outline

type XY = { x: number; y: number };

export default function TrackMap() {
  const positions = useStore((s) => s.state.position);
  const drivers = useStore((s) => s.state.drivers);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  // Accumulate a point cloud of every position we've seen; as cars lap, it
  // traces the circuit. Deduped on a coarse grid and capped.
  const cloud = useRef<Map<string, XY>>(new Map());

  const live = useMemo(() => {
    const pos = positions ?? {};
    const pts = Object.entries(pos)
      .filter(([, p]) => p.x != null && p.y != null && (p.x !== 0 || p.y !== 0))
      .map(([num, p]) => ({ num, x: p.x as number, y: p.y as number }));
    for (const p of pts) {
      const key = `${Math.round(p.x / GRID)},${Math.round(p.y / GRID)}`;
      if (!cloud.current.has(key) && cloud.current.size < 6000) {
        cloud.current.set(key, { x: p.x, y: p.y });
      }
    }
    return pts;
  }, [positions]);

  const outline = [...cloud.current.values()];

  const bounds = useMemo(() => {
    const src = outline.length > 20 ? outline : live;
    if (src.length === 0) return null;
    const xs = src.map((p) => p.x);
    const ys = src.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outline.length, live]);

  const project = (x: number, y: number) => {
    if (!bounds) return { cx: VB / 2, cy: VB / 2 };
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const scale = (VB - 2 * PAD) / span;
    const ox = (VB - (bounds.maxX - bounds.minX) * scale) / 2;
    const oy = (VB - (bounds.maxY - bounds.minY) * scale) / 2;
    return {
      cx: ox + (x - bounds.minX) * scale,
      cy: VB - oy - (y - bounds.minY) * scale, // flip Y
    };
  };

  return (
    <div className="panel">
      <div className="panel-scroll" style={{ display: "grid", placeItems: "center" }}>
        {live.length === 0 && outline.length === 0 ? (
          <div className="empty">Waiting for position data…</div>
        ) : (
          <svg viewBox={`0 0 ${VB} ${VB}`} className="trackmap">
            {outline.map((p, i) => {
              const { cx, cy } = project(p.x, p.y);
              return <circle key={i} cx={cx} cy={cy} r={3} className="tm-track" />;
            })}
            {live.map((p) => {
              const { cx, cy } = project(p.x, p.y);
              const d = drivers?.[p.num] ?? {};
              const isFocus = focus === p.num;
              const r = isFocus ? 13 : 9;
              return (
                <g key={p.num} onClick={() => setFocus(p.num)} style={{ cursor: "pointer" }}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={teamColour(d.teamColour)}
                    stroke={isFocus ? "var(--fg)" : "rgba(0,0,0,0.55)"}
                    strokeWidth={isFocus ? 3 : 1.5}
                  />
                  <text x={cx} y={cy + (isFocus ? -18 : 4)} className="tm-label" textAnchor="middle">
                    {isFocus ? (d.tla ?? p.num) : ""}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
