import { useStore } from "../store";
import { ALL_PANELS, openPanel, resetLayout } from "../layout";
import TransportBar from "./TransportBar";

function trackDot(status?: string | null): string {
  switch (status) {
    case "1":
      return "green"; // all clear
    case "2":
    case "4":
    case "6":
    case "7":
      return "yellow"; // yellow / SC / VSC
    case "5":
      return "red"; // red flag
    default:
      return "";
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = next;
  try {
    localStorage.setItem("pw.theme", next);
  } catch {
    /* ignore */
  }
}

export default function TopBar() {
  const conn = useStore((s) => s.conn);
  const session = useStore((s) => s.state.session);
  const track = useStore((s) => s.state.trackStatus);
  const clock = useStore((s) => s.state.clock);
  const lap = useStore((s) => s.state.lapCount);

  const title = [session?.meetingName, session?.sessionName].filter(Boolean).join("  ·  ");

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">▟</span> PITWALL
      </div>

      <div className="session muted">{title || "No session"}</div>

      <span className="badge">
        <span className={`dot ${trackDot(track?.status)}`} />
        {track?.message ?? "—"}
      </span>
      {clock?.remaining && <span className="badge tnum">{clock.remaining}</span>}
      {lap?.currentLap != null && (
        <span className="badge tnum">
          L {lap.currentLap}
          {lap.totalLaps ? ` / ${lap.totalLaps}` : ""}
        </span>
      )}

      <div className="spacer" />

      <TransportBar />

      <div className="spacer" />

      <div className="panel-menu">
        {ALL_PANELS.map((p) => (
          <button key={p.id} className="ghost" title={`Open ${p.title}`} onClick={() => openPanel(p)}>
            {p.title}
          </button>
        ))}
        <button className="ghost" title="Reset layout" onClick={resetLayout}>
          ⟳
        </button>
        <button className="ghost" title="Toggle theme" onClick={toggleTheme}>
          ◐
        </button>
      </div>

      <span className={`badge conn ${conn}`}>
        <span className={`dot ${conn === "open" ? "green" : conn === "connecting" ? "yellow" : "red"}`} />
        {conn}
      </span>
    </header>
  );
}
