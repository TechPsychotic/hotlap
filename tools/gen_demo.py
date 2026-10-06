#!/usr/bin/env python3
"""Generate a rich synthetic F1 session fixture for Pitwall demos.

Writes feed-shaped RawMessage JSONL (same shapes the live feed sends) so it
flows through the real parser. Multi-driver, 2 laps on a curvy closed circuit,
with positions, car telemetry, evolving timing + sectors/segments, stints,
weather, and race control.
"""
import json, math, os, sys

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "fixtures/demo"
LAP_MS = 32000          # ~32s per lap
LAPS = 2
DT = 200                # 5 Hz sampling
TOTAL = LAP_MS * LAPS
N_SECTORS = 3
SEGMENTS_PER_SECTOR = 8

DRIVERS = [
    # num, tla, first, last, team, colour, pace (lap time multiplier)
    ("1",  "VER", "Max",      "Verstappen", "Red Bull Racing", "3671C6", 1.000),
    ("16", "LEC", "Charles",  "Leclerc",    "Ferrari",         "E80020", 1.004),
    ("4",  "NOR", "Lando",    "Norris",     "McLaren",         "FF8000", 1.006),
    ("44", "HAM", "Lewis",    "Hamilton",   "Mercedes",        "27F4D2", 1.010),
    ("63", "RUS", "George",   "Russell",    "Mercedes",        "27F4D2", 1.013),
    ("81", "PIA", "Oscar",    "Piastri",    "McLaren",         "FF8000", 1.016),
]
COMPOUNDS = ["SOFT", "MEDIUM", "HARD", "MEDIUM", "SOFT", "MEDIUM"]

def circuit(p):
    """Closed curve in feed-like coordinates (~ +-9000). p in [0,1)."""
    t = 2 * math.pi * p
    x = 7000 * math.cos(t) + 2200 * math.cos(3 * t) + 1200 * math.sin(2 * t)
    y = 6200 * math.sin(t) - 2600 * math.sin(2 * t) + 900 * math.cos(3 * t)
    return x, y

def speed_kmh(p):
    """Plausible speed profile around the lap (slow in 'corners')."""
    base = 215 + 95 * (0.5 + 0.5 * math.sin(2 * math.pi * (3 * p)))
    corner = 80 * max(0.0, math.sin(2 * math.pi * (2 * p + 0.15)))
    return max(70.0, base - corner)

def gear_for(speed):
    for g, lim in enumerate([60, 110, 150, 195, 240, 290, 340], start=1):
        if speed <= lim:
            return g
    return 8

