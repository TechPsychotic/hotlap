import { useStore } from "../store";

function flagColor(flag?: string | null, category?: string | null): string {
  const f = (flag ?? "").toUpperCase();
  if (f.includes("RED")) return "var(--accent)";
  if (f.includes("YELLOW") || f.includes("DOUBLE YELLOW")) return "var(--yellow)";
  if (f.includes("GREEN") || f.includes("CLEAR")) return "var(--green)";
  if (f.includes("BLUE")) return "var(--blue)";
  if ((category ?? "").toUpperCase().includes("SAFETYCAR")) return "var(--yellow)";
  return "var(--dim)";
}

export default function RaceControl() {
  const messages = useStore((s) => s.state.raceControl) ?? [];
  const items = [...messages].reverse(); // newest first

  return (
    <div className="panel rc">
      <div className="panel-scroll">
        {items.length === 0 && <div className="empty">No race control messages yet.</div>}
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
  );
}
