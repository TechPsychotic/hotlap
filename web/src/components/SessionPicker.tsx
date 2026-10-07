// Session picker: year → event → session dropdowns that load any public
// session into the shared engine at runtime (the WS resyncs automatically).

import { useEffect, useMemo, useState } from "react";

interface SessionEntry {
  name: string;
  kind: string;
}
interface EventInfo {
  name: string;
  sessions: SessionEntry[];
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
