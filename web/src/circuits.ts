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

export interface XY {
  x: number;
  y: number;
}

/** Project geo coords (lng,lat) to an isotropic planar frame (cos-lat corrected). */
export function geoToPlanar(coords: LngLat[]): XY[] {
  if (!coords.length) return [];
  const lat0 = (coords.reduce((a, [, lat]) => a + lat, 0) / coords.length) * (Math.PI / 180);
  const k = Math.cos(lat0) || 1;
  return coords.map(([lng, lat]) => ({ x: lng * k, y: lat }));
}

export interface Fit {
  apply: (p: XY) => XY;
  cost: number;
}

/** Best-fit similarity transform (scale + rotation + reflection + translation)
 *  mapping `src` onto `dst`, found by a brute-force rotation sweep minimizing a
 *  Chamfer distance. Used to place F1 position dots onto the geo circuit. */
export function fitSimilarity(src: XY[], dst: XY[]): Fit | null {
  if (src.length < 10 || dst.length < 10) return null;
  const centroid = (a: XY[]) => ({
    x: a.reduce((s, p) => s + p.x, 0) / a.length,
    y: a.reduce((s, p) => s + p.y, 0) / a.length,
  });
  const rms = (a: XY[], c: XY) =>
    Math.sqrt(a.reduce((s, p) => s + (p.x - c.x) ** 2 + (p.y - c.y) ** 2, 0) / a.length) || 1;

  const cs = centroid(src);
  const cd = centroid(dst);
  const ss = rms(src, cs);
  const sd = rms(dst, cd);
  const srcN = src.map((p) => ({ x: (p.x - cs.x) / ss, y: (p.y - cs.y) / ss }));
  const dstN = dst.map((p) => ({ x: (p.x - cd.x) / sd, y: (p.y - cd.y) / sd }));

  // Sample src for speed.
  const step = Math.max(1, Math.floor(srcN.length / 60));
  const srcS = srcN.filter((_, i) => i % step === 0);
  const chamfer = (A: XY[]) => {
    let sum = 0;
    for (const p of A) {
      let m = Infinity;
      for (const q of dstN) {
        const dd = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
        if (dd < m) m = dd;
      }
      sum += m;
    }
    return sum / A.length;
  };

  let best = { cost: Infinity, theta: 0, refl: 1 };
  const steps = 144;
  for (const refl of [1, -1]) {
    for (let k = 0; k < steps; k++) {
      const th = (k / steps) * 2 * Math.PI;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const A = srcS.map((p) => {
        const x = refl * p.x;
        const y = p.y;
        return { x: x * ct - y * st, y: x * st + y * ct };
      });
      const c = chamfer(A);
      if (c < best.cost) best = { cost: c, theta: th, refl };
    }
  }

  const { theta, refl, cost } = best;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const apply = (p: XY): XY => {
    const x = ((p.x - cs.x) / ss) * refl;
    const y = (p.y - cs.y) / ss;
    const rx = x * ct - y * st;
    const ry = x * st + y * ct;
    return { x: rx * sd + cd.x, y: ry * sd + cd.y };
  };
  return { apply, cost };
}
