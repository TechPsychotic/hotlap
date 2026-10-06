#!/usr/bin/env python3
"""Export a real F1 session into Pitwall's replay format.

Downloads the archived Live Timing `.jsonStream` files that F1 publishes for
past public sessions (the same source FastF1 uses) directly from
`livetiming.formula1.com/static/...`, and converts them to Pitwall's
`session.jsonl` (one RawMessage per line). No FastF1 install and no F1 TV
login needed for past public sessions.

Usage:
  tools/export_session.py <year> <gp-substring> <session> <out-dir> \
      [--max-seconds N] [--car-stride K] [--pos-stride K]

Examples:
  tools/export_session.py 2023 Monaco Qualifying fixtures/monaco-2023-quali \
      --max-seconds 1500 --car-stride 3 --pos-stride 3
"""
import argparse
import json
import os
import re
import sys
import urllib.request

BASE = "https://livetiming.formula1.com/static/"
TIME_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})\.(\d{3})")

# Topic file -> whether it's a single JSON doc (.json) rather than a stream.
STREAM_TOPICS = [
    "DriverList",
    "SessionData",
    "TrackStatus",
    "LapCount",
    "ExtrapolatedClock",
    "WeatherData",
    "RaceControlMessages",
    "TeamRadio",
    "TimingData",
    "TimingAppData",
    "CarData.z",
    "Position.z",
]


def fetch(url, cache_dir):
    """Fetch a URL, caching the raw bytes on disk so re-runs are offline."""
    os.makedirs(cache_dir, exist_ok=True)
    safe = url.split("static/", 1)[1].replace("/", "_")
    path = os.path.join(cache_dir, safe)
    if os.path.isfile(path):
        with open(path, "rb") as f:
            return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": "pitwall-export"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001
        print(f"  ! {url} -> {e}", file=sys.stderr)
        return None
    with open(path, "wb") as f:
        f.write(data)
    return data


def decode(data):
    return data.decode("utf-8-sig", errors="replace") if data else ""


def find_session_path(year, gp_sub, session_sub, cache_dir):
    idx = fetch(f"{BASE}{year}/Index.json", cache_dir)
    index = json.loads(decode(idx))
    gp_sub, session_sub = gp_sub.lower(), session_sub.lower()
    for meeting in index.get("Meetings", []):
        name = meeting.get("Name", "")
        if gp_sub not in name.lower():
            continue
        for s in meeting.get("Sessions", []):
            if session_sub in s.get("Name", "").lower() or session_sub in s.get("Type", "").lower():
                return meeting, s, s["Path"]
    raise SystemExit(f"No session matching gp='{gp_sub}' session='{session_sub}' in {year}")


def parse_stream(text):
    """Yield (offset_ms, payload) for each line of a .jsonStream file."""
    for line in text.splitlines():
        if not line.strip():
            continue
        m = TIME_RE.match(line)
        if m:
            h, mi, s, ms = (int(x) for x in m.groups())
            offset = ((h * 60 + mi) * 60 + s) * 1000 + ms
            rest = line[12:]
        else:
            # Fallback: split at the first JSON token.
            idxs = [line.find(c) for c in '{["' if line.find(c) != -1]
            if not idxs:
                continue
            offset, rest = 0, line[min(idxs):]
        try:
            yield offset, json.loads(rest)
        except json.JSONDecodeError:
            continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("year", type=int)
    ap.add_argument("gp")
    ap.add_argument("session")
    ap.add_argument("out")
    ap.add_argument("--start-seconds", type=int, default=0,
                    help="window start in the original timeline; earlier context collapses to t=0")
    ap.add_argument("--max-seconds", type=int, default=0, help="window end in the original timeline (0 = full)")
    ap.add_argument("--car-stride", type=int, default=1, help="keep every Kth CarData frame")
    ap.add_argument("--pos-stride", type=int, default=1, help="keep every Kth Position frame")
    ap.add_argument("--cache", default=None, help="raw-download cache dir")
    args = ap.parse_args()

    cache_dir = args.cache or os.path.join(args.out, "_cache")
    meeting, session, path = find_session_path(args.year, args.gp, args.session, cache_dir)
    base = f"{BASE}{path}"
    print(f"Session: {meeting['Name']} — {session['Name']} ({path})")

    msgs = []
    start_ms = args.start_seconds * 1000
    end_ms = args.max_seconds * 1000 if args.max_seconds else None
    HEAVY = ("CarData.z", "Position.z")

    # SessionInfo is a single JSON document.
    info = fetch(f"{base}SessionInfo.json", cache_dir)
    if info:
        msgs.append({"topic": "SessionInfo", "offset_ms": 0, "payload": json.loads(decode(info))})

    for topic in STREAM_TOPICS:
        data = fetch(f"{base}{topic}.jsonStream", cache_dir)
        if not data:
            continue
        stride = args.car_stride if topic == "CarData.z" else args.pos_stride if topic == "Position.z" else 1
        kept = 0
        for i, (offset, payload) in enumerate(parse_stream(decode(data))):
            if end_ms is not None and offset > end_ms:
                break
            if offset < start_ms:
                # Pre-window context collapses to t=0 so the window starts with
                # full state; heavy telemetry history is simply dropped.
                if topic in HEAVY:
                    continue
                new_off = 0
            else:
                new_off = offset - start_ms
            if stride > 1 and topic in HEAVY and (i % stride):
                continue
            msgs.append({"topic": topic, "offset_ms": new_off, "payload": payload})
            kept += 1
        print(f"  {topic}: {kept} messages")

    msgs.sort(key=lambda m: m["offset_ms"])
    duration = msgs[-1]["offset_ms"] if msgs else 0
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "session.jsonl"), "w") as f:
        for m in msgs:
            f.write(json.dumps(m, separators=(",", ":")) + "\n")
    with open(os.path.join(args.out, "meta.json"), "w") as f:
        json.dump({"name": f"{meeting['Name']} — {session['Name']}", "year": args.year,
                   "sessionType": session.get("Type"), "path": path,
                   "durationMs": duration, "synthetic": False,
                   "source": "livetiming.formula1.com (archived)"}, f, indent=2)
    print(f"Wrote {len(msgs)} messages ({duration/1000:.0f}s) to {args.out}")


if __name__ == "__main__":
    main()
