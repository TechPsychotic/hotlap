# Fixtures

Sample recordings used for offline development and tests — so every part of
Pitwall is runnable without waiting for a live F1 session.

## Recording format

A recording is a **directory** containing:

- `session.jsonl` — one [`RawMessage`](../crates/pitwall-schema/src/raw.rs) per line
  (`topic`, `payload`, optional `utc`, and `offset_ms` from session start). This is
  the stream the replay adapter feeds through the normal parser.
- `meta.json` *(optional)* — human-friendly session metadata (name, year, length).

`*.z` topics (`CarData.z`, `Position.z`) store their payload as the raw base64
string exactly as received from the feed; the parser inflates them.

## `sample/`

A tiny hand-authored synthetic session (two drivers, a few seconds) good enough to
smoke-test the pipeline end to end. Replaced by a captured real session once live
ingest (P4) lands.
