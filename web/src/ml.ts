// Client-side inference for the offline-trained predictive models.
//
// The models are tiny and interpretable (empirical conversion curves, a trained
// logistic, and per-compound degradation polynomials) so they run right here in
// the browser from the JSON artifacts under /ml/ — no ONNX/native runtime, and
// nothing needed from the server. Training lives in ml/build_models.py.
//
// Everything is defensive: if an artifact is missing or a field is absent the
// helpers fall back to sane defaults so panels still render.

import type { SessionState } from "./types.gen";
import { orderByPosition, getGrid } from "./store";

// --------------------------------------------------------------- model shapes
interface WinnerModel {
  winByGrid: number[]; // index = grid slot (1-based; [0] unused)
  podiumByGrid: number[];
  pointsByGrid: number[];
  logistic: { w0: number; wGrid: number; wRating: number };
  progressSharpen: number;
  ratingFalloff: number;
}
interface DegCurve {
  a1: number;
  a2: number;
  maxAge?: number;
  n: number;
}
interface StrategyModel {
  tyreDeg: Record<string, DegCurve>;
  compoundOffset: Record<string, number>;
  pitLossByCircuit: Record<string, number>;
  pitLossDefault: number;
}
interface RatingsArtifact {
  drivers: { code: string; rating: number }[];
}

export interface Models {
  winner: WinnerModel | null;
  strategy: StrategyModel | null;
  ratingByCode: Record<string, number>;
}

let cache: Promise<Models> | null = null;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Load (once) all model artifacts; always resolves, with nulls on failure. */
export function loadModels(): Promise<Models> {
  if (!cache) {
    cache = Promise.all([
      getJson<WinnerModel>("ml/winner_model.json"),
      getJson<StrategyModel>("ml/strategy_model.json"),
      getJson<RatingsArtifact>("ml/driver_ratings.json"),
    ]).then(([winner, strategy, ratings]) => {
      const ratingByCode: Record<string, number> = {};
      for (const d of ratings?.drivers ?? []) ratingByCode[d.code] = d.rating;
      return { winner, strategy, ratingByCode };
    });
  }
  return cache;
}

// ----------------------------------------------------------------- utilities
function sigmoid(x: number): number {
  return x < -40 ? 0 : x > 40 ? 1 : 1 / (1 + Math.exp(-x));
}
function logit(p: number): number {
  const q = Math.min(0.999, Math.max(0.001, p));
  return Math.log(q / (1 - q));
}
function at(arr: number[] | undefined, i: number, dflt: number): number {
  if (!arr || !arr.length) return dflt;
  return arr[Math.min(Math.max(1, i), arr.length - 1)] ?? dflt;
}

const COMPOUND_FALLBACK = "MEDIUM";

/** Seconds/lap this tyre is currently slower than its own fresh self at `age`. */
export function tyreLoss(m: StrategyModel | null, compound: string | undefined, age: number): number {
  const comp = (compound ?? COMPOUND_FALLBACK).toUpperCase();
  const c = m?.tyreDeg?.[comp] ?? m?.tyreDeg?.[COMPOUND_FALLBACK];
  if (!c) return 0.05 * Math.max(0, age); // generic ~0.05s/lap fallback
  // Clamp to the trusted age range — past it the quadratic extrapolates wildly,
  // so hold the curve flat at its last trustworthy value instead.
  const a = Math.min(Math.max(0, age), c.maxAge ?? 35);
  return Math.max(0, c.a1 * a + c.a2 * a * a);
}

/** Fresh-lap pace penalty of a compound vs the quickest fresh compound (s/lap). */
export function compoundOffset(m: StrategyModel | null, compound: string | undefined): number {
  const comp = (compound ?? COMPOUND_FALLBACK).toUpperCase();
  return m?.compoundOffset?.[comp] ?? 0;
}

