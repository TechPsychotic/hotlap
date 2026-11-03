#!/usr/bin/env python3
"""Train Hotlap's predictive models offline and ship them as static JSON.

Two models are produced; both are small, interpretable, and evaluated in the
browser (TypeScript, see web/src/ml.ts) — there is no Python, ONNX, or native
inference runtime at request time. This keeps the app local-first and keeps the
frontend-only (GitHub Pages) build viable. The "offline-train, ship artifacts"
principle is unchanged; only the serialisation is plain coefficients instead of
an ONNX graph, because these models are linear / empirical-curve shaped and a
tensor runtime would add weight without adding accuracy.

  winner_model.json
    Empirical P(win|grid), P(podium|grid), P(points|grid) conversion curves from
    many seasons of results, PLUS a trained 3-parameter logistic that says how
    much a driver's (car-independent) rating shifts win odds on top of grid
    position. Used for race-winner / podium probabilities.

  strategy_model.json
    Per-compound tyre-degradation curves (seconds/lap added as a function of
    tyre age), fresh-compound pace offsets, and per-circuit pit loss, fit from
    OpenF1 lap/stint/pit data (2023+). Used for pit-window, undercut/overcut,
    and stint-pace projection.

Usage:
    python3 ml/build_models.py [--from 2014] [--to 2024] [--of1 2023,2024]
                               [--races 8]

Outputs ml/out/{winner_model,strategy_model}.json and the shipped copies under
web/public/ml/.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import urllib.error
import urllib.request
from collections import defaultdict

ERGAST = "https://api.jolpi.ca/ergast/f1"
OPENF1 = "https://api.openf1.org/v1"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "out")
SHIP = os.path.join(HERE, "..", "web", "public", "ml")

MAX_GRID = 24  # grid slots we model (fields are <=20 now, roomy for history)


# --------------------------------------------------------------------------- IO
def _get(url: str, tag: str) -> dict | list:
    """GET JSON with retry/backoff, cached under data/<tag>.json."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{tag}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    req = urllib.request.Request(url, headers={"User-Agent": "hotlap-ml/0.2"})
    last: Exception | None = None
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.loads(r.read().decode())
            with open(path, "w") as f:
                json.dump(data, f)
            return data
        except urllib.error.HTTPError as e:  # noqa: PERF203
            last = e
            if e.code == 404:
                return {}
            time.sleep(1.0 * (2**attempt))
        except Exception as e:  # noqa: BLE001 - transient/rate-limit
            last = e
            time.sleep(1.0 * (2**attempt))
    raise RuntimeError(f"failed to fetch {url}: {last}")


def fetch_ergast_results(year: int) -> list[dict]:
    # Own cache namespace (wm_) so we don't collide with build_artifacts.py,
    # which stores this season under a different, incompatible shape.
    os.makedirs(CACHE, exist_ok=True)
    merged = os.path.join(CACHE, f"wm_{year}_results.json")
    if os.path.exists(merged):
        with open(merged) as f:
            return json.load(f)
    races: list[dict] = []
    offset = 0
    while True:
        data = _get(
            f"{ERGAST}/{year}/results.json?limit=100&offset={offset}",
            f"wm_{year}_results_p{offset}",
        )
        if not data:
            break
        mr = data["MRData"]
        page = mr["RaceTable"]["Races"]
        for race in page:
            existing = next((r for r in races if r["round"] == race["round"]), None)
            if existing:
                existing.setdefault("Results", []).extend(race.get("Results", []))
            else:
                races.append(race)
        total = int(mr["total"])
        offset += 100
        if offset >= total or not page:
            break
        time.sleep(0.4)
    with open(merged, "w") as f:
        json.dump(races, f)
    return races


# -------------------------------------------------------------- small utilities
def sigmoid(x: float) -> float:
    if x < -40:
        return 0.0
    if x > 40:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def logit(p: float) -> float:
    p = min(0.999, max(0.001, p))
    return math.log(p / (1.0 - p))


