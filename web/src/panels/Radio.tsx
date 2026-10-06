// Team radio: lists captured radio clips with the driver and timestamp, each
// playable inline. Audio lives on F1's static host under the session's archive
// path (public for recorded sessions); <audio> plays it cross-origin directly.

import { useStore, teamColour } from "../store";

const STATIC_BASE = "https://livetiming.formula1.com/static/";

export default function Radio() {
  const clips = useStore((s) => s.state.teamRadio) ?? [];
  const drivers = useStore((s) => s.state.drivers);
  const path = useStore((s) => s.state.session?.path);
  const items = [...clips].reverse(); // newest first

  return (
    <div className="panel radio">
      <div className="panel-scroll">
        {items.length === 0 && <div className="empty">No team radio captured yet.</div>}
        {items.map((c, i) => {
          const d = c.racingNumber ? drivers?.[c.racingNumber] : undefined;
          const url = path && c.path ? STATIC_BASE + path + c.path : null;
          return (
            <div key={items.length - i} className="radio-row">
              <span className="bar" style={{ background: teamColour(d?.teamColour) }} />
              <div className="radio-meta">
                <span className="radio-tla">{d?.tla ?? c.racingNumber ?? "—"}</span>
                <span className="radio-time dim">{c.utc ? c.utc.slice(11, 19) : ""}</span>
              </div>
              {url ? (
                <audio className="radio-audio" controls preload="none" src={url} />
              ) : (
                <span className="dim">no audio</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