/** Full pit-lane time loss (s) for a circuit, by loose name match. */
export function pitLoss(m: StrategyModel | null, circuit?: string | null): number {
  const dflt = m?.pitLossDefault ?? 22;
  if (!m?.pitLossByCircuit || !circuit) return dflt;
  const n = circuit.toLowerCase();
  for (const [k, v] of Object.entries(m.pitLossByCircuit)) {
    const kl = k.toLowerCase();
    if (n.includes(kl) || kl.includes(n.split(" ")[0])) return v;
  }
  return dflt;
}

// ------------------------------------------------------- race-winner inference
export interface WinRow {
  num: string;
  win: number; // P(wins the race)
  podium: number; // P(finishes top 3)
  points: number; // P(finishes top 10)
}

/**
 * Win / podium / points probabilities for every running driver, from the
 * current order. The grid→result curves give a base rate for each position;
 * a driver's car-independent rating nudges it (less as the race progresses);
 * then scores are sharpened by race progress and normalised across the field
 * so wins sum to 1, podiums to 3, points to 10.
 */
export function winProbabilities(m: Models, state: SessionState): Record<string, WinRow> {
  const out: Record<string, WinRow> = {};
  const wm = m.winner;
  if (!wm) return out;
  const timing = state.timing ?? {};
  const drivers = state.drivers ?? {};
  const order = orderByPosition(state).filter((n) => !timing[n]?.retired && !timing[n]?.stopped);
  if (order.length === 0) return out;

  const lap = state.lapCount?.currentLap ?? 0;
  const total = state.lapCount?.totalLaps ?? 0;
  const f = total > 0 ? Math.min(1, Math.max(0, lap / total)) : 0; // race progress
  const sharpen = 1 + wm.progressSharpen * f;
  const ratingW = wm.logistic.wRating * (1 - wm.ratingFalloff * f);

  const winScore: number[] = [];
  const podScore: number[] = [];
  const ptsScore: number[] = [];
  order.forEach((num, i) => {
    const pos = i + 1; // current running position among classified
    const code = drivers[num]?.tla ?? "";
    const z = ((m.ratingByCode[code] ?? 70) - 70) / 12;
    // Start-of-race, blend current position with the locked grid slot so early
    // laps don't overreact to lap-1 chaos; by ~20% distance it's all position.
    const grid = getGrid(num);
    const blend = grid != null ? Math.min(1, f / 0.2) : 1;
    const effPos = grid != null ? blend * pos + (1 - blend) * grid : pos;
    const gi = Math.round(effPos);
    const pWin = sigmoid(wm.logistic.w0 + wm.logistic.wGrid * logit(at(wm.winByGrid, gi, 0.001)) + ratingW * z);
    winScore[i] = Math.pow(Math.max(1e-6, pWin), sharpen);
    podScore[i] = Math.pow(Math.max(1e-6, at(wm.podiumByGrid, gi, 0.02)), sharpen) * (1 + 0.15 * z);
    ptsScore[i] = Math.pow(Math.max(1e-6, at(wm.pointsByGrid, gi, 0.05)), 1 + 0.6 * f) * (1 + 0.1 * z);
  });

  const norm = (scores: number[], mass: number) => {
    const s = scores.reduce((a, b) => a + b, 0) || 1;
    return scores.map((v) => Math.min(1, (v / s) * mass));
  };
  const win = norm(winScore, 1);
  const pod = norm(podScore, 3);
  const pts = norm(ptsScore, Math.min(10, order.length));

  order.forEach((num, i) => {
    out[num] = { num, win: win[i], podium: pod[i], points: pts[i] };
  });
  return out;
}

// ----------------------------------------------------- pit / stint strategy
export interface StintPlan {
  age: number; // current tyre age (laps on this set)
  lapsLeft: number;
  curLossNow: number; // s/lap currently lost to tyre wear
  recommend: "box-now" | "pit-soon" | "hold" | "run-to-end" | "na";
  pitLap: number | null; // absolute lap of the suggested stop (null = none)
  gain: number; // projected net time gain of the plan vs staying out (s)
  altCompound: string | null;
}

const ALTS = ["SOFT", "MEDIUM", "HARD"];

