// Track Details: the circuit map (from position data when available — present
// for recorded/historical sessions, gated on the live free feed), the current
// track status/flag, and the full race-control message log, in one window.

import { useMemo } from "react";
import { useStore, teamColour } from "../store";

const VB = 1000;
const PAD = 60;

function trackDot(status?: string | null): string {
  switch (status) {
    case "1":
      return "green";
    case "2":
    case "4":
    case "6":
    case "7":
      return "yellow";
    case "5":
      return "red";
    default:
      return "";
  }
}

function flagColor(flag?: string | null, category?: string | null): string {
  const f = (flag ?? "").toUpperCase();
  if (f.includes("RED")) return "var(--accent)";
  if (f.includes("YELLOW")) return "var(--yellow)";
  if (f.includes("GREEN") || f.includes("CLEAR")) return "var(--green)";
  if (f.includes("BLUE")) return "var(--blue)";
  if ((category ?? "").toUpperCase().includes("SAFETYCAR")) return "var(--yellow)";
  return "var(--dim)";
}

function TrackMapView() {
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
    return { cx: ox + (x - bounds.minX) * scale, cy: VB - oy - (y - bounds.minY) * scale };
  };

  if (live.length === 0 && trail.length === 0) {
    return <div className="empty">No position data (live positions require F1 TV; available on recorded sessions).</div>;
  }

  return (
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
  );
}

export default function TrackDetails() {
  const track = useStore((s) => s.state.trackStatus);
  const messages = useStore((s) => s.state.raceControl) ?? [];
  const items = [...messages].reverse();

  return (
    <div className="panel td">
      <div className="td-status">
        <span className={`dot ${trackDot(track?.status)}`} />
        <b>{track?.message ?? "—"}</b>
      </div>
      <div className="td-map">
        <TrackMapView />
      </div>
      <div className="td-rc">
        <div className="td-rc-head dim">Race Control</div>
        <div className="td-rc-list">
          {items.length === 0 && <div className="empty">No messages yet.</div>}
          {items.map((m, i) => (
            <div key={items.length - i} className="rc-row">
              <span className="rc-flag" style={{ background: flagColor(m.flag, m.category) }} />
              <div className="rc-body">
                <div className="rc-msg">{m.message}</div>
                <div className="rc-meta dim">
                  {m.lap != null && <span>L{m.lap}</span>}
                  {m.category && <span>{m.category}</span>}
                  {m.utc && <span>{m.utc.slice(11, 19)}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
