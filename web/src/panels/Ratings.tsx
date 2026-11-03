// Ratings — driver ratings and track rankings, precomputed offline from years
// of historical results (ml/build_artifacts.py) and shipped as static JSON. The
// driver scores are team-mate-relative (car-independent) where possible; the
// track scores summarise overtaking and incidents. These same features feed the
// predictive models.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";

interface DriverRating {
  id: string;
  code: string;
  name: string;
  rating: number;
  quali: number;
  race: number;
  consistency: number;
  avgFinish: number | null;
  posGained: number;
  starts: number;
}
interface TrackRanking {
  id: string;
  name: string;
  country: string;
  overtaking: number;
  incidents: number;
  avgDnf: number;
  races: number;
}

function Bar({ v, color }: { v: number; color: string }) {
  return (
    <div className="rt-bar">
      <div className="rt-bar-fill" style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: color }} />
    </div>
  );
}

function ratingColor(v: number): string {
  // red (low) → amber → green (high)
  const h = Math.max(0, Math.min(120, (v / 100) * 120));
  return `hsl(${h} 70% 48%)`;
}

export default function Ratings() {
  const [tab, setTab] = useState<"drivers" | "tracks">("drivers");
  const [drivers, setDrivers] = useState<DriverRating[] | null>(null);
  const [tracks, setTracks] = useState<TrackRanking[] | null>(null);
  const [err, setErr] = useState(false);

  // Drivers currently in the session — highlight those. Select the stable
  // drivers map (not a fresh Set) to avoid an infinite re-render loop.
  const driversMap = useStore((s) => s.state.drivers);
  const sessionCodes = useMemo(
    () => new Set(Object.values(driversMap ?? {}).map((d) => d.tla).filter(Boolean) as string[]),
    [driversMap],
  );
  const circuitName = useStore((s) => s.state.session?.circuit);

  useEffect(() => {
    let ok = true;
    Promise.all([
      fetch("ml/driver_ratings.json").then((r) => r.json()),
      fetch("ml/track_rankings.json").then((r) => r.json()),
    ])
      .then(([dr, tr]) => {
        if (!ok) return;
        setDrivers(dr.drivers ?? []);
        setTracks(tr.tracks ?? []);
      })
      .catch(() => ok && setErr(true));
    return () => {
      ok = false;
    };
  }, []);

  const curTrack = useMemo(() => {
    if (!tracks || !circuitName) return null;
    const n = circuitName.toLowerCase();
    return tracks.find((t) => t.name.toLowerCase().includes(n) || n.includes(t.name.toLowerCase().split(" ")[0]))?.id ?? null;
  }, [tracks, circuitName]);

  if (err) {
    return (
      <div className="panel rt">
        <div className="empty">
          Ratings artifacts not found. Build them with <code>python3 ml/build_artifacts.py</code>.
        </div>
      </div>
    );
  }
  if (!drivers || !tracks) {
    return <div className="panel rt"><div className="empty">Loading ratings…</div></div>;
  }

  return (
    <div className="panel rt">
      <div className="rt-tabs">
        <button className={tab === "drivers" ? "on" : ""} onClick={() => setTab("drivers")}>
          Drivers
        </button>
        <button className={tab === "tracks" ? "on" : ""} onClick={() => setTab("tracks")}>
          Tracks
        </button>
        <span className="rt-note dim">team-mate-relative · {drivers.length ? "2019–2024" : ""}</span>
      </div>

      <div className="panel-scroll">
        {tab === "drivers" ? (
          <table className="rt-table">
            <thead>
              <tr><th className="r">#</th><th>Driver</th><th className="rt-w">Rating</th><th className="r">Q</th><th className="r">R</th><th className="r">Con</th></tr>
            </thead>
            <tbody>
              {drivers.map((d, i) => (
                <tr key={d.id} className={sessionCodes.has(d.code) ? "rt-cur" : ""}>
                  <td className="r dim tnum">{i + 1}</td>
                  <td className="rt-name"><b>{d.code}</b> <span className="dim">{d.name}</span></td>
                  <td className="rt-w">
                    <div className="rt-bar-row">
                      <Bar v={d.rating} color={ratingColor(d.rating)} />
                      <span className="tnum rt-val">{d.rating.toFixed(0)}</span>
                    </div>
                  </td>
                  <td className="r tnum dim">{d.quali.toFixed(0)}</td>
                  <td className="r tnum dim">{d.race.toFixed(0)}</td>
                  <td className="r tnum dim">{d.consistency.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="rt-table">
            <thead>
              <tr><th className="r">#</th><th>Circuit</th><th className="rt-w">Overtaking</th><th className="rt-w">Incidents</th><th className="r">GP</th></tr>
            </thead>
            <tbody>
              {tracks.map((t, i) => (
                <tr key={t.id} className={curTrack === t.id ? "rt-cur" : ""}>
                  <td className="r dim tnum">{i + 1}</td>
                  <td className="rt-name"><b>{t.name.replace(/ (Circuit|Grand Prix).*/,"")}</b> <span className="dim">{t.country}</span></td>
                  <td className="rt-w"><div className="rt-bar-row"><Bar v={t.overtaking} color="var(--green)" /><span className="tnum rt-val">{t.overtaking.toFixed(0)}</span></div></td>
                  <td className="rt-w"><div className="rt-bar-row"><Bar v={t.incidents} color="var(--accent)" /><span className="tnum rt-val">{t.incidents.toFixed(0)}</span></div></td>
                  <td className="r tnum dim">{t.races}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
