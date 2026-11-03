#!/usr/bin/env python3
"""Build Hotlap's offline ML data artifacts from historical F1 results.

Driver ratings and track rankings are computed here, offline, from the public
Ergast/Jolpica API and written as JSON. The app ships and reads these artifacts
directly — there is no Python at runtime (see ml/README.md). The predictive
models (pit window, strategy, winner) will consume these same features.

Ratings are built to be *car-independent* where possible: the core signal is
team-mate head-to-head (same machinery), regularised for small samples and
weighted toward recent seasons.

Usage:
    python3 ml/build_artifacts.py [--from 2019] [--to 2024]

Outputs:
    ml/out/driver_ratings.json
    ml/out/track_rankings.json
    web/public/ml/{driver_ratings,track_rankings}.json   (shipped copy)
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from collections import defaultdict

ERGAST = "https://api.jolpi.ca/ergast/f1"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "out")
SHIP = os.path.join(HERE, "..", "web", "public", "ml")


# --------------------------------------------------------------------------- IO
def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "hotlap-ml/0.1"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001 - retry transient/rate-limit errors
            if attempt == 4:
                raise
            time.sleep(0.8 * (2**attempt))
    raise RuntimeError("unreachable")


def fetch_season(year: int, kind: str) -> list[dict]:
    """Fetch every race of a season for `kind` in {results, qualifying}, cached.

    Returns the list of Race objects (each with its Results/QualifyingResults)."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{year}_{kind}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    races: list[dict] = []
    offset = 0
    while True:
        url = f"{ERGAST}/{year}/{kind}.json?limit=100&offset={offset}"
        data = _get(url)["MRData"]
        page = data["RaceTable"]["Races"]
        # Races paginate by inner rows, so merge rows for the same round.
        for race in page:
            existing = next((r for r in races if r["round"] == race["round"]), None)
            key = "Results" if kind == "results" else "QualifyingResults"
            if existing:
                existing.setdefault(key, []).extend(race.get(key, []))
            else:
                races.append(race)
        total = int(data["total"])
        offset += 100
        if offset >= total or not page:
            break
        time.sleep(0.4)  # be gentle on the public API
    with open(path, "w") as f:
        json.dump(races, f)
    return races


# -------------------------------------------------------------- small utilities
def is_classified(res: dict) -> bool:
    """A real finishing position (not DNF/DNS/DSQ)."""
    return res.get("positionText", "").isdigit()


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def shrink_pct(wins: float, n: float, prior: float = 0.5, strength: float = 6.0) -> float:
    """Win rate regressed toward `prior` for small samples."""
    return (wins + strength * prior) / (n + strength) if n + strength > 0 else prior