def lap_time_str(ms):
    m = int(ms // 60000); s = (ms % 60000) / 1000.0
    return f"{m}:{s:06.3f}" if m else f"{s:.3f}"

msgs = []
def add(topic, offset, payload):
    msgs.append({"topic": topic, "offset_ms": int(offset), "payload": payload})

# --- setup (offset 0) ---
add("SessionInfo", 0, {
    "Meeting": {"Name": "Spa-Francorchamps Grand Prix",
                "OfficialName": "Pitwall Demo Grand Prix",
                "Country": {"Name": "Belgium"},
                "Circuit": {"ShortName": "Spa"}},
    "Name": "Race", "Type": "Race", "StartDate": "2026-08-30T14:00:00",
    "GmtOffset": "02:00:00", "Year": 2026})

add("DriverList", 0, {num: {
    "RacingNumber": num, "BroadcastName": f"{first[0]} {last.upper()}",
    "Tla": tla, "FirstName": first, "LastName": last,
    "FullName": f"{first} {last}", "TeamName": team, "TeamColour": col,
    "Line": i + 1,
} for i, (num, tla, first, last, team, col, _pace) in enumerate(DRIVERS)})

add("TimingAppData", 0, {"Lines": {num: {
    "Stints": {"0": {"Compound": COMPOUNDS[i], "New": "true", "StartLaps": 0, "TotalLaps": 0}}
} for i, (num, *_rest) in enumerate(DRIVERS)}})

add("TrackStatus", 0, {"Status": "1", "Message": "AllClear"})
add("LapCount", 0, {"CurrentLap": 1, "TotalLaps": 44})
add("ExtrapolatedClock", 0, {"Utc": "2026-08-30T14:00:00Z", "Remaining": "1:28:00", "Extrapolating": True})
add("RaceControlMessages", 500, {"Messages": {"1": {
    "Utc": "2026-08-30T14:00:00Z", "Lap": 1, "Category": "Flag",
    "Flag": "GREEN", "Scope": "Track", "Message": "GREEN LIGHT - PIT EXIT OPEN"}}})

# initial grid spacing: leader ahead, ~0.9s gaps scaled by pace
progress0 = {num: -i * (900.0 / LAP_MS) for i, (num, *_r) in enumerate(DRIVERS)}
best_lap = {num: None for num, *_ in DRIVERS}
last_lap_done = {num: 0 for num, *_ in DRIVERS}

t = 0
while t <= TOTAL:
    # weather drifts
    if t % 2000 == 0:
        add("WeatherData", t, {
            "AirTemp": f"{24 + math.sin(t/20000):.1f}",
            "TrackTemp": f"{41 + 2*math.sin(t/15000):.1f}",
            "Humidity": f"{52 - 3*math.sin(t/18000):.1f}",
            "Pressure": "1011.3",
            "WindSpeed": f"{1.4 + 0.5*math.sin(t/9000):.1f}",
            "WindDirection": str(int(200 + 30*math.sin(t/12000))),
            "Rainfall": "0"})

    cars, entries, lines = {}, {}, {}
    order = []
    for i, (num, tla, *_r, pace) in enumerate(DRIVERS):
        prog = progress0[num] + (t / (LAP_MS * pace))
        lap_prog = prog % 1.0
        laps_done = int(prog) if prog > 0 else 0
        order.append((prog, num))

        x, y = circuit(lap_prog)
        entries[num] = {"Status": "OnTrack", "X": round(x, 1), "Y": round(y, 1), "Z": 0}

        sp = speed_kmh(lap_prog) * (2.0 - pace)  # faster cars slightly quicker
        g = gear_for(sp)
        # throttle high on straights, brake into slow bits
        thr = max(0, min(100, int(40 + 60 * math.sin(2*math.pi*(3*lap_prog)) + 40)))
        brk = 100 if sp < 120 and math.sin(2*math.pi*(2*lap_prog)) > 0.6 else 0
        drs = 12 if 0.60 < lap_prog < 0.74 else 0
        cars[num] = {"Channels": {"0": int(9000 + sp*28), "2": int(sp), "3": g,
                                   "4": thr, "5": brk, "45": drs}}

        # sectors + segments by lap progress
        sectors = {}
        cur_seg_global = int(lap_prog * N_SECTORS * SEGMENTS_PER_SECTOR)
        for s in range(N_SECTORS):
            seg_map = {}
            for seg in range(SEGMENTS_PER_SECTOR):
                gi = s * SEGMENTS_PER_SECTOR + seg
                if gi < cur_seg_global:
                    seg_map[str(seg)] = {"Status": 2049}   # green (done)
                elif gi == cur_seg_global:
                    seg_map[str(seg)] = {"Status": 2051}   # purple (current)
            sd = {"Segments": seg_map}
            # completed sector time
            if lap_prog > (s + 1) / N_SECTORS:
                st = (LAP_MS * pace / N_SECTORS) / 1000.0 + (0.2 * s)
                sd["Value"] = f"{st:.3f}"
                sd["PersonalFastest"] = "true" if laps_done >= 1 else "false"
            sectors[str(s)] = sd

        line = {"Position": str(i+1), "Sectors": sectors,
                "NumberOfLaps": laps_done, "InPit": "false",
                "NumberOfPitStops": 0}
        # last lap time when crossing the line
        if laps_done > last_lap_done[num]:
            last_lap_done[num] = laps_done
            lt = LAP_MS * pace
            val = lap_time_str(lt)
            is_best = best_lap[num] is None or lt < best_lap[num]
            if is_best:
                best_lap[num] = lt
            line["LastLapTime"] = {"Value": val, "PersonalFastest": "true" if is_best else "false"}
            line["BestLapTime"] = {"Value": lap_time_str(best_lap[num])}
        lines[num] = line

    # recompute order/positions + gaps to leader
    order.sort(reverse=True)
    leader_prog = order[0][0]
    prev_prog = None
    for pos, (prog, num) in enumerate(order, start=1):
        lines[num]["Position"] = str(pos)
        gap = (leader_prog - prog) * LAP_MS / 1000.0
        intv = 0.0 if prev_prog is None else (prev_prog - prog) * LAP_MS / 1000.0
        lines[num]["GapToLeader"] = "" if pos == 1 else f"+{gap:.3f}"
        lines[num]["IntervalToPositionAhead"] = {"Value": "" if pos == 1 else f"+{intv:.3f}"}
        prev_prog = prog

    add("Position", t, {"Position": [{"Utc": f"t+{t}", "Entries": entries}]})
    add("CarData", t, {"Entries": [{"Utc": f"t+{t}", "Cars": cars}]})
    if t % 1000 == 0:
        add("TimingData", t, {"Lines": lines})
    t += DT

# a mid-race yellow flag for flavour
add("RaceControlMessages", LAP_MS + 4000, {"Messages": {"1": {
    "Utc": "2026-08-30T14:00:35Z", "Lap": 2, "Category": "Flag",
    "Flag": "YELLOW", "Scope": "Sector", "Sector": 7,
    "Message": "YELLOW IN TRACK SECTOR 7"}}})
add("RaceControlMessages", LAP_MS + 9000, {"Messages": {"1": {
    "Utc": "2026-08-30T14:00:40Z", "Lap": 2, "Category": "Flag",
    "Flag": "CLEAR", "Scope": "Sector", "Sector": 7,
    "Message": "CLEAR IN TRACK SECTOR 7"}}})

msgs.sort(key=lambda m: m["offset_ms"])
os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "session.jsonl"), "w") as f:
    for m in msgs:
        f.write(json.dumps(m, separators=(",", ":")) + "\n")
with open(os.path.join(OUT_DIR, "meta.json"), "w") as f:
    json.dump({"name": "Pitwall Demo Grand Prix", "year": 2026,
               "sessionType": "Race", "drivers": [d[1] for d in DRIVERS],
               "durationMs": TOTAL, "synthetic": True,
               "note": "Generated by tools/gen_demo.py for demos."}, f, indent=2)
print(f"wrote {len(msgs)} messages to {OUT_DIR} ({TOTAL/1000:.0f}s, {len(DRIVERS)} drivers)")
