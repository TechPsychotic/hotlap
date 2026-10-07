// F1-themed home page: parallax hero, the next-race countdown in the viewer's
// local time zone, and the full season calendar. Calendar data is proxied by
// the core from Jolpica (Ergast).

import { useEffect, useMemo, useRef, useState } from "react";

interface Race {
  round: string;
  raceName: string;
  short: string;
  circuitName: string;
  locality: string;
  country: string;
  dt: Date;
}

function parseRaces(d: unknown): Race[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const races = (d as any)?.MRData?.RaceTable?.Races ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return races.map((r: any) => {
    const time = r.time || "00:00:00Z";
    return {
      round: String(r.round),
      raceName: r.raceName,
      short: String(r.raceName).replace(/ Grand Prix$/, ""),
      circuitName: r.Circuit?.circuitName ?? "",
      locality: r.Circuit?.Location?.locality ?? "",
      country: r.Circuit?.Location?.country ?? "",
      dt: new Date(`${r.date}T${time}`),
    } as Race;
  });
}

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function Landing({ onEnter }: { onEnter: () => void }) {
  const year = new Date().getFullYear();
  const [races, setRaces] = useState<Race[] | null>(null);
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ok = true;
    fetch(`/api/calendar/${year}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch"))))
      .then((d) => {
        if (ok) setRaces(parseRaces(d));
      })
      .catch(() => ok && setErr(true));
    return () => {
      ok = false;
    };
  }, [year]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const next = useMemo(() => races?.find((r) => r.dt.getTime() > now) ?? null, [races, now]);

  // Smooth mouse parallax: track a damped pointer offset as CSS vars.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let raf = 0;
    const target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      target.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      target.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    };
    const loop = () => {
      cur.x += (target.x - cur.x) * 0.07;
      cur.y += (target.y - cur.y) * 0.07;
      el.style.setProperty("--px", cur.x.toFixed(3));
      el.style.setProperty("--py", cur.y.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    el.addEventListener("mousemove", onMove);
    loop();
    return () => {
      el.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  const c = next ? parts(next.dt.getTime() - now) : null;

  return (
    <div className="landing" ref={rootRef}>
      <div className="lx-layer lx-glow pllr-0" />
      <div className="lx-layer lx-grid pllr-1" />
      <div className="lx-layer lx-streak pllr-2" />

      <header className="lx-top">
        <div className="lx-brand">
          <span className="lx-mark" />
          PITWALL
        </div>
        <button className="lx-enter" onClick={onEnter}>
          Enter Telemetry →
        </button>
      </header>

      <section className="lx-hero pllr-3">
        <div className="lx-kicker">FORMULA 1 · {year} SEASON</div>
        <h1 className="lx-title">THE PIT WALL</h1>
        <p className="lx-sub">Live, recorded &amp; historical telemetry — every stream, one place.</p>
      </section>

      <section className="lx-next glass">
        {next && c ? (
          <>
            <div className="lx-next-top">
              <span className="lx-next-tag">NEXT RACE</span>
              <span className="lx-next-round">ROUND {next.round}</span>
            </div>
            <div className="lx-next-name">{next.raceName}</div>
            <div className="lx-next-loc">
              {next.circuitName} · {next.locality}, {next.country}
            </div>
            <div className="lx-count">
              {[
                ["DAYS", c.d],
                ["HRS", c.h],
                ["MIN", c.m],
                ["SEC", c.s],
              ].map(([l, v]) => (
                <div className="lx-count-cell" key={l as string}>
                  <div className="lx-count-v tnum">{l === "DAYS" ? v : pad(v as number)}</div>
                  <div className="lx-count-l">{l}</div>
                </div>
              ))}
            </div>
            <div className="lx-local">
              {next.dt.toLocaleString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              · your local time
            </div>
          </>
        ) : races ? (
          <div className="lx-msg">Season complete — see the calendar below.</div>
        ) : err ? (
          <div className="lx-msg">Calendar unavailable right now.</div>
        ) : (
          <div className="lx-msg">Loading calendar…</div>
        )}
      </section>

      <section className="lx-cal">
        <div className="lx-cal-h">
          {year} Calendar <span className="dim">· times in your local zone</span>
        </div>
        <div className="lx-cal-grid">
          {races?.map((r) => {
            const past = r.dt.getTime() < now;
            const isNext = next?.round === r.round;
            return (
              <div className={`lx-card glass ${past ? "past" : ""} ${isNext ? "next" : ""}`} key={r.round}>
                <div className="lx-card-top">
                  <span className="lx-card-r">R{r.round}</span>
                  {isNext && <span className="lx-card-badge">NEXT</span>}
                  {past && !isNext && <span className="lx-card-done">✓</span>}
                </div>
                <div className="lx-card-n">{r.short}</div>
                <div className="lx-card-c">
                  {r.locality}, {r.country}
                </div>
                <div className="lx-card-d tnum">
                  {r.dt.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                  {r.dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
