// Commentary: the broadcast TV-ticker feed (F1's TlaRcm), newest first. Works
// for every session (live + historical); the old ScribbleLive text commentary
// that ContentStreams points to is defunct.

import { useStore } from "../store";

export default function Commentary() {
  const msgs = useStore((s) => s.state.commentary) ?? [];
  const items = [...msgs].reverse();
  return (
    <div className="panel comm">
      <div className="panel-scroll">
        {items.length === 0 && <div className="empty">No commentary yet.</div>}
        {items.map((m, i) => (
          <div key={items.length - i} className="comm-row">
            <span className="comm-time dim tnum">{m.utc ? m.utc.slice(11, 19) : ""}</span>
            <span className="comm-msg">{m.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
