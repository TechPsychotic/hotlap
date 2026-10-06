import { Rnd } from "react-rnd";
import { MIN_H, MIN_W, PANELS, useWindows } from "../windows";
import { COMPONENTS } from "../panels";

export default function WindowManager() {
  const wins = useWindows((s) => s.wins);
  const focus = useWindows((s) => s.focus);
  const setRect = useWindows((s) => s.setRect);
  const close = useWindows((s) => s.close);
  const toggleMin = useWindows((s) => s.toggleMin);

  return (
    <div className="wm">
      {PANELS.map((p) => {
        const w = wins[p.id];
        if (!w.open || w.min) return null;
        const Comp = COMPONENTS[p.component];
        return (
          <Rnd
            key={p.id}
            size={{ width: w.w, height: w.h }}
            position={{ x: w.x, y: w.y }}
            minWidth={MIN_W}
            minHeight={MIN_H}
            bounds="parent"
            dragHandleClassName="win-title"
            style={{ zIndex: w.z }}
            onDragStart={() => focus(p.id)}
            onResizeStart={() => focus(p.id)}
            onDragStop={(_e, d) => setRect(p.id, { x: d.x, y: d.y })}
            onResizeStop={(_e, _dir, ref, _delta, pos) =>
              setRect(p.id, { w: ref.offsetWidth, h: ref.offsetHeight, x: pos.x, y: pos.y })
            }
          >
            <div className="win" onMouseDown={() => focus(p.id)}>
              <div className="win-title">
                <span className="win-t">{p.title}</span>
                <span className="win-ctrls">
                  <button className="wc" title="Minimize" onClick={() => toggleMin(p.id)}>
                    –
                  </button>
                  <button className="wc close" title="Close" onClick={() => close(p.id)}>
                    ×
                  </button>
                </span>
              </div>
              <div className="win-body">
                <Comp />
              </div>
            </div>
          </Rnd>
        );
      })}
      <Taskbar />
    </div>
  );
}

function Taskbar() {
  const wins = useWindows((s) => s.wins);
  const open = useWindows((s) => s.open);
  const toggleMin = useWindows((s) => s.toggleMin);
  const focus = useWindows((s) => s.focus);

  return (
    <div className="taskbar">
      {PANELS.map((p) => {
        const w = wins[p.id];
        const active = w.open && !w.min;
        return (
          <button
            key={p.id}
            className={`task ${active ? "active" : ""} ${w.open && w.min ? "min" : ""}`}
            onClick={() => {
              if (!w.open || w.min) open(p.id);
              else {
                // Clicking the active window's task minimizes it; otherwise raise.
                toggleMin(p.id);
                focus(p.id);
              }
            }}
          >
            {p.title}
          </button>
        );
      })}
    </div>
  );
}