def is_classified(res: dict) -> bool:
    return res.get("positionText", "").isdigit()


def solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Tiny Gaussian elimination for the normal equations (n<=3)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[piv][c]) < 1e-12:
            return [0.0] * n
        m[c], m[piv] = m[piv], m[c]
        pv = m[c][c]
        m[c] = [v / pv for v in m[c]]
        for r in range(n):
            if r != c and abs(m[r][c]) > 1e-15:
                f = m[r][c]
                m[r] = [v - f * m[c][i] for i, v in enumerate(m[r])]
    return [m[i][n] for i in range(n)]


# ------------------------------------------------------------- winner model
def load_ratings() -> dict[str, float]:
    """driverId -> overall rating, from the ratings artifact (or empty)."""
    path = os.path.join(OUT, "driver_ratings.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        obj = json.load(f)
    return {d["id"]: d["rating"] for d in obj.get("drivers", [])}


def build_winner_model(seasons: list[int]) -> dict:
    ratings = load_ratings()
    starts = [0] * (MAX_GRID + 1)
    wins = [0] * (MAX_GRID + 1)
    podium = [0] * (MAX_GRID + 1)
    points = [0] * (MAX_GRID + 1)
    samples: list[tuple[float, float, int]] = []  # (p_grid_logit, rating_z, won)

    for year in seasons:
        for race in fetch_ergast_results(year):
            for res in race.get("Results", []):
                grid = int(res.get("grid", 0) or 0)
                if grid < 1 or grid > MAX_GRID:
                    continue  # pit-lane start / out of range
                starts[grid] += 1
                if is_classified(res):
                    fin = int(res["positionText"])
                    if fin == 1:
                        wins[grid] += 1
                    if fin <= 3:
                        podium[grid] += 1
                    if fin <= 10:
                        points[grid] += 1

    # Empirical conversion curves, smoothed toward a gently decaying prior so
    # sparse deep-grid slots stay monotonic-ish instead of spiking on noise.
    def curve(num: list[int], prior0: float, decay: float) -> list[float]:
        out = [0.0]
        for g in range(1, MAX_GRID + 1):
            prior = prior0 * (decay ** (g - 1))
            k = 8.0  # prior strength (pseudo-races)
            out.append(round((num[g] + k * prior) / (starts[g] + k), 4) if starts[g] or k else 0.0)
        return out

    win_by_grid = curve(wins, 0.33, 0.72)
    podium_by_grid = curve(podium, 0.60, 0.82)
    points_by_grid = curve(points, 0.90, 0.90)

    # Trained logistic: P(win) = sigmoid(w0 + wGrid*logit(p_grid) + wRating*z),
    # z = (rating-70)/12. Learns how much rating adds on top of grid position.
    for year in seasons:
        for race in fetch_ergast_results(year):
            for res in race.get("Results", []):
                grid = int(res.get("grid", 0) or 0)
                if grid < 1 or grid > MAX_GRID:
                    continue
                did = res["Driver"]["driverId"]
                r = ratings.get(did, 70.0)
                won = 1 if is_classified(res) and int(res["positionText"]) == 1 else 0
                samples.append((logit(win_by_grid[grid]), (r - 70.0) / 12.0, won))

    w = [0.0, 1.0, 0.0]  # [w0, wGrid, wRating]
    lr = 0.05
    n = len(samples) or 1
    for _ in range(600):
        g0 = g1 = g2 = 0.0
        for xg, xr, y in samples:
            p = sigmoid(w[0] + w[1] * xg + w[2] * xr)
            e = p - y
            g0 += e
            g1 += e * xg
            g2 += e * xr
        w[0] -= lr * g0 / n
        w[1] -= lr * g1 / n
        w[2] -= lr * g2 / n

    return {
        "generated": time.strftime("%Y-%m-%d"),
        "seasons": seasons,
        "races": sum(1 for y in seasons for _ in fetch_ergast_results(y)),
        "winByGrid": win_by_grid,
        "podiumByGrid": podium_by_grid,
        "pointsByGrid": points_by_grid,
        "logistic": {"w0": round(w[0], 4), "wGrid": round(w[1], 4), "wRating": round(w[2], 4)},
        # How the current running order overrides the grid-based prior as the
        # race unfolds (0 at lights-out → 1 at the flag). Chosen, not fit:
        # mid-race ground truth would need lap-by-lap history for every race.
        "progressSharpen": 2.6,
        "ratingFalloff": 0.65,
    }


# ------------------------------------------------------------- strategy model
def of1(path: str, tag: str) -> list:
    data = _get(f"{OPENF1}{path}", tag)
    return data if isinstance(data, list) else []


COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]


