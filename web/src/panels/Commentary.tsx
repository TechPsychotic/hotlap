// Commentary: F1's live-blog commentary (fetched server-side from the session's
// Monterosa feed via ContentStreams). Newest first. Available for 2024+ sessions
// (2023 and earlier used the now-defunct ScribbleLive).

import { useStore } from "../store";

export default function Commentary() {
  const msgs = useStore((s) => s.state.commentary) ?? [];
  const streams = useStore((s) => s.state.audioStreams) ?? [];
  const items = [...msgs].reverse();
  const audio = streams.find((s) => s.uri);
  return (
    <div className="panel comm">
      {audio?.uri && (
        <div className="comm-audio">
          <span className="dim">Live audio · {audio.name ?? audio.language ?? "stream"}</span>
          {/* Native HLS plays in Safari; other browsers may not support the m3u8. */}
          <audio className="comm-audio-el" controls preload="none" src={audio.uri} />
        </div>
      )}
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
