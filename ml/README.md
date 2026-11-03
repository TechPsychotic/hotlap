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

## Predictive models (built now)

`build_models.py` trains two small, interpretable models and ships them as JSON,
read by `web/src/ml.ts` and shown in the **Prediction** and **Strategy** panels:

- **`winner_model.json`** — empirical P(win|grid), P(podium|grid), P(points|grid)
  conversion curves from 2014–2024 results, plus a trained 3-parameter logistic
  for how much a driver's (car-independent) rating shifts win odds on top of grid
  position. In-app the curves are fed by the *current* running order, blended
  with the grid early on and sharpened as the race progresses, then normalised
  across the field (wins→1, podiums→3). → race-winner / podium probabilities.
- **`strategy_model.json`** — per-compound **tyre-degradation** curves
  (`a1·age + a2·age²`, clamped past the trusted age range so long stints don't
  extrapolate to absurd values), fresh-compound **pace offsets**, and per-circuit
  **pit loss**, fit from OpenF1 lap/stint/pit data (2023+). Lap times are
  fuel-corrected (+`--fuel` s per lap of race) before fitting, otherwise the
  weight a car sheds through a stint masks — even inverts — degradation. In-app a
  one-stop-from-here simulation over these curves gives each driver a pit window
  and tyre-loss readout. → pit-window / undercut / stint pace.

```bash
python3 ml/build_models.py --from 2014 --to 2024 --of1 2023,2024 --races 8
```

### Why JSON coefficients, not ONNX/`tract`

The roadmap floated exporting to ONNX and running it in Rust via `tract`. These
models turned out linear / empirical-curve shaped, so a tensor runtime would add
a heavy dependency without adding accuracy. Shipping plain coefficients keeps the
"offline-train, ship artifacts, no runtime Python" principle intact **and** keeps
the frontend-only (GitHub Pages) build viable — inference is a dot product and a
tiny simulation in TypeScript. If a model later needs nonlinear capacity, ONNX
can be swapped back in behind the same `web/src/ml.ts` interface.

*Caveats:* fresh-compound pace offsets are a documented prior, not fit (stint
timing confounds a cross-compound comparison); the in-race progress-sharpening is
chosen, not fit (mid-race ground truth needs lap-by-lap history for every race);
the pit-window call is pace-only, so it doesn't price in the track position lost
in a stop — hence a net-gain margin before it ever says "box".

## Layout

```
ml/
  build_artifacts.py   # driver ratings + track rankings → JSON
  build_models.py      # winner + strategy predictive models → JSON
  data/                # cached raw API responses (gitignored)
  out/                 # built artifacts (source of truth)
  README.md
```
