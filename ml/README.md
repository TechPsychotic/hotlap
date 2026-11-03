# Hotlap ML

Offline-trained artifacts and models. Nothing here runs at request time — the
pipeline produces **static data** (and, later, **ONNX models**) that the Rust/web
app ships and reads directly. This keeps the app local-first with no Python
runtime dependency.

## Artifacts (built now)

`build_artifacts.py` computes two data artifacts from the public Ergast/Jolpica
API (seasons 2019–2024 by default) and writes them to `out/` and the shipped
copy `web/public/ml/` (served at `/ml/*.json`, shown by the **Ratings** panel):

- **`driver_ratings.json`** — a 0–100 rating per driver plus sub-scores. The core
  signal is **team-mate head-to-head** (same car, so car-independent), for both
  qualifying and race, regularised for small samples and weighted toward recent
  seasons, combined with a finishing-consistency term.
- **`track_rankings.json`** — per circuit: an **overtaking** score (from
  grid→finish position volatility of classified finishers) and an **incidents**
  score (retirement rate), normalised 0–100 over circuits with a stable sample
  (≥3 races). *Caveat:* overtaking is a proxy for position change, not a count of
  on-track passes, so chaotic races can inflate it — a lap-by-lap pass counter is
  a future upgrade.

### Build

```bash
python3 ml/build_artifacts.py --from 2019 --to 2024
```

Stdlib only (no pip). Raw API responses are cached in `ml/data/`, so re-runs are
fast. After building, rebuild the web (`cd web && npm run build`) to ship the
refreshed artifacts.

## Next (planned)

Predictive models trained on these features + OpenF1/Ergast history, exported to
ONNX and run in-app via Rust `tract`: **pit-window**, **over/undercut strategy**,
and **race-winner** prediction. See `docs/TODO.md`.

## Layout

```
ml/
  build_artifacts.py   # driver ratings + track rankings → JSON
  data/                # cached raw API responses (gitignored)
  out/                 # built artifacts (source of truth)
  README.md
```
