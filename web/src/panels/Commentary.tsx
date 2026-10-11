// Commentary: F1's live-blog commentary (fetched server-side from the session's
// Monterosa feed via ContentStreams). Newest first. Available for 2024+ sessions
// (2023 and earlier used the now-defunct ScribbleLive).

import { useStore } from "../store";

export default function Commentary() {
  const msgs = useStore((s) => s.state.commentary) ?? [];
  const items = [...msgs].reverse();
  return (
    <div className="panel comm">
      <div className="panel-scroll">
        {items.length === 0 && (
          <div className="empty">No commentary for this session (available 2024+).</div>
        )}
        {items.map((m, i) => (
          <div key={items.length - i} className="comm-row">
            <span className="comm-time dim tnum">{m.utc ? m.utc.slice(11, 16) : ""}</span>
            <div className="comm-body">
              {m.title && <div className="comm-title">{m.title}</div>}
              {m.message && <div className="comm-msg">{m.message}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
