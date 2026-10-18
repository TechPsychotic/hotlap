//! Ergast/Jolpica fallback source.
//!
//! When the F1 live-timing archive is unavailable (e.g. it rate-limits us with
//! 401s), this reconstructs a *basic* race replay — driver list, per-lap
//! positions, lap times and gaps — from the public Ergast-style API (a
//! different host that stays reachable). It deliberately provides only what
//! that API exposes: **no** car telemetry, track position, sectors, weather,
//! race control or radio — those live only in the live-timing archive. It is
//! used strictly as a fallback, never as the default source.

use std::collections::BTreeMap;
use std::time::Duration;

use hotlap_schema::state::{Driver, LapCount, LapTime};
use hotlap_schema::SessionState;
use serde_json::Value;

use crate::timeline::{Timeline, TimelineFrame};
use crate::{merge, Error, Result};

const ERGAST: &str = "https://api.jolpi.ca/ergast/f1";
const PAGE: usize = 100; // Jolpica caps a page at 100 rows.

/// A fallback-built session: a name and a foldable timeline (same shape the web
/// client already plays for live-timing sessions).
pub struct FallbackSession {
    pub name: String,
    pub timeline: Timeline,
}

/// Approximate team colours (hex, no `#`) by Ergast constructor id.
fn team_colour(cid: &str) -> Option<String> {
    let c = match cid {
        "red_bull" => "3671C6",
        "ferrari" => "E8002D",
        "mercedes" => "27F4D2",
        "mclaren" => "FF8000",
        "aston_martin" => "229971",
        "alpine" => "0093CC",
        "williams" => "64C4FF",
        "rb" | "alphatauri" | "racing_bulls" => "6692FF",
        "sauber" | "kick_sauber" | "alfa" | "alfa_romeo" => "52E252",
        "haas" => "B6BABD",
        "audi" => "009597",
        "cadillac" => "C8A04F",
        _ => return None,
    };
    Some(c.to_string())
}

