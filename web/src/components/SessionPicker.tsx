// Session picker: year → event → session dropdowns that load any public
// session into the shared engine at runtime (the WS resyncs automatically).
// When a session is already loaded, the dropdowns preselect it so the bar shows
// what you're watching instead of empty "Event…/Session…" placeholders.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";

interface SessionEntry {
  name: string;
  kind: string;
}
interface EventInfo {
  name: string;
  sessions: SessionEntry[];
}

/** Loose name match: case- and accent-insensitive, trimmed. */
function normEq(a?: string | null, b?: string | null): boolean {
  const norm = (s?: string | null) =>
    (s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
  return !!a && !!b && norm(a) === norm(b);
}

export default function SessionPicker() {
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number | "">("");
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [event, setEvent] = useState("");
  const [session, setSession] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/years")
      .then((r) => r.json())
      .then((ys: number[]) => {
        setYears(ys);
        setYear(ys.includes(2024) ? 2024 : ys[ys.length - 1]);
      })
      .catch(() => setNote("picker unavailable"));
  }, []);

  useEffect(() => {
    if (year === "") return;
    setEvents([]);
    setEvent("");
    setSession("");
    fetch(`/api/index/${year}`)
      .then((r) => r.json())
      .then((evs: EventInfo[]) => setEvents(Array.isArray(evs) ? evs : []))
      .catch(() => setEvents([]));
  }, [year]);

  const sessions = useMemo(() => events.find((e) => e.name === event)?.sessions ?? [], [events, event]);

  // Preselect the currently loaded session so the picker reflects what's on
  // screen. Runs once per distinct loaded session (so manual picks aren't
  // overridden), stepping year → event → session as each list becomes ready.
  const loaded = useStore((s) => s.state.session);
  const loadedYear = loaded?.year ?? (loaded?.path ? parseInt(String(loaded.path).slice(0, 4), 10) : undefined);
  const loadedEvent = loaded?.meetingName ?? "";
  const loadedSession = loaded?.sessionName ?? "";
  const sig = `${loadedYear ?? ""}|${loadedEvent}|${loadedSession}`;
  const syncedSig = useRef("");
  useEffect(() => {
    if (!loadedYear || !loadedEvent) return;
    if (syncedSig.current === sig) return;
    if (year !== loadedYear) {
      if (years.includes(loadedYear)) setYear(loadedYear);
      return; // wait for the new year's events to load, then re-run
    }
    if (!events.length) return;
    const ev = events.find((e) => normEq(e.name, loadedEvent));
    if (!ev) {
      syncedSig.current = sig; // not in this index; leave the placeholder
      return;
    }
    if (event !== ev.name) {
      setEvent(ev.name);
      return;
    }
    const ss = ev.sessions.find((s) => normEq(s.name, loadedSession));
    if (ss && session !== ss.name) setSession(ss.name);
    syncedSig.current = sig;
  }, [sig, loadedYear, loadedEvent, loadedSession, year, years, events, event, session]);

  const load = async () => {
    if (year === "" || !event || !session) return;
    setBusy(true);
    setNote("Loading…");
    try {
      await fetch("/api/session/load", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ year, event, session, car_stride: 3, pos_stride: 3 }),
      });
      // Poll until the fetch completes server-side.
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        const st = await fetch("/api/session/status").then((r) => r.json());
        if (!st.loading) {
          setNote(st.error ? "load failed" : null);
          break;
        }
      }
    } catch {
      setNote("load failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="picker">
      <select value={year} onChange={(e) => setYear(Number(e.target.value))} title="Season">
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <select value={event} onChange={(e) => setEvent(e.target.value)} title="Event" disabled={!events.length}>
        <option value="">Event…</option>
        {events.map((ev) => (
          <option key={ev.name} value={ev.name}>
            {ev.name.replace(/ Grand Prix$/, "")}
          </option>
        ))}
      </select>
      <select value={session} onChange={(e) => setSession(e.target.value)} title="Session" disabled={!event}>
        <option value="">Session…</option>
        {sessions.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <button onClick={load} disabled={busy || !event || !session}>
        {busy ? "…" : "Load"}
      </button>
      {note && <span className="picker-note dim">{note}</span>}
    </div>
  );
}
