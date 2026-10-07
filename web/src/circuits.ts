// Static circuit outlines (bundled f1-circuits GeoJSON), used to draw the track
// map when no live/recorded position data is available (e.g. gated live feeds).

export type LngLat = [number, number];

interface Feature {
  properties: { id: string; Location: string; Name: string };
  geometry: { type: string; coordinates: LngLat[] };
}

let cache: Feature[] | null = null;
let loading: Promise<Feature[]> | null = null;

/** Load (and memoize) the circuit dataset. */
export function loadCircuits(): Promise<Feature[]> {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = fetch("/circuits.geojson")
      .then((r) => r.json())
      .then((d) => {
        const feats: Feature[] = Array.isArray(d?.features) ? d.features : [];
        cache = feats;
        return feats;
      })
      .catch(() => {
        cache = [];
        return [] as Feature[];
      });
  }
  return loading;
}

const norm = (s?: string | null) => (s ?? "").toLowerCase();

// Common filler words that would otherwise match many circuit names.
const STOP = new Set([
  "grand",
  "prix",
  "circuit",
  "international",
  "autodromo",
  "autódromo",
  "speedway",
  "raceway",
  "park",
  "street",
  "the",
  "and",
  "gp",
]);

/** Best-matching circuit outline for a session, by circuit/country/meeting name. */
export function matchCircuit(
  features: Feature[],
  session: { circuit?: string | null; country?: string | null; meetingName?: string | null },
): LngLat[] | null {
  const tokens = [norm(session.circuit), norm(session.country), norm(session.meetingName)];
  let best: Feature | null = null;
  let bestScore = 0;
  for (const f of features) {
    const hay = `${norm(f.properties.Location)} ${norm(f.properties.Name)}`;
    let score = 0;
    for (const t of tokens) {
      for (const w of t.split(/\s+/)) {
        if (w.length >= 3 && !STOP.has(w) && hay.includes(w)) score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best && bestScore > 0 ? best.geometry.coordinates : null;
}