fn norm(s: &str) -> String {
    s.to_lowercase()
        .replace("grand prix", "")
        .split(" in ")
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Parse `M:SS.mmm` (or `SS.mmm`) to milliseconds.
fn lap_ms(s: &str) -> Option<f64> {
    let (m, rest) = match s.split_once(':') {
        Some((m, r)) => (m.parse::<f64>().ok()?, r),
        None => (0.0, s),
    };
    let sec = rest.parse::<f64>().ok()?;
    Some(m * 60_000.0 + sec * 1000.0)
}

fn fmt_gap(ms: f64) -> String {
    format!("+{:.3}", ms / 1000.0)
}

/// GET + parse JSON, retrying with backoff on rate limits (429) and transient
/// errors — the public API throttles bursts, and the fallback pages a lot.
async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let mut delay = Duration::from_millis(600);
    for attempt in 0..4 {
        match client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
        {
            Ok(resp) => {
                let txt = resp.text().await?;
                return Ok(serde_json::from_str(&txt)?);
            }
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

/// Build a basic race timeline for `event` in `year` from Ergast/Jolpica.
pub async fn fetch(year: i32, event: &str) -> Result<FallbackSession> {
    let client = reqwest::Client::builder()
        .user_agent("hotlap/0.1 (+https://localhost)")
        .build()?;

    // 1. Find the round (and circuit/country) for this event.
    let season = get_json(&client, &format!("{ERGAST}/{year}.json")).await?;
    let races = season["MRData"]["RaceTable"]["Races"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let want = norm(event);
    let race = races
        .iter()
        .find(|r| {
            let n = norm(r["raceName"].as_str().unwrap_or(""));
            !n.is_empty() && !want.is_empty() && (n.contains(&want) || want.contains(&n))
        })
        .ok_or_else(|| Error::NotFound(format!("no Ergast race matching '{event}' in {year}")))?;
    let round = race["round"].as_str().unwrap_or_default().to_string();
    let meeting_name = race["raceName"].as_str().unwrap_or(event).to_string();
    let circuit = race["Circuit"]["circuitName"].as_str().map(str::to_string);
    let country = race["Circuit"]["Location"]["country"]
        .as_str()
        .map(str::to_string);

    // 2. Driver list + a driverId → racing-number map, from the results.
    let results = get_json(&client, &format!("{ERGAST}/{year}/{round}/results.json")).await?;
    let race0 = &results["MRData"]["RaceTable"]["Races"][0];
    let mut drivers: BTreeMap<String, Driver> = BTreeMap::new();
    let mut id_to_num: BTreeMap<String, String> = BTreeMap::new();
    for r in race0["Results"].as_array().into_iter().flatten() {
        let d = &r["Driver"];
        let num = d["permanentNumber"]
            .as_str()
            .or_else(|| r["number"].as_str())
            .unwrap_or("")
            .to_string();
        if num.is_empty() {
            continue;
        }
        let did = d["driverId"].as_str().unwrap_or_default().to_string();
        id_to_num.insert(did, num.clone());
        let cid = r["Constructor"]["constructorId"]
            .as_str()
            .unwrap_or_default();
        drivers.insert(
            num.clone(),
            Driver {
                racing_number: num.clone(),
                tla: d["code"].as_str().map(str::to_string),
                first_name: d["givenName"].as_str().map(str::to_string),
                last_name: d["familyName"].as_str().map(str::to_string),
                full_name: Some(format!(
                    "{} {}",
                    d["givenName"].as_str().unwrap_or(""),
                    d["familyName"].as_str().unwrap_or("")
                )),
                team_name: r["Constructor"]["name"].as_str().map(str::to_string),
                team_colour: team_colour(cid),
                line: r["grid"].as_str().and_then(|g| g.parse().ok()),
                ..Default::default()
            },
        );
    }
    if drivers.is_empty() {
        return Err(Error::NotFound("Ergast returned no drivers".into()));
    }

    // 3. All per-lap timings (paginated), grouped by lap number.
    let mut laps: BTreeMap<u32, Vec<(String, u32, f64)>> = BTreeMap::new(); // lap -> [(num, pos, ms)]
    let mut offset = 0usize;
    loop {
        // Pace pages so we don't trip the public API's burst rate limit.
        if offset > 0 {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let url = format!("{ERGAST}/{year}/{round}/laps.json?limit={PAGE}&offset={offset}");
        let page = match get_json(&client, &url).await {
            Ok(p) => p,
            // If paging fails partway, keep the laps we already have rather than
            // losing the whole replay.
            Err(e) if !laps.is_empty() => {
                tracing::warn!(error = %e, "lap paging stopped early; using partial data");
                break;
            }
            Err(e) => return Err(e),
        };
        let page_laps = page["MRData"]["RaceTable"]["Races"][0]["Laps"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut got = 0usize;
        for l in &page_laps {
            let lap_no: u32 = l["number"]
                .as_str()
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            for t in l["Timings"].as_array().into_iter().flatten() {
                got += 1;
                let did = t["driverId"].as_str().unwrap_or_default();
                let Some(num) = id_to_num.get(did) else {
                    continue;
                };
                let pos: u32 = t["position"]
                    .as_str()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(0);
                let Some(ms) = t["time"].as_str().and_then(lap_ms) else {
                    continue;
                };
                laps.entry(lap_no).or_default().push((num.clone(), pos, ms));
            }
        }
        let total: usize = page["MRData"]["total"]
            .as_str()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        offset += PAGE;
        if got == 0 || offset >= total {
            break;
        }
    }
    if laps.is_empty() {
        return Err(Error::NotFound("Ergast returned no lap data".into()));
    }
    let total_laps = laps.keys().copied().max().unwrap_or(0);

    // 4. Fold laps into timeline frames (one per lap), computing gaps/intervals.
    let mut state = SessionState::default();
    state.session.meeting_name = Some(meeting_name.clone());
    state.session.session_name = Some("Race".into());
    state.session.session_type = Some("Race".into());
    state.session.circuit = circuit;
    state.session.country = country;
    state.drivers = drivers.clone();

    let mut prev = Value::Object(Default::default());
    let mut frames = Vec::new();
    // Initial frame at t=0: session + driver list visible before racing starts.
    let json0 = serde_json::to_value(&state)?;
    frames.push(TimelineFrame {
        t: 0,
        patch: merge::diff(&prev, &json0),
    });
    prev = json0;

    let mut cum: BTreeMap<String, f64> = BTreeMap::new();
    let mut laps_done: BTreeMap<String, u32> = BTreeMap::new();
    let mut best: BTreeMap<String, f64> = BTreeMap::new();

    for (&lap_no, rows) in &laps {
        for (num, pos, ms) in rows {
            *cum.entry(num.clone()).or_insert(0.0) += ms;
            laps_done.insert(num.clone(), lap_no);
            let b = best.entry(num.clone()).or_insert(f64::MAX);
            if *ms < *b {
                *b = *ms;
            }
            let t = state.timing.entry(num.clone()).or_default();
            t.position = Some(*pos);
            t.number_of_laps = Some(lap_no);
            t.last_lap_time = Some(LapTime {
                value: Some(fmt_time(*ms)),
                ..Default::default()
            });
            t.best_lap_time = Some(LapTime {
                value: Some(fmt_time(best[num])),
                ..Default::default()
            });
        }
        // Gaps/intervals from cumulative times, by current order.
        let leader = state
            .timing
            .iter()
            .filter(|(_, t)| t.position == Some(1))
            .map(|(n, _)| n.clone())
            .next();
        let leader_cum = leader
            .as_ref()
            .and_then(|n| cum.get(n).copied())
            .unwrap_or(0.0);
        // Order the drivers currently classified by position.
        let mut order: Vec<(String, u32)> = state
            .timing
            .iter()
            .filter_map(|(n, t)| t.position.map(|p| (n.clone(), p)))
            .collect();
        order.sort_by_key(|(_, p)| *p);
        let mut prev_num: Option<String> = None;
        for (num, _) in &order {
            let behind = total_laps_behind(lap_no, *laps_done.get(num).unwrap_or(&0));
            let (gap, intv) = if Some(num.clone()) == leader {
                (String::new(), String::new())
            } else if behind >= 1 {
                (format!("+{behind}L"), format!("+{behind}L"))
            } else {
                let g = cum.get(num).copied().unwrap_or(0.0) - leader_cum;
                let i = match &prev_num {
                    Some(p) if laps_done.get(p) == laps_done.get(num) => {
                        cum.get(num).copied().unwrap_or(0.0) - cum.get(p).copied().unwrap_or(0.0)
                    }
                    _ => g,
                };
                (fmt_gap(g.max(0.0)), fmt_gap(i.max(0.0)))
            };
            if let Some(t) = state.timing.get_mut(num) {
                t.gap_to_leader = Some(gap);
                t.interval_to_ahead = Some(intv);
            }
            prev_num = Some(num.clone());
        }
        state.lap_count = Some(LapCount {
            current_lap: Some(lap_no),
            total_laps: Some(total_laps),
        });

        let json = serde_json::to_value(&state)?;
        let patch = merge::diff(&prev, &json);
        if !patch.is_null() {
            frames.push(TimelineFrame {
                t: leader_cum as u64,
                patch,
            });
            prev = json;
        }
    }

    let duration_ms = frames.last().map(|f| f.t).unwrap_or(0);
    Ok(FallbackSession {
        name: format!("{meeting_name} — Race · basic (no telemetry)"),
        timeline: Timeline {
            duration_ms,
            frames,
        },
    })
}

fn total_laps_behind(leader_lap: u32, driver_lap: u32) -> u32 {
    leader_lap.saturating_sub(driver_lap)
}

/// Format milliseconds as `M:SS.mmm`.
fn fmt_time(ms: f64) -> String {
    let total = (ms / 1000.0).max(0.0);
    let m = (total / 60.0).floor() as u64;
    let s = total - (m as f64) * 60.0;
    format!("{m}:{s:06.3}")
}
