import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

function fmt(ms?: number | null): string {
  if (ms == null) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export default function TransportBar() {
  const replay = useStore((s) => s.replay);
  const sendControl = useStore((s) => s.sendControl);
  const [scrub, setScrub] = useState<number | null>(null);
  const dragging = useRef(false);

  // Keep the slider in sync with incoming status unless the user is scrubbing.
  useEffect(() => {
    if (!dragging.current) setScrub(null);
  }, [replay?.positionMs]);

  if (!replay) return null;

  const dur = replay.durationMs ?? 0;
  const pos = scrub ?? replay.positionMs;
  const ratio = dur > 0 ? pos / dur : 0;
  // Always include the live speed so the selector reflects reality even if the
  // speed was set outside the preset list.
  const speeds = Array.from(new Set([...SPEEDS, replay.speed])).sort((a, b) => a - b);

  return (
    <div className="transport">
      <button
        className="ghost play"
        onClick={() => sendControl({ action: replay.playing ? "pause" : "play" })}
        title={replay.playing ? "Pause" : "Play"}
      >
        {replay.playing ? "❚❚" : "▶"}
      </button>

      <span className="tnum pos">{fmt(pos)}</span>
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(ratio * 1000)}
        className="seek"
        onMouseDown={() => (dragging.current = true)}
        onInput={(e) => setScrub((Number(e.currentTarget.value) / 1000) * dur)}
        onChange={(e) => {
          dragging.current = false;
          const offsetMs = Math.round((Number(e.currentTarget.value) / 1000) * dur);
          sendControl({ action: "seek", offsetMs });
          setScrub(null);
        }}
      />
      <span className="tnum dur dim">{fmt(dur)}</span>

      <select
        value={replay.speed}
        onChange={(e) => sendControl({ action: "setSpeed", speed: Number(e.target.value) })}
        title="Playback speed"
      >
        {speeds.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>

      <span className="badge src">{replay.source}</span>
    </div>
  );
}
