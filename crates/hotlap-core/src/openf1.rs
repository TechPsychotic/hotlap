//! OpenF1 fallback source.
//!
//! When the F1 live-timing archive is geo-gated (4xx), this reconstructs a rich
//! replay from the public **OpenF1** API (`api.openf1.org`, 2023+): driver list,
//! per-lap timing with sectors, running order, gaps/intervals, tyre stints, pit
//! stops, weather and race control — plus, unlike the Ergast fallback, **car
//! telemetry and track positions** (downsampled). It is a manual fallback, never
//! the default source.
//!
//! Telemetry/position streams are large (~3.7 Hz × 20 cars), so car_data and
//! location are fetched per driver in parallel and downsampled to [`SAMPLE_MS`]
//! before being folded into the timeline. The compiled timeline is cached by the
//! caller, so the one-time fetch cost is paid once per session.

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::DateTime;
use futures::stream::StreamExt;
use hotlap_schema::state::{
    CurrentTyre, Driver, LapCount, LapTime, RaceControlMessage, Sector, Stint, WeatherData,
};
use hotlap_schema::SessionState;
use serde_json::Value;

use crate::fallback::FallbackSession;
use crate::timeline::{Timeline, TimelineFrame};
use crate::{merge, Error, Result};

const OPENF1: &str = "https://api.openf1.org/v1";
/// Downsample telemetry/position to roughly one sample per driver per this many
/// ms — plenty for traces and a smooth map, a fraction of the native rate.
const SAMPLE_MS: i64 = 1000;
/// Frame-batching grid: events within the same bucket share one timeline frame.
const BUCKET_MS: i64 = 250;
/// How many drivers' heavy streams to fetch at once (be gentle on the API).
const FETCH_CONCURRENCY: usize = 5;

fn norm(s: &str) -> String {
    s.to_lowercase()
        .replace("grand prix", "")
        .trim()
        .to_string()
}

fn team_hex(name: &str) -> Option<String> {
    // OpenF1 gives team_colour already as a hex string; this only fills gaps.
    let c = match name.to_lowercase().as_str() {
        s if s.contains("red bull") => "3671C6",
        s if s.contains("ferrari") => "E8002D",
        s if s.contains("mercedes") => "27F4D2",
        s if s.contains("mclaren") => "FF8000",
        s if s.contains("aston") => "229971",
        s if s.contains("alpine") => "0093CC",
        s if s.contains("williams") => "64C4FF",
        s if s.contains("rb") || s.contains("alphatauri") || s.contains("racing bulls") => "6692FF",
        s if s.contains("sauber") || s.contains("alfa") => "52E252",
        s if s.contains("haas") => "B6BABD",
        _ => return None,
    };
    Some(c.to_string())
}

/// Parse an RFC3339 timestamp to epoch milliseconds.
fn date_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Format seconds as `M:SS.mmm`.
fn fmt_lap(sec: f64) -> String {
    let total = sec.max(0.0);
    let m = (total / 60.0).floor() as u64;
    let s = total - (m as f64) * 60.0;
    format!("{m}:{s:06.3}")
}
/// Format seconds as `SS.mmm` (a sector).
fn fmt_sec(sec: f64) -> String {
    format!("{:.3}", sec.max(0.0))
}
async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let mut delay = Duration::from_millis(500);
    for attempt in 0..4 {
        match client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
        {
            Ok(resp) => return Ok(serde_json::from_str(&resp.text().await?)?),
            Err(e) => {
                let retryable = e.is_timeout()
                    || e.is_connect()
                    || matches!(e.status().map(|s| s.as_u16()), Some(429) | Some(500..=599));
                if retryable && attempt < 3 {
                    tokio::time::sleep(delay).await;
                    delay *= 2;
                    continue;
                }
                return Err(e.into());
            }
        }
    }
    unreachable!()
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(str::to_string)
}
fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
fn u(v: &Value, k: &str) -> Option<u32> {
    v.get(k).and_then(|x| x.as_u64()).map(|n| n as u32)
}

