import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useWindows } from "../windows";
import TransportBar from "./TransportBar";
import SessionPicker from "./SessionPicker";

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

const pad = (n: number) => String(n).padStart(2, "0");

/** Local wall-clock time at the circuit, from the session's GMT offset. */
function trackLocalTime(gmtOffset: string | null | undefined, nowMs: number): string | null {
  const m = (gmtOffset ?? "").match(/([+-]?)(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const offMin = (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  const t = new Date(nowMs + offMin * 60000);
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

export default function TopBar({ onHome }: { onHome?: () => void }) {
  const conn = useStore((s) => s.conn);
  const live = useStore((s) => s.live);
  const session = useStore((s) => s.state.session);
  const track = useStore((s) => s.state.trackStatus);
  const clock = useStore((s) => s.state.clock);
  const lap = useStore((s) => s.state.lapCount);
  const resetLayout = useWindows((s) => s.reset);
  const snap = useWindows((s) => s.snap);
  const toggleSnap = useWindows((s) => s.toggleSnap);

  // A 1s tick drives the live track-local clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const trackTime = live ? trackLocalTime(session?.gmtOffset, now) : null;

  const title = [session?.meetingName, session?.sessionName].filter(Boolean).join("  ·  ");

  return (
    <header className="topbar">
      <button className="brand ghost" title="Home" onClick={onHome}>
        <span className="brand-mark">▟</span> HOTLAP
      </button>

      <div className="session muted">{title || "No session"}</div>

      {live ? <span className="badge live-tag"><span className="dot red" />LIVE</span> : <SessionPicker />}

      <span className="badge">
        <span className={`dot ${trackDot(track?.status)}`} />
        {track?.message ?? "—"}
      </span>
      {lap?.currentLap != null && (
        <span className="badge tnum">
          L {lap.currentLap}
          {lap.totalLaps ? ` / ${lap.totalLaps}` : ""}
        </span>
      )}

      <div className="spacer" />

      {live ? (
        <div className="live-clocks">
          {trackTime && (
            <span className="lc-main tnum" title="Local time at the circuit">
              {trackTime} <span className="lc-l">track time</span>
            </span>
          )}
          {clock?.remaining && (
            <span className="lc-sub tnum" title="Session time remaining">
              {clock.remaining} <span className="lc-l">left</span>
            </span>
          )}
        </div>
      ) : (
        <TransportBar />
      )}

      <div className="spacer" />

      <div className="panel-menu">
        <button
          className={`ghost ${snap ? "on" : ""}`}
          title={snap ? "Snapping on — click to free-place windows" : "Snapping off — click to snap windows"}
          onClick={toggleSnap}
        >
          🧲 {snap ? "Snap" : "Free"}
        </button>
        <button className="ghost" title="Reset window layout" onClick={resetLayout}>
          ⟳ Layout
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