def norm_0_100(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    lo, hi = min(values.values()), max(values.values())
    span = (hi - lo) or 1.0
    return {k: round((v - lo) / span * 100, 1) for k, v in values.items()}


# ------------------------------------------------------------- driver ratings
def build_driver_ratings(seasons: list[int]) -> dict:
    latest = max(seasons)
    # Per-driver accumulators (weighted by recency).
    name: dict[str, str] = {}
    code: dict[str, str] = {}
    q_wins: dict[str, float] = defaultdict(float)
    q_n: dict[str, float] = defaultdict(float)
    r_wins: dict[str, float] = defaultdict(float)
    r_n: dict[str, float] = defaultdict(float)
    starts: dict[str, float] = defaultdict(float)
    classified: dict[str, float] = defaultdict(float)
    sum_finish: dict[str, float] = defaultdict(float)
    sum_gained: dict[str, float] = defaultdict(float)
    gained_n: dict[str, float] = defaultdict(float)
    raw_starts: dict[str, int] = defaultdict(int)

    for year in seasons:
        w = 0.78 ** (latest - year)  # recency weighting
        results = fetch_season(year, "results")
        quali = fetch_season(year, "qualifying")
        quali_by_round = {r["round"]: r for r in quali}

        for race in results:
            ress = race.get("Results", [])
            # Team-mate groups for this race (by constructor).
            by_team: dict[str, list[dict]] = defaultdict(list)
            for res in ress:
                did = res["Driver"]["driverId"]
                name[did] = f"{res['Driver']['givenName']} {res['Driver']['familyName']}"
                code[did] = res["Driver"].get("code", did[:3].upper())
                by_team[res["Constructor"]["constructorId"]].append(res)
                starts[did] += w
                raw_starts[did] += 1
                if is_classified(res):
                    classified[did] += w
                    sum_finish[did] += w * int(res["positionText"])
                    grid = int(res.get("grid", 0) or 0)
                    if grid > 0:
                        sum_gained[did] += w * (grid - int(res["positionText"]))
                        gained_n[did] += w

            # Quali team-mate head-to-head.
            qrace = quali_by_round.get(race["round"], {})
            qpos = {q["Driver"]["driverId"]: int(q["position"]) for q in qrace.get("QualifyingResults", [])}
            for mates in by_team.values():
                if len(mates) != 2:
                    continue
                a, b = mates[0]["Driver"]["driverId"], mates[1]["Driver"]["driverId"]
                if a in qpos and b in qpos:
                    q_n[a] += w
                    q_n[b] += w
                    if qpos[a] < qpos[b]:
                        q_wins[a] += w
                    else:
                        q_wins[b] += w
                # Race head-to-head: classified beats non-classified; else lower pos wins.
                ra, rb = mates[0], mates[1]
                ca, cb = is_classified(ra), is_classified(rb)
                if ca or cb:
                    r_n[a] += w
                    r_n[b] += w
                    if ca and cb:
                        winner = a if int(ra["positionText"]) < int(rb["positionText"]) else b
                    else:
                        winner = a if ca else b
                    r_wins[winner] += w

    drivers = []
    for did in name:
        if raw_starts[did] < 10:  # need enough of a sample
            continue
        q_pct = shrink_pct(q_wins[did], q_n[did])
        r_pct = shrink_pct(r_wins[did], r_n[did])
        fin_rate = classified[did] / starts[did] if starts[did] else 0.0
        avg_finish = sum_finish[did] / classified[did] if classified[did] else None
        pos_gained = sum_gained[did] / gained_n[did] if gained_n[did] else 0.0
        quali_score = clamp(50 + (q_pct - 0.5) * 120, 0, 100)
        race_score = clamp(50 + (r_pct - 0.5) * 120, 0, 100)
        consistency = round(fin_rate * 100, 1)
        overall = round(0.4 * quali_score + 0.4 * race_score + 0.2 * consistency, 1)
        drivers.append(
            {
                "id": did,
                "code": code[did],
                "name": name[did],
                "rating": overall,
                "quali": round(quali_score, 1),
                "race": round(race_score, 1),
                "consistency": consistency,
                "teammateQualiPct": round(q_pct, 3),
                "teammateRacePct": round(r_pct, 3),
                "avgFinish": round(avg_finish, 2) if avg_finish is not None else None,
                "posGained": round(pos_gained, 2),
                "starts": raw_starts[did],
            }
        )
    drivers.sort(key=lambda d: d["rating"], reverse=True)
    return {"generated": time.strftime("%Y-%m-%d"), "seasons": seasons, "drivers": drivers}


# ------------------------------------------------------------- track rankings
def build_track_rankings(seasons: list[int]) -> dict:
    cname: dict[str, str] = {}
    country: dict[str, str] = {}
    vol_sum: dict[str, float] = defaultdict(float)  # mean |grid-finish| of classified
    vol_n: dict[str, int] = defaultdict(int)
    dnf_sum: dict[str, int] = defaultdict(int)
    field_sum: dict[str, int] = defaultdict(int)
    races_n: dict[str, int] = defaultdict(int)

    for year in seasons:
        for race in fetch_season(year, "results"):
            cid = race["Circuit"]["circuitId"]
            cname[cid] = race["Circuit"]["circuitName"]
            country[cid] = race["Circuit"]["Location"].get("country", "")
            ress = race.get("Results", [])
            if not ress:
                continue
            races_n[cid] += 1
            field_sum[cid] += len(ress)
            changes = []
            for res in ress:
                if not is_classified(res):
                    dnf_sum[cid] += 1
                    continue
                grid = int(res.get("grid", 0) or 0)
                if grid > 0:
                    changes.append(abs(grid - int(res["positionText"])))
            if changes:
                vol_sum[cid] += sum(changes) / len(changes)
                vol_n[cid] += 1

    # Rank only circuits with a stable sample; one-off races are too noisy and
    # would skew the 0–100 normalisation.
    min_races = 3
    keep = {c for c in races_n if races_n[c] >= min_races}
    overtaking_raw = {c: vol_sum[c] / vol_n[c] for c in vol_n if c in keep}
    incidents_raw = {c: dnf_sum[c] / races_n[c] for c in races_n if c in keep}
    overtaking = norm_0_100(overtaking_raw)
    incidents = norm_0_100(incidents_raw)

    tracks = []
    for cid in keep:
        tracks.append(
            {
                "id": cid,
                "name": cname[cid],
                "country": country[cid],
                "overtaking": overtaking.get(cid, 0.0),
                "incidents": incidents.get(cid, 0.0),
                "avgPosChange": round(overtaking_raw.get(cid, 0.0), 2),
                "avgDnf": round(incidents_raw.get(cid, 0.0), 2),
                "attrition": round(dnf_sum[cid] / field_sum[cid], 3) if field_sum[cid] else 0.0,
                "races": races_n[cid],
            }
        )
    tracks.sort(key=lambda t: t["overtaking"], reverse=True)
    return {"generated": time.strftime("%Y-%m-%d"), "seasons": seasons, "tracks": tracks}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=2019)
    ap.add_argument("--to", dest="end", type=int, default=2024)
    args = ap.parse_args()
    seasons = list(range(args.start, args.end + 1))

    print(f"Building artifacts from {seasons[0]}–{seasons[-1]} (Ergast/Jolpica)…")
    ratings = build_driver_ratings(seasons)
    tracks = build_track_rankings(seasons)

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(SHIP, exist_ok=True)
    for name, obj in (("driver_ratings", ratings), ("track_rankings", tracks)):
        for d in (OUT, SHIP):
            with open(os.path.join(d, f"{name}.json"), "w") as f:
                json.dump(obj, f, indent=1)
    print(f"  drivers: {len(ratings['drivers'])}   tracks: {len(tracks['tracks'])}")
    top = ", ".join(f"{d['code']} {d['rating']}" for d in ratings["drivers"][:5])
    print(f"  top rated: {top}")
    print(f"  wrote {OUT} and {SHIP}")


if __name__ == "__main__":
    main()