/// A time-stamped change to fold into the session state.
enum Ev {
    Lap {
        num: String,
        lap: u32,
        last: Option<f64>,
        secs: [Option<f64>; 3],
    },
    Pos {
        num: String,
        pos: u32,
    },
    Intv {
        num: String,
        gap: Option<String>,
        intv: Option<String>,
    },
    Stints {
        num: String,
        stints: Vec<Stint>,
        cur: Option<CurrentTyre>,
    },
    Pit {
        num: String,
        count: u32,
    },
    Weather(WeatherData),
    Rc(RaceControlMessage),
    Loc {
        num: String,
        x: f64,
        y: f64,
        z: f64,
    },
    Car {
        num: String,
        speed: Option<i32>,
        throttle: Option<i32>,
        brake: Option<i32>,
        rpm: Option<i32>,
        gear: Option<i32>,
        drs: Option<i32>,
    },
}

/// Build a rich replay timeline for `event` in `year` from OpenF1.
pub async fn fetch(year: i32, event: &str) -> Result<FallbackSession> {
    let client = reqwest::Client::builder()
        .user_agent("hotlap/0.1")
        .timeout(Duration::from_secs(60))
        .build()?;

    // 1. Resolve the race session for this event.
    let sessions = get_json(
        &client,
        &format!("{OPENF1}/sessions?year={year}&session_name=Race"),
    )
    .await?;
    let want = norm(event);
    let session = arr(&sessions)
        .into_iter()
        .find(|se| {
            let hay = [
                s(se, "location").unwrap_or_default(),
                s(se, "country_name").unwrap_or_default(),
                s(se, "circuit_short_name").unwrap_or_default(),
            ]
            .join(" ")
            .to_lowercase();
            !want.is_empty()
                && want
                    .split_whitespace()
                    .any(|w| w.len() > 2 && hay.contains(w))
        })
        .ok_or_else(|| Error::NotFound(format!("no OpenF1 race matching '{event}' in {year}")))?;

    let sk = session["session_key"]
        .as_i64()
        .ok_or_else(|| Error::NotFound("no session_key".into()))?;
    let t0 = s(&session, "date_start").and_then(|d| date_ms(&d));
    let meeting = s(&session, "location").map(|l| format!("{l} Grand Prix"));
    let circuit = s(&session, "circuit_short_name");
    let country = s(&session, "country_name");

    // 2. Drivers.
    let drivers_j = get_json(&client, &format!("{OPENF1}/drivers?session_key={sk}")).await?;
    let mut drivers: BTreeMap<String, Driver> = BTreeMap::new();
    let mut nums: Vec<String> = Vec::new();
    for d in arr(&drivers_j) {
        let Some(num) = u(&d, "driver_number").map(|n| n.to_string()) else {
            continue;
        };
        if drivers.contains_key(&num) {
            continue;
        }
        let team = s(&d, "team_name").unwrap_or_default();
        drivers.insert(
            num.clone(),
            Driver {
                racing_number: num.clone(),
                tla: s(&d, "name_acronym"),
                full_name: s(&d, "full_name"),
                first_name: s(&d, "first_name"),
                last_name: s(&d, "last_name"),
                team_name: Some(team.clone()),
                team_colour: s(&d, "team_colour")
                    .filter(|c| !c.is_empty())
                    .or_else(|| team_hex(&team)),
                headshot_url: s(&d, "headshot_url"),
                country_code: s(&d, "country_code"),
                ..Default::default()
            },
        );
        nums.push(num);
    }
    if drivers.is_empty() {
        return Err(Error::NotFound("OpenF1 returned no drivers".into()));
    }

    // 3. Low-rate streams (fetched whole).
    let base = t0.unwrap_or(0);
    let off = |date: &str| -> Option<i64> { date_ms(date).map(|m| (m - base).max(0)) };
    let mut events: Vec<(i64, Ev)> = Vec::new();

    // Laps → per-lap timing + sectors (completion ≈ start + duration).
    let laps = get_json(&client, &format!("{OPENF1}/laps?session_key={sk}")).await?;
    let mut total_laps = 0u32;
    for l in arr(&laps) {
        let Some(num) = u(&l, "driver_number").map(|n| n.to_string()) else {
            continue;
        };
        let lap = u(&l, "lap_number").unwrap_or(0);
        total_laps = total_laps.max(lap);
        let dur = f(&l, "lap_duration");
        let secs = [
            f(&l, "duration_sector_1"),
            f(&l, "duration_sector_2"),
            f(&l, "duration_sector_3"),
        ];
        let when = s(&l, "date_start")
            .and_then(|d| off(&d))
            .map(|o| o + (dur.unwrap_or(0.0) * 1000.0) as i64)
            .unwrap_or((lap as i64) * 90_000);
        events.push((
            when,
            Ev::Lap {
                num,
                lap,
                last: dur,
                secs,
            },
        ));
    }

    // Running order.
    let position = get_json(&client, &format!("{OPENF1}/position?session_key={sk}")).await?;
    for p in arr(&position) {
        let (Some(num), Some(pos), Some(date)) = (
            u(&p, "driver_number").map(|n| n.to_string()),
            u(&p, "position"),
            s(&p, "date"),
        ) else {
            continue;
        };
        if let Some(o) = off(&date) {
            events.push((o, Ev::Pos { num, pos }));
        }
    }

    // Gaps / intervals.
    let intervals = get_json(&client, &format!("{OPENF1}/intervals?session_key={sk}"))
        .await
        .unwrap_or(Value::Null);
    for iv in arr(&intervals) {
        let Some(num) = u(&iv, "driver_number").map(|n| n.to_string()) else {
            continue;
        };
        let Some(date) = s(&iv, "date") else { continue };
        let gap = iv.get("gap_to_leader").and_then(fmt_gap_val);
        let intv = iv.get("interval").and_then(fmt_gap_val);
        if let Some(o) = off(&date) {
            events.push((o, Ev::Intv { num, gap, intv }));
        }
    }

    // Stints (+ current tyre), grouped per driver and emitted as they begin.
    let stints_j = get_json(&client, &format!("{OPENF1}/stints?session_key={sk}"))
        .await
        .unwrap_or(Value::Null);
    let mut per_driver_stints: BTreeMap<String, Vec<(u32, Stint)>> = BTreeMap::new();
    for st in arr(&stints_j) {
        let Some(num) = u(&st, "driver_number").map(|n| n.to_string()) else {
            continue;
        };
        let lap_start = u(&st, "lap_start").unwrap_or(1);
        let lap_end = u(&st, "lap_end").unwrap_or(lap_start);
        let compound = s(&st, "compound").map(|c| c.to_uppercase());
        let age = u(&st, "tyre_age_at_start");
        per_driver_stints.entry(num).or_default().push((
            lap_start,
            Stint {
                compound,
                new: age.map(|a| a == 0),
                laps: Some(lap_end.saturating_sub(lap_start) + 1),
                start_laps: age,
                total_laps: age.map(|a| a + lap_end.saturating_sub(lap_start) + 1),
            },
        ));
    }
    // Map each stint's start lap to an approximate time via that driver's lap.
    let lap_time: BTreeMap<(String, u32), i64> = events
        .iter()
        .filter_map(|(o, e)| match e {
            Ev::Lap { num, lap, .. } => Some(((num.clone(), *lap), *o)),
            _ => None,
        })
        .collect();
    for (num, mut list) in per_driver_stints {
        list.sort_by_key(|(l, _)| *l);
        let mut acc: Vec<Stint> = Vec::new();
        for (start_lap, st) in list {
            acc.push(st.clone());
            let cur = st.compound.clone().map(|c| CurrentTyre {
                compound: Some(c),
                new: st.new,
            });
            let when = lap_time
                .get(&(num.clone(), start_lap.saturating_sub(1)))
                .copied()
                .unwrap_or(0)
                .max(0);
            events.push((
                when,
                Ev::Stints {
                    num: num.clone(),
                    stints: acc.clone(),
                    cur,
                },
            ));
        }
    }

    // Pit stops → running count.
    let pit = get_json(&client, &format!("{OPENF1}/pit?session_key={sk}"))
        .await
        .unwrap_or(Value::Null);
    let mut pit_rows: Vec<(i64, String)> = Vec::new();
    for p in arr(&pit) {
        let (Some(num), Some(date)) =
            (u(&p, "driver_number").map(|n| n.to_string()), s(&p, "date"))
        else {
            continue;
        };
        if let Some(o) = off(&date) {
            pit_rows.push((o, num));
        }
    }
    pit_rows.sort_by_key(|(o, _)| *o);
    let mut pit_count: BTreeMap<String, u32> = BTreeMap::new();
    for (o, num) in pit_rows {
        let c = pit_count.entry(num.clone()).or_insert(0);
        *c += 1;
        events.push((o, Ev::Pit { num, count: *c }));
    }

    // Weather.
    let weather = get_json(&client, &format!("{OPENF1}/weather?session_key={sk}"))
        .await
        .unwrap_or(Value::Null);
    for w in arr(&weather) {
        let Some(date) = s(&w, "date") else { continue };
        if let Some(o) = off(&date) {
            events.push((
                o,
                Ev::Weather(WeatherData {
                    air_temp: f(&w, "air_temperature"),
                    track_temp: f(&w, "track_temperature"),
                    humidity: f(&w, "humidity"),
                    pressure: f(&w, "pressure"),
                    wind_speed: f(&w, "wind_speed"),
                    wind_direction: f(&w, "wind_direction"),
                    rainfall: f(&w, "rainfall").map(|r| r > 0.0),
                }),
            ));
        }
    }

    // Race control.
    let rc = get_json(&client, &format!("{OPENF1}/race_control?session_key={sk}"))
        .await
        .unwrap_or(Value::Null);
    for m in arr(&rc) {
        let Some(date) = s(&m, "date") else { continue };
        if let Some(o) = off(&date) {
            events.push((
                o,
                Ev::Rc(RaceControlMessage {
                    utc: Some(date),
                    lap: u(&m, "lap_number"),
                    category: s(&m, "category"),
                    message: s(&m, "message"),
                    flag: s(&m, "flag"),
                    scope: s(&m, "scope"),
                    sector: u(&m, "sector"),
                    racing_number: u(&m, "driver_number").map(|n| n.to_string()),
                }),
            ));
        }
    }

    // 4. Heavy per-driver streams (telemetry + location), downsampled. Limit the
    //    number in flight so OpenF1 doesn't rate-limit us into dropped data.
    let heavy_results: Vec<(String, Value, Value)> =
        futures::stream::iter(nums.iter().cloned().map(|num| {
            let client = client.clone();
            async move {
                let loc = get_json(
                    &client,
                    &format!("{OPENF1}/location?session_key={sk}&driver_number={num}"),
                )
                .await
                .unwrap_or(Value::Null);
                let car = get_json(
                    &client,
                    &format!("{OPENF1}/car_data?session_key={sk}&driver_number={num}"),
                )
                .await
                .unwrap_or(Value::Null);
                (num, loc, car)
            }
        }))
        .buffer_unordered(FETCH_CONCURRENCY)
        .collect()
        .await;
    for (num, loc, car) in heavy_results {
        let mut last_bucket = i64::MIN;
        for p in arr(&loc) {
            let (Some(date), Some(x), Some(y)) = (s(&p, "date"), f(&p, "x"), f(&p, "y")) else {
                continue;
            };
            if x == 0.0 && y == 0.0 {
                continue;
            }
            let Some(o) = off(&date) else { continue };
            let bucket = o / SAMPLE_MS;
            if bucket == last_bucket {
                continue;
            }
            last_bucket = bucket;
            events.push((
                o,
                Ev::Loc {
                    num: num.clone(),
                    x,
                    y,
                    z: f(&p, "z").unwrap_or(0.0),
                },
            ));
        }
        let mut last_bucket = i64::MIN;
        for c in arr(&car) {
            let Some(date) = s(&c, "date") else { continue };
            let Some(o) = off(&date) else { continue };
            let bucket = o / SAMPLE_MS;
            if bucket == last_bucket {
                continue;
            }
            last_bucket = bucket;
            events.push((
                o,
                Ev::Car {
                    num: num.clone(),
                    speed: u(&c, "speed").map(|v| v as i32),
                    throttle: u(&c, "throttle").map(|v| v as i32),
                    brake: u(&c, "brake").map(|v| v as i32),
                    rpm: u(&c, "rpm").map(|v| v as i32),
                    gear: u(&c, "n_gear").map(|v| v as i32),
                    drs: u(&c, "drs").map(|v| v as i32),
                },
            ));
        }
    }

    if events.is_empty() {
        return Err(Error::NotFound("OpenF1 returned no session data".into()));
    }

    // 5. Fold the time-ordered events into SessionState, emitting one frame per
    //    bucket in which something changed.
    events.sort_by_key(|(o, _)| *o);
    let mut state = SessionState::default();
    state.session.meeting_name = meeting.clone();
    state.session.session_name = Some("Race".into());
    state.session.session_type = Some("Race".into());
    state.session.circuit = circuit;
    state.session.country = country;
    state.drivers = drivers;
    state.track_status.status = Some("1".into());

    let mut best_ms: BTreeMap<String, f64> = BTreeMap::new();
    let mut prev = Value::Object(Default::default());
    let mut frames = Vec::new();
    let json0 = serde_json::to_value(&state)?;
    frames.push(TimelineFrame {
        t: 0,
        patch: merge::diff(&prev, &json0),
    });
    prev = json0;

    let mut i = 0;
    while i < events.len() {
        let bucket = events[i].0 / BUCKET_MS;
        let start = i;
        while i < events.len() && events[i].0 / BUCKET_MS == bucket {
            i += 1;
        }
        let mut cur_lap = state
            .lap_count
            .clone()
            .and_then(|l| l.current_lap)
            .unwrap_or(0);
        for (_, ev) in &events[start..i] {
            apply(&mut state, ev, &mut best_ms, &mut cur_lap);
        }
        state.lap_count = Some(LapCount {
            current_lap: Some(cur_lap),
            total_laps: Some(total_laps),
        });
        let json = serde_json::to_value(&state)?;
        let patch = merge::diff(&prev, &json);
        if !patch.is_null() {
            frames.push(TimelineFrame {
                t: (bucket * BUCKET_MS).max(0) as u64,
                patch,
            });
            prev = json;
        }
    }

    let duration_ms = frames.last().map(|f| f.t).unwrap_or(0);
    Ok(FallbackSession {
        name: format!(
            "{} — Race · OpenF1",
            meeting.unwrap_or_else(|| event.to_string())
        ),
        timeline: Timeline {
            duration_ms,
            frames,
        },
    })
}

