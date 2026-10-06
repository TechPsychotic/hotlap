import { useMemo } from "react";
import { useStore, teamColour } from "../store";

// The feed's position coordinates span roughly ±10000; we fit them to the
// viewBox with a little padding and flip Y (feed Y grows "up").
const VB = 1000;
const PAD = 60;

export default function TrackMap() {
  const positions = useStore((s) => s.state.position);
  const drivers = useStore((s) => s.state.drivers);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);

  const { points, bounds } = useMemo(() => {
    const pos = positions ?? {};
    const pts = Object.entries(pos)
      .filter(([, p]) => p.x != null && p.y != null && (p.x !== 0 || p.y !== 0))
      .map(([num, p]) => ({ num, x: p.x as number, y: p.y as number, status: p.status }));
    if (pts.length === 0) return { points: [], bounds: null };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      points: pts,
      bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
    };
  }, [positions]);

  const project = (x: number, y: number) => {
    if (!bounds) return { cx: VB / 2, cy: VB / 2 };
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const scale = (VB - 2 * PAD) / span;
    const cx = PAD + (x - bounds.minX) * scale;
    const cy = VB - PAD - (y - bounds.minY) * scale; // flip Y
    return { cx, cy };
  };

  return (
    <div className="panel">
      <div className="panel-scroll" style={{ display: "grid", placeItems: "center" }}>
        {points.length === 0 ? (
          <div className="empty">Waiting for position data…</div>
        ) : (
          <svg viewBox={`0 0 ${VB} ${VB}`} className="trackmap">
            {points.map((p) => {
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
                    stroke={isFocus ? "var(--fg)" : "rgba(0,0,0,0.5)"}
                    strokeWidth={isFocus ? 3 : 1.5}
                  />
                  {isFocus && (
                    <text x={cx + r + 4} y={cy + 4} className="tm-label">
                      {d.tla ?? p.num}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
