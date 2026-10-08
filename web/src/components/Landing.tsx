// F1-themed home page: a live, breathing red orb that roams the screen; the
// next-session countdown in the viewer's local time zone; the full season
// calendar (every weekend session); and two entry points — Live (greyed out
// when no live session is available) and Replay. Calendar data is proxied by
// the core from Jolpica (Ergast).

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";

interface Sess {
  label: string;
  dt: Date;
}
interface Race {
  round: string;
  raceName: string;
  short: string;
  circuitName: string;
  locality: string;
  country: string;
  sessions: Sess[];
}

// Jolpica keys → short labels, in weekend order (one sprint-quali key exists).
const SESSION_DEFS: [string, string][] = [
  ["FirstPractice", "FP1"],
  ["SecondPractice", "FP2"],
  ["ThirdPractice", "FP3"],
  ["SprintQualifying", "Sprint Quali"],
  ["SprintShootout", "Sprint Quali"],
  ["Sprint", "Sprint"],
  ["Qualifying", "Quali"],
];

function parseRaces(d: unknown): Race[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const races = (d as any)?.MRData?.RaceTable?.Races ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return races.map((r: any) => {
    const sessions: Sess[] = [];
    for (const [key, label] of SESSION_DEFS) {
      const s = r[key];
      if (s?.date) sessions.push({ label, dt: new Date(`${s.date}T${s.time || "00:00:00Z"}`) });
    }
    if (r.date) sessions.push({ label: "Race", dt: new Date(`${r.date}T${r.time || "00:00:00Z"}`) });
    sessions.sort((a, b) => a.dt.getTime() - b.dt.getTime());
    return {
      round: String(r.round),
      raceName: r.raceName,
      short: String(r.raceName).replace(/ Grand Prix$/, ""),
      circuitName: r.Circuit?.circuitName ?? "",
      locality: r.Circuit?.Location?.locality ?? "",
      country: r.Circuit?.Location?.country ?? "",
      sessions,
    } as Race;
  });
}

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}
const pad = (n: number) => String(n).padStart(2, "0");
const wkTime = (dt: Date) =>
  `${dt.toLocaleDateString(undefined, { weekday: "short" })} ${dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;

type IndexEvent = { name: string; sessions: { name: string; kind?: string }[] };

// Session label → the archive session name it should match.
const SESSION_MATCH: Record<string, RegExp> = {
  FP1: /practice 1/i,
  FP2: /practice 2/i,
  FP3: /practice 3/i,
  Quali: /^qualifying/i,
  "Sprint Quali": /sprint\s*(qualifying|shootout)/i,
  Sprint: /^sprint$/i,
  Race: /^race/i,
};

/** Map a Jolpica race + session label to the archive's exact event/session names. */
function archiveNames(
  idx: IndexEvent[] | null,
  raceName: string,
  label: string,
): { event: string; session: string } | null {
  if (!idx) return null;
  const lc = (s: string) => s.toLowerCase();
  const short = lc(raceName.replace(/ Grand Prix$/, ""));
  const ev = idx.find((e) => lc(e.name) === lc(raceName)) || idx.find((e) => lc(e.name).includes(short));
  const re = SESSION_MATCH[label];
  const sess = ev && re ? ev.sessions.find((s) => re.test(s.name)) : undefined;
  return ev && sess ? { event: ev.name, session: sess.name } : null;
}

export default function Landing({ onEnter }: { onEnter: () => void }) {
  const year = new Date().getFullYear();
  const liveAvailable = useStore((s) => s.replay?.source === "live");
  const [races, setRaces] = useState<Race[] | null>(null);
  const [err, setErr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [index, setIndex] = useState<IndexEvent[] | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const orbRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let ok = true;
    fetch(`/api/calendar/${year}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch"))))
      .then((d) => ok && setRaces(parseRaces(d)))
      .catch(() => ok && setErr(true));
    // The archive index maps a race's sessions to loadable event/session names.
    fetch(`/api/index/${year}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => ok && setIndex(Array.isArray(d) ? d : []))
      .catch(() => ok && setIndex([]));
    return () => {
      ok = false;
    };
  }, [year]);

  // Click a past session → load it from the archive, then enter the workspace.
  const loadSession = async (race: Race, sess: Sess) => {
    const names = archiveNames(index, race.raceName, sess.label);
    if (!names) {
      setLoadErr(`${race.short} · ${sess.label} isn't in the archive yet.`);
      return;
    }
    setLoadErr(null);
    setLoading(`${race.short} · ${sess.label}`);
    try {
      const res = await fetch("/api/session/load", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ year, event: names.event, session: names.session }),
      });
      if (!res.ok) throw new Error("load");
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await fetch("/api/session/status").then((r) => r.json());
        if (st.error) {
          setLoadErr(String(st.error));
          setLoading(null);
          return;
        }
        if (!st.loading && st.name) {
          onEnter();
          return;
        }
      }
      setLoadErr("Timed out loading that session.");
      setLoading(null);
    } catch {
      setLoadErr("Could not load that session.");
      setLoading(null);
    }
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Next upcoming session across the whole calendar.
  const next = useMemo(() => {
    if (!races) return null;
    let best: { race: Race; sess: Sess } | null = null;
    for (const race of races)
      for (const sess of race.sessions)
        if (sess.dt.getTime() > now && (!best || sess.dt < best.sess.dt)) best = { race, sess };
    return best;
  }, [races, now]);

  // Mouse parallax (the grid layer) + a roaming, breathing red orb.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

    // Roam the orb to a new random spot every few seconds; CSS eases the glide.
    let orbTimer = 0;
    const roam = () => {
      const orb = orbRef.current;
      if (orb) {
        const x = (Math.random() * 1.0 - 0.3) * window.innerWidth;
        const y = (Math.random() * 1.0 - 0.3) * window.innerHeight;
        orb.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
      }
      orbTimer = window.setTimeout(roam, 6500);
    };
    if (!reduce) roam();

    return () => {
      el.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
      clearTimeout(orbTimer);
    };
  }, []);

  const c = next ? parts(next.sess.dt.getTime() - now) : null;

  return (
    <div className="landing" ref={rootRef}>
      <div className="lx-orb" ref={orbRef}>
        <div className="lx-orb-core" />
      </div>
      <div className="lx-layer lx-grid pllr-1" />
      <div className="lx-layer lx-streak pllr-2" />

      <header className="lx-top">
        <div className="lx-brand">
          <span className="lx-mark" />
          HOTLAP
        </div>
        <div className="lx-actions">
          <button
            className="lx-enter lx-live"
            disabled={!liveAvailable}
            title={liveAvailable ? "Enter the live session" : "No live session available"}
            onClick={onEnter}
          >
            <span className={`lx-live-dot ${liveAvailable ? "on" : ""}`} />
            Live session
          </button>
          <button className="lx-enter lx-replay" onClick={onEnter}>
            Replay session →
          </button>
        </div>
      </header>

      <section className="lx-hero pllr-3">
        <div className="lx-kicker">FORMULA 1 · {year} SEASON</div>
        <h1 className="lx-title">HOTLAP</h1>
        <p className="lx-sub">Live &amp; historical F1 telemetry — every stream, one place.</p>
      </section>

      <section className="lx-next glass">
        {next && c ? (
          <>
            <div className="lx-next-top">
              <span className="lx-next-tag">NEXT SESSION</span>
              <span className="lx-next-round">
                {next.sess.label.toUpperCase()} · ROUND {next.race.round}
              </span>
            </div>
            <div className="lx-next-name">{next.race.raceName}</div>
            <div className="lx-next-loc">
              {next.race.circuitName} · {next.race.locality}, {next.race.country}
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
              {next.sess.dt.toLocaleString(undefined, {
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
          {year} Calendar <span className="dim">· all sessions, in your local zone</span>
        </div>
        <div className="lx-cal-grid">
          {races?.map((r) => {
            const lastDt = r.sessions[r.sessions.length - 1]?.dt.getTime() ?? 0;
            const racePast = lastDt < now;
            const hasNext = next?.race.round === r.round;
            return (
              <div className={`lx-card glass ${hasNext ? "next" : ""}`} key={r.round}>
                <div className="lx-card-top">
                  <span className="lx-card-r">R{r.round}</span>
                  {hasNext && <span className="lx-card-badge">NEXT</span>}
                  {racePast && !hasNext && <span className="lx-card-done">✓</span>}
                </div>
                <div className="lx-card-n">{r.short}</div>
                <div className="lx-card-c">
                  {r.locality}, {r.country}
                </div>
                <div className="lx-sessions">
                  {r.sessions.map((s, i) => {
                    const isNext = hasNext && next?.sess.dt.getTime() === s.dt.getTime();
                    const past = s.dt.getTime() < now;
                    return past ? (
                      <button
                        className={`lx-sess go ${isNext ? "now" : ""}`}
                        key={i}
                        disabled={!!loading}
                        onClick={() => loadSession(r, s)}
                        title={`Replay ${r.short} · ${s.label}`}
                      >
                        <span className="lx-sess-l">{s.label}</span>
                        <span className="lx-sess-d tnum">{wkTime(s.dt)}</span>
                        <span className="lx-sess-go">▶</span>
                      </button>
                    ) : (
                      <div className={`lx-sess future ${isNext ? "now" : ""}`} key={i}>
                        <span className="lx-sess-l">{s.label}</span>
                        <span className="lx-sess-d tnum">{wkTime(s.dt)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {loadErr && !loading && (
        <div className="lx-toast glass" role="status" onClick={() => setLoadErr(null)}>
          {loadErr}
        </div>
      )}
      {loading && (
        <div className="lx-loading">
          <div className="lx-loading-card glass">
            <div className="lx-spin" />
            <div className="lx-loading-t">Loading {loading}</div>
            <div className="lx-loading-s dim">Fetching &amp; parsing the session…</div>
          </div>
        </div>
      )}
    </div>
  );
}