def build_strategy_model(of1_years: list[int], races_cap: int, fuel: float) -> dict:
    # (compound -> list of (age, delta_sec)) and fresh-pace samples per session.
    deg: dict[str, list[tuple[float, float]]] = defaultdict(list)
    pit_by_circuit: dict[str, list[float]] = defaultdict(list)
    sessions_used = 0

    for year in of1_years:
        sessions = of1(f"/sessions?year={year}&session_type=Race", f"of1_sessions_{year}")
        sessions = sessions[:races_cap] if races_cap else sessions
        for s in sessions:
            sk = s.get("session_key")
            circuit = s.get("circuit_short_name") or str(s.get("circuit_key", "?"))
            if sk is None:
                continue
            laps = of1(f"/laps?session_key={sk}", f"of1_laps_{sk}")
            stints = of1(f"/stints?session_key={sk}", f"of1_stints_{sk}")
            pits = of1(f"/pit?session_key={sk}", f"of1_pit_{sk}")
            time.sleep(0.3)
            if not laps or not stints:
                continue
            sessions_used += 1

            # lap_duration by (driver, lap_number), skipping pit in/out laps.
            # Fuel-correct: a car sheds ~1.6 kg/lap, so lap times fall as a race
            # runs, which would otherwise mask (even invert) tyre degradation.
            # Add `fuel` s per lap-of-race back, pinning every lap to full-fuel
            # equivalent so the remaining trend over a stint is tyre wear.
            dur: dict[tuple[int, int], float] = {}
            for lp in laps:
                d = lp.get("driver_number")
                ln = lp.get("lap_number")
                ld = lp.get("lap_duration")
                if d is None or ln is None or not ld:
                    continue
                if lp.get("is_pit_out_lap"):
                    continue
                dur[(d, ln)] = float(ld) + fuel * int(ln)

            # Clean-lap median this session → reject safety-car / lapped traffic.
            all_d = sorted(dur.values())
            if not all_d:
                continue
            med = all_d[len(all_d) // 2]
            ceil = med * 1.18  # laps slower than this are SC/traffic/errors

            for st in stints:
                d = st.get("driver_number")
                comp = (st.get("compound") or "").upper()
                l0 = st.get("lap_start")
                l1 = st.get("lap_end")
                age0 = st.get("tyre_age_at_start")
                if d is None or comp not in COMPOUNDS or l0 is None or l1 is None:
                    continue
                age0 = int(age0) if age0 is not None else 0
                # Clean laps in this stint with their tyre age.
                pts: list[tuple[float, float]] = []
                for ln in range(int(l0), int(l1) + 1):
                    v = dur.get((d, ln))
                    if v is None or v > ceil:
                        continue
                    age = age0 + (ln - int(l0))
                    pts.append((float(age), v))
                if len(pts) < 4:
                    continue
                # Stint baseline = fresh pace: median of its youngest clean laps.
                pts.sort(key=lambda p: p[0])
                base = sorted(v for _, v in pts[: max(3, len(pts) // 4)])
                baseline = base[len(base) // 2]
                for age, v in pts:
                    deg[comp].append((age, v - baseline))

            for p in pits:
                pd = p.get("pit_duration")
                if pd and 12.0 < float(pd) < 40.0:  # plausible full pit-lane loss
                    pit_by_circuit[circuit].append(float(pd))

    # Fit delta = a1*age + a2*age^2 per compound (through ~origin).
    tyre_deg: dict[str, dict] = {}
    for comp in COMPOUNDS:
        pts = deg[comp]
        if len(pts) < 30:
            continue
        s11 = s12 = s22 = sy1 = sy2 = 0.0
        for age, dl in pts:
            a, a2 = age, age * age
            s11 += a * a
            s12 += a * a2
            s22 += a2 * a2
            sy1 += a * dl
            sy2 += a2 * dl
        a1, a2 = solve([[s11, s12], [s12, s22]], [sy1, sy2])
        # Beyond the observed age range the quadratic extrapolates wildly, so we
        # record the 95th-percentile age as a clamp; inference holds deg flat
        # past it rather than letting a long stint blow up to absurd s/lap.
        ages = sorted(a for a, _ in pts)
        max_age = round(ages[int(0.95 * (len(ages) - 1))])
        tyre_deg[comp] = {
            "a1": round(a1, 5),
            "a2": round(a2, 6),
            "maxAge": max_age,
            "n": len(pts),
        }

    # Fresh-compound pace offset (s/lap slower than a fresh soft, equal fuel).
    # NB: this is a *prior*, not fit from the data. Recovering it from stint
    # baselines is unreliable — compounds run in different race phases and track
    # states, which confounds a cross-stint pace comparison (our attempts came
    # out with soft slower than hard, i.e. sign-wrong). The within-stint
    # degradation curves above are self-referenced per stint, so those stay
    # empirical; only this cross-compound gap falls back to typical values.
    compound_offset = {"SOFT": 0.0, "MEDIUM": 0.5, "HARD": 1.0, "INTERMEDIATE": 8.0, "WET": 12.0}

    pit_loss = {
        c: round(sorted(v)[len(v) // 2], 2)
        for c, v in pit_by_circuit.items()
        if len(v) >= 3
    }
    default_pit = (
        round(sorted(x for v in pit_by_circuit.values() for x in v)[
            sum(len(v) for v in pit_by_circuit.values()) // 2
        ], 2)
        if pit_by_circuit
        else 22.0
    )

    return {
        "generated": time.strftime("%Y-%m-%d"),
        "openf1Years": of1_years,
        "sessions": sessions_used,
        "tyreDeg": tyre_deg,
        "compoundOffset": compound_offset,
        "pitLossByCircuit": pit_loss,
        "pitLossDefault": default_pit,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=2014)
    ap.add_argument("--to", dest="end", type=int, default=2024)
    ap.add_argument("--of1", default="2023,2024", help="OpenF1 years for tyre/pit data")
    ap.add_argument("--races", type=int, default=8, help="races per OpenF1 year (0=all)")
    ap.add_argument("--fuel", type=float, default=0.055, help="fuel-burn correction s/lap")
    args = ap.parse_args()
    seasons = list(range(args.start, args.end + 1))
    of1_years = [int(y) for y in args.of1.split(",") if y.strip()]

    print(f"Winner model: Ergast {seasons[0]}–{seasons[-1]} …")
    winner = build_winner_model(seasons)
    print(
        f"  races={winner['races']}  P(win|P1)={winner['winByGrid'][1]:.2f}"
        f"  logistic={winner['logistic']}"
    )

    print(f"Strategy model: OpenF1 {of1_years} (<= {args.races or 'all'} races/yr) …")
    strategy = build_strategy_model(of1_years, args.races, args.fuel)
    print(
        f"  sessions={strategy['sessions']}  compounds={list(strategy['tyreDeg'])}"
        f"  pitDefault={strategy['pitLossDefault']}"
    )

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(SHIP, exist_ok=True)
    for name, obj in (("winner_model", winner), ("strategy_model", strategy)):
        for d in (OUT, SHIP):
            with open(os.path.join(d, f"{name}.json"), "w") as f:
                json.dump(obj, f, indent=1)
    print(f"  wrote {OUT} and {SHIP}")


if __name__ == "__main__":
    main()
