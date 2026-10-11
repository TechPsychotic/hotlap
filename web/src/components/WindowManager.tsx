import { useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { MIN_H, MIN_W, PANELS, TASKBAR_H, useWindows, type WinRect, type WinState } from "../windows";
import { COMPONENTS } from "../panels";

const SNAP = 14;

type Size = { w: number; h: number };

/** Snap the window's position so an edge lines up with the container or a peer. */
function snapMove(r: WinRect, peers: WinRect[], cont: Size): { x: number; y: number } {
  const xs = [0, cont.w, ...peers.flatMap((p) => [p.x, p.x + p.w])];
  const ys = [0, cont.h, ...peers.flatMap((p) => [p.y, p.y + p.h])];
  let x = r.x;
  let y = r.y;
  for (const c of xs) {
    if (Math.abs(r.x - c) <= SNAP) { x = c; break; }
    if (Math.abs(r.x + r.w - c) <= SNAP) { x = c - r.w; break; }
  }
  for (const c of ys) {
    if (Math.abs(r.y - c) <= SNAP) { y = c; break; }
    if (Math.abs(r.y + r.h - c) <= SNAP) { y = c - r.h; break; }
  }
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/** Snap the far edges while resizing so size lines up with container/peers. */
function snapResize(r: WinRect, peers: WinRect[], cont: Size): WinRect {
  const xs = [cont.w, ...peers.flatMap((p) => [p.x, p.x + p.w])];
  const ys = [cont.h, ...peers.flatMap((p) => [p.y, p.y + p.h])];
  let w = r.w;
  let h = r.h;
  for (const c of xs) {
    if (Math.abs(r.x + r.w - c) <= SNAP) { w = Math.max(MIN_W, c - r.x); break; }
  }
  for (const c of ys) {
    if (Math.abs(r.y + r.h - c) <= SNAP) { h = Math.max(MIN_H, c - r.y); break; }
  }
  return { ...r, w, h };
}

export default function WindowManager() {
  const wins = useWindows((s) => s.wins);
  const focus = useWindows((s) => s.focus);
  const setRect = useWindows((s) => s.setRect);
  const close = useWindows((s) => s.close);
  const toggleMin = useWindows((s) => s.toggleMin);
  const toggleMax = useWindows((s) => s.toggleMax);
  const snap = useWindows((s) => s.snap);

  const wmRef = useRef<HTMLDivElement | null>(null);
  const [cont, setCont] = useState<Size>({ w: 1600, h: 800 });
  useEffect(() => {
    if (!wmRef.current) return;
    const el = wmRef.current;
    const update = () => setCont({ w: el.clientWidth, h: Math.max(200, el.clientHeight - TASKBAR_H) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const peersOf = (id: string): WinRect[] =>
    PANELS.filter((p) => p.id !== id)
      .map((p) => wins[p.id])
      .filter((w): w is WinState => !!w && w.open && !w.min);

  return (
    <div className="wm" ref={wmRef}>
      {PANELS.map((p) => {
        const w = wins[p.id];
        if (!w.open || w.min) return null;
        const Comp = COMPONENTS[p.component];
        const maxed = w.max;
        const size = maxed ? { width: cont.w, height: cont.h } : { width: w.w, height: w.h };
        const position = maxed ? { x: 0, y: 0 } : { x: w.x, y: w.y };
        return (
          <Rnd
            key={p.id}
            size={size}
            position={position}
            minWidth={MIN_W}
            minHeight={MIN_H}
            bounds="parent"
            dragHandleClassName="win-title"
            disableDragging={maxed}
            enableResizing={!maxed}
            style={{ zIndex: w.z }}
            onDragStart={() => focus(p.id)}
            onResizeStart={() => focus(p.id)}
            onDragStop={(_e, d) => {
              const raw = { x: d.x, y: d.y, w: w.w, h: w.h };
              setRect(p.id, snap ? snapMove(raw, peersOf(p.id), cont) : { x: Math.max(0, d.x), y: Math.max(0, d.y) });
            }}
            onResizeStop={(_e, _dir, ref, _delta, pos) => {
              const raw = { x: pos.x, y: pos.y, w: ref.offsetWidth, h: ref.offsetHeight };
              setRect(p.id, snap ? snapResize(raw, peersOf(p.id), cont) : raw);
            }}
          >
            <div className="win" onMouseDown={() => focus(p.id)}>
              <div className="win-title" onDoubleClick={() => toggleMax(p.id)}>
                <span className="win-t">{p.title}</span>
                <span className="win-ctrls">
                  <button className="wc" title="Minimize" onClick={() => toggleMin(p.id)}>–</button>
                  <button className="wc" title={maxed ? "Restore" : "Maximize"} onClick={() => toggleMax(p.id)}>
                    {maxed ? "❐" : "▢"}
                  </button>
                  <button className="wc close" title="Close" onClick={() => close(p.id)}>×</button>
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