/// A gap value may arrive as a number (seconds) or a `"+1 LAP"` string.
fn fmt_gap_val(v: &Value) -> Option<String> {
    if let Some(n) = v.as_f64() {
        return Some(format!("+{n:.3}"));
    }
    v.as_str().map(|s| {
        let low = s.to_lowercase();
        if low.contains("lap") {
            let n: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
            format!("+{}L", if n.is_empty() { "1".into() } else { n })
        } else {
            s.to_string()
        }
    })
}

fn apply(
    state: &mut SessionState,
    ev: &Ev,
    best_ms: &mut BTreeMap<String, f64>,
    cur_lap: &mut u32,
) {
    match ev {
        Ev::Lap {
            num,
            lap,
            last,
            secs,
        } => {
            let t = state.timing.entry(num.clone()).or_default();
            t.number_of_laps = Some(*lap);
            *cur_lap = (*cur_lap).max(*lap);
            if let Some(ms) = last.map(|s| s * 1000.0) {
                t.last_lap_time = Some(LapTime {
                    value: Some(fmt_lap(*last.as_ref().unwrap())),
                    ..Default::default()
                });
                let b = best_ms.entry(num.clone()).or_insert(f64::MAX);
                if ms < *b {
                    *b = ms;
                    t.best_lap_time = Some(LapTime {
                        value: Some(fmt_lap(ms / 1000.0)),
                        ..Default::default()
                    });
                }
            }
            let mut sectors = Vec::new();
            for sv in secs {
                sectors.push(Sector {
                    value: sv.map(fmt_sec),
                    ..Default::default()
                });
            }
            t.sectors = sectors;
        }
        Ev::Pos { num, pos } => {
            state.timing.entry(num.clone()).or_default().position = Some(*pos);
        }
        Ev::Intv { num, gap, intv } => {
            let t = state.timing.entry(num.clone()).or_default();
            if gap.is_some() {
                t.gap_to_leader = gap.clone();
            }
            if intv.is_some() {
                t.interval_to_ahead = intv.clone();
            }
        }
        Ev::Stints { num, stints, cur } => {
            state.stints.insert(num.clone(), stints.clone());
            if let Some(c) = cur {
                state.current_tyres.insert(num.clone(), c.clone());
            }
        }
        Ev::Pit { num, count } => {
            state
                .timing
                .entry(num.clone())
                .or_default()
                .number_of_pit_stops = Some(*count);
        }
        Ev::Weather(w) => state.weather = w.clone(),
        Ev::Rc(m) => {
            if !state.race_control.contains(m) {
                state.race_control.push(m.clone());
            }
        }
        Ev::Loc { num, x, y, z } => {
            let p = state.position.entry(num.clone()).or_default();
            p.x = Some(*x);
            p.y = Some(*y);
            p.z = Some(*z);
        }
        Ev::Car {
            num,
            speed,
            throttle,
            brake,
            rpm,
            gear,
            drs,
        } => {
            let c = state.car.entry(num.clone()).or_default();
            c.speed = *speed;
            c.throttle = *throttle;
            c.brake = *brake;
            c.rpm = *rpm;
            c.gear = *gear;
            c.drs = *drs;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live network test (OpenF1). Run explicitly:
    /// `cargo test -p hotlap-core openf1 -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn fetches_sao_paulo_2023() {
        let fb = fetch(2023, "São Paulo").await.expect("openf1 fetch");
        let tl = &fb.timeline;
        println!("name={}", fb.name);
        println!("frames={} duration_ms={}", tl.frames.len(), tl.duration_ms);
        assert!(tl.frames.len() > 100, "expected many frames");
        assert!(tl.duration_ms > 60 * 60 * 1000, "a race is >1h");
        // Fold the whole timeline and confirm it carries the rich data.
        let mut state = Value::Object(Default::default());
        for fr in &tl.frames {
            merge::apply(&mut state, &fr.patch);
        }
        let drivers = state["drivers"].as_object().map(|o| o.len()).unwrap_or(0);
        let car = state["car"].as_object().map(|o| o.len()).unwrap_or(0);
        let pos = state["position"].as_object().map(|o| o.len()).unwrap_or(0);
        let rc = state["raceControl"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0);
        println!("drivers={drivers} car={car} position={pos} raceControl={rc}");
        assert!(drivers >= 15, "driver list");
        assert!(car >= 15, "car telemetry present");
        assert!(pos >= 15, "track positions present");
    }
}