/**
 * A one-stop-from-here plan for a driver: simulate pitting on each remaining lap
 * (and not at all) using the learned degradation curves + circuit pit loss, and
 * return the cheapest. Pace terms shared by all strategies cancel, so only
 * degradation, compound offset, and pit loss matter.
 */
export function stintPlan(
  m: Models,
  state: SessionState,
  num: string,
): StintPlan {
  const sm = m.strategy;
  const timing = state.timing ?? {};
  const stints = state.stints?.[num] ?? [];
  const cur = stints[stints.length - 1];
  const compound = (state.currentTyres?.[num]?.compound ?? cur?.compound ?? "").toUpperCase();
  const lap = state.lapCount?.currentLap ?? timing[num]?.numberOfLaps ?? 0;
  const total = state.lapCount?.totalLaps ?? 0;
  const lapsLeft = total > 0 ? Math.max(0, total - lap) : 0;
  // Current tyre age (laps on this set): `totalLaps` is the running age the
  // feed maintains for the active stint (age-at-fit + laps since).
  const age = cur?.totalLaps ?? 0;

  const na: StintPlan = {
    age,
    lapsLeft,
    curLossNow: 0,
    recommend: "na",
    pitLap: null,
    gain: 0,
    altCompound: null,
  };
  if (!sm || !compound || lapsLeft < 2 || total <= 0) return na;

  const curLossNow = tyreLoss(sm, compound, age);

  // Cost (relative seconds) of running `k` laps on `comp` starting at `age0`.
  const run = (comp: string, age0: number, k: number) => {
    let s = 0;
    const off = compoundOffset(sm, comp);
    for (let i = 0; i < k; i++) s += tyreLoss(sm, comp, age0 + i) + off;
    return s;
  };

  // Baseline: stay out to the end on the current tyre.
  const stay = run(compound, age, lapsLeft);

  // Try pitting after `k` more laps (k=0..lapsLeft-1) onto the best alternate.
  let best = { cost: stay, pitLap: null as number | null, alt: null as string | null };
  const pl = pitLoss(sm, state.session?.circuit);
  for (let k = 0; k <= lapsLeft - 1; k++) {
    const after = lapsLeft - k;
    for (const alt of ALTS) {
      const cost = run(compound, age, k) + pl + run(alt, 0, after);
      if (cost < best.cost - 0.01) best = { cost, pitLap: lap + k, alt };
    }
  }

  const gain = stay - best.cost;
  // A pure-pace stop that nets only a couple of seconds isn't worth the track
  // position this model can't see, so below a margin we call it run-to-end.
  const GAIN_MIN = 3.0;
  let recommend: StintPlan["recommend"];
  if (best.pitLap == null || gain < GAIN_MIN) recommend = "run-to-end";
  else if (best.pitLap - lap <= 1) recommend = "box-now";
  else if (best.pitLap - lap <= 5) recommend = "pit-soon";
  else recommend = "hold";

  return { age, lapsLeft, curLossNow, recommend, pitLap: best.pitLap, gain, altCompound: best.alt };
}

/**
 * Undercut outlook: if a chasing car pits now, roughly how many seconds it would
 * gain on the car ahead over the next lap (fresh-tyre delta minus nothing — the
 * pit loss is paid by both once the ahead car responds). Positive ⇒ the stop
 * threatens the car ahead; compare with the live interval.
 */
export function undercutDelta(
  m: Models,
  state: SessionState,
  num: string,
): number {
  const sm = m.strategy;
  if (!sm) return 0;
  const stints = state.stints?.[num] ?? [];
  const cur = stints[stints.length - 1];
  const compound = (state.currentTyres?.[num]?.compound ?? cur?.compound ?? "").toUpperCase();
  const age = cur?.totalLaps ?? 0;
  // Fresh tyre vs a worn one, over one lap: the worn car loses tyreLoss(age),
  // the fresh car pays only its compound offset.
  return Math.max(0, tyreLoss(sm, compound, age) - compoundOffset(sm, "SOFT"));
}
