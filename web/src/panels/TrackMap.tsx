import { useMemo } from "react";
import { useStore, teamColour } from "../store";

const VB = 1000;
const PAD = 70;

export default function TrackMap() {
  const positions = useStore((s) => s.state.position);
  const drivers = useStore((s) => s.state.drivers);
  const trail = useStore((s) => s.trail);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  const live = useMemo(() => {
    const pos = positions ?? {};
    return Object.entries(pos)
      .filter(([, p]) => p.x != null && p.y != null && (p.x !== 0 || p.y !== 0))
      .map(([num, p]) => ({ num, x: p.x as number, y: p.y as number }));
  }, [positions]);

  const bounds = useMemo(() => {
    const src = trail.length > 20 ? trail : live;
    if (src.length === 0) return null;
    const xs = src.map((p) => p.x);
    const ys = src.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [trail, live]);

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
        {live.length === 0 && trail.length === 0 ? (
          <div className="empty">Waiting for position data…</div>
        ) : (
          <svg viewBox={`0 0 ${VB} ${VB}`} className="trackmap">
            {trail.map((p, i) => {
              const { cx, cy } = project(p.x, p.y);
              return <circle key={i} cx={cx} cy={cy} r={3.5} className="tm-track" />;
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
                  <text x={cx} y={cy - r - 5} className="tm-label" textAnchor="middle">
                    {d.tla ?? p.num}
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
