//! Translate raw F1 feed messages into the normalized [`SessionState`].
//!
//! The feed speaks PascalCase and sends partial deltas (only changed fields),
//! sometimes keying "arrays" as objects with numeric string keys (e.g. sectors,
//! segments, stints, race-control messages). This module folds each
//! [`RawMessage`] into the typed state, applying only the fields present so that
//! deltas accumulate correctly. Live, recorded, and historical data all arrive
//! here identically.

use hotlap_schema::state::*;
use hotlap_schema::RawMessage;
use serde_json::Value;

use crate::{decode, Result};

/// Fold one raw message into `state`.
pub fn apply(state: &mut SessionState, msg: &RawMessage) -> Result<()> {
    let payload = resolve_payload(msg)?;
    match msg.base_topic() {
        "SessionInfo" => apply_session_info(state, &payload),
        "SessionStatus" => {
            if let Some(s) = coerce::str(&payload["Status"]) {
                state.session.status = Some(s);
            }
        }
        "SessionData" => apply_session_data(state, &payload),
        "DriverList" => apply_driver_list(state, &payload),
        "LapCount" => apply_lap_count(state, &payload),
        "TrackStatus" => {
            state.track_status.status = coerce::str(&payload["Status"]);
            state.track_status.message = coerce::str(&payload["Message"]);
        }
        "WeatherData" => apply_weather(state, &payload),
        "ExtrapolatedClock" => apply_clock(state, &payload),
        "TimingData" => apply_timing_data(state, &payload),
        "TimingAppData" => apply_timing_app_data(state, &payload),
        "CarData" => apply_car_data(state, &payload, msg.offset_ms),
        "Position" => apply_position(state, &payload, msg.offset_ms),
        "RaceControlMessages" => apply_race_control(state, &payload),
        "Commentary" => apply_commentary(state, &payload),
        "TeamRadio" => apply_team_radio(state, &payload),
        "Heartbeat" => {}
        _ => {} // Unknown/unhandled topic: ignored, not an error.
    }
    Ok(())
}

/// For compressed topics the payload may be the raw base64 string; inflate it.
/// Otherwise the payload is already JSON.
fn resolve_payload(msg: &RawMessage) -> Result<Value> {
    if let Value::String(s) = &msg.payload {
        // CarData.z / Position.z (or a fixture that stored the compressed form).
        if msg.is_compressed() || matches!(msg.base_topic(), "CarData" | "Position") {
            return decode::inflate_z(s);
        }
    }
    Ok(msg.payload.clone())
}

fn apply_session_info(state: &mut SessionState, p: &Value) {
    let s = &mut state.session;
    let meeting = &p["Meeting"];
    s.meeting_name = coerce::str(&meeting["Name"]).or(s.meeting_name.take());
    s.official_name = coerce::str(&meeting["OfficialName"]).or(s.official_name.take());
    s.country = coerce::str(&meeting["Country"]["Name"]).or(s.country.take());
    s.circuit = coerce::str(&meeting["Circuit"]["ShortName"]).or(s.circuit.take());
    s.session_name = coerce::str(&p["Name"]).or(s.session_name.take());
    s.session_type = coerce::str(&p["Type"]).or(s.session_type.take());
    s.start_date = coerce::str(&p["StartDate"]).or(s.start_date.take());
    s.end_date = coerce::str(&p["EndDate"]).or(s.end_date.take());
    s.gmt_offset = coerce::str(&p["GmtOffset"]).or(s.gmt_offset.take());
    s.year = coerce::i64(&p["Year"]).map(|y| y as i32).or(s.year);
    s.path = coerce::str(&p["Path"]).or(s.path.take());
}

fn apply_session_data(state: &mut SessionState, p: &Value) {
    // StatusSeries carries session/track status changes over time; take the last
    // SessionStatus we can find as the current one.
    for (_, entry) in indexed(&p["StatusSeries"]) {
        if let Some(s) = coerce::str(&entry["SessionStatus"]) {
            state.session.status = Some(s);
        }
    }
}

fn apply_driver_list(state: &mut SessionState, p: &Value) {
    let Some(obj) = p.as_object() else { return };
    for (num, d) in obj {
        if num.starts_with('_') {
            continue;
        }
        let driver = state.drivers.entry(num.clone()).or_default();
        driver.racing_number = num.clone();
        merge_str(&mut driver.broadcast_name, &d["BroadcastName"]);
        merge_str(&mut driver.tla, &d["Tla"]);
        merge_str(&mut driver.full_name, &d["FullName"]);
        merge_str(&mut driver.first_name, &d["FirstName"]);
        merge_str(&mut driver.last_name, &d["LastName"]);
        merge_str(&mut driver.team_name, &d["TeamName"]);
        merge_str(&mut driver.team_colour, &d["TeamColour"]);
        merge_str(&mut driver.headshot_url, &d["HeadshotUrl"]);
        merge_str(&mut driver.country_code, &d["CountryCode"]);
        if let Some(line) = coerce::u32(&d["Line"]) {
            driver.line = Some(line);
        }
    }
}

fn apply_lap_count(state: &mut SessionState, p: &Value) {
    let lc = state.lap_count.get_or_insert_with(LapCount::default);
    if let Some(v) = coerce::u32(&p["CurrentLap"]) {
        lc.current_lap = Some(v);
    }
    if let Some(v) = coerce::u32(&p["TotalLaps"]) {
        lc.total_laps = Some(v);
    }
}

fn apply_weather(state: &mut SessionState, p: &Value) {
    let w = &mut state.weather;
    merge_f64(&mut w.air_temp, &p["AirTemp"]);
    merge_f64(&mut w.track_temp, &p["TrackTemp"]);
    merge_f64(&mut w.humidity, &p["Humidity"]);
    merge_f64(&mut w.pressure, &p["Pressure"]);
    merge_f64(&mut w.wind_speed, &p["WindSpeed"]);
    merge_f64(&mut w.wind_direction, &p["WindDirection"]);
    if let Some(b) = coerce::bool(&p["Rainfall"]) {
        w.rainfall = Some(b);
    }
}

fn apply_clock(state: &mut SessionState, p: &Value) {
    let c = &mut state.clock;
    merge_str(&mut c.utc, &p["Utc"]);
    merge_str(&mut c.remaining, &p["Remaining"]);
    if let Some(b) = coerce::bool(&p["Extrapolating"]) {
        c.extrapolating = b;
    }
}

fn apply_timing_data(state: &mut SessionState, p: &Value) {
    let Some(lines) = p["Lines"].as_object() else {
        return;
    };
    for (num, line) in lines {
        let t = state.timing.entry(num.clone()).or_default();
        if let Some(pos) = coerce::u32(&line["Position"]) {
            t.position = Some(pos);
        }
        merge_str(&mut t.gap_to_leader, &line["GapToLeader"]);
        if !line["IntervalToPositionAhead"].is_null() {
            merge_str(
                &mut t.interval_to_ahead,
                &line["IntervalToPositionAhead"]["Value"],
            );
        }
        apply_lap_time(&mut t.last_lap_time, &line["LastLapTime"]);
        apply_lap_time(&mut t.best_lap_time, &line["BestLapTime"]);
        if let Some(v) = coerce::u32(&line["NumberOfLaps"]) {
            t.number_of_laps = Some(v);
        }
        if let Some(v) = coerce::u32(&line["NumberOfPitStops"]) {
            t.number_of_pit_stops = Some(v);
        }
        set_bool(&mut t.in_pit, &line["InPit"]);
        set_bool(&mut t.pit_out, &line["PitOut"]);
        set_bool(&mut t.retired, &line["Retired"]);
        set_bool(&mut t.stopped, &line["Stopped"]);
        set_bool(&mut t.knocked_out, &line["KnockedOut"]);
        set_bool(&mut t.cut_off, &line["Cutoff"]);
        apply_sectors(&mut t.sectors, &line["Sectors"]);
        apply_speeds(&mut t.speeds, &line["Speeds"]);
    }
}

fn apply_lap_time(slot: &mut Option<LapTime>, v: &Value) {
    if v.is_null() {
        return;
    }
    let lt = slot.get_or_insert_with(LapTime::default);
    merge_str(&mut lt.value, &v["Value"]);
    if let Some(b) = coerce::bool(&v["PersonalFastest"]).or(coerce::bool(&v["PersonalBest"])) {
        lt.personal_best = b;
    }
    if let Some(b) = coerce::bool(&v["OverallFastest"]) {
        lt.overall_best = b;
    }
}

fn apply_sectors(sectors: &mut Vec<Sector>, v: &Value) {
    for (idx, sv) in indexed(v) {
        ensure_len(sectors, idx + 1);
        let sector = &mut sectors[idx];
        merge_str(&mut sector.value, &sv["Value"]);
        if let Some(b) = coerce::bool(&sv["PersonalFastest"]) {
            sector.personal_best = b;
        }
        if let Some(b) = coerce::bool(&sv["OverallFastest"]) {
            sector.overall_best = b;
        }
        for (sidx, seg) in indexed(&sv["Segments"]) {
            ensure_len(&mut sector.segments, sidx + 1);
            if let Some(status) = coerce::u32(&seg["Status"]) {
                sector.segments[sidx].status = Some(status);
            }
        }
    }
}

fn apply_speeds(speeds: &mut Speeds, v: &Value) {
    apply_speed_trap(&mut speeds.i1, &v["I1"]);
    apply_speed_trap(&mut speeds.i2, &v["I2"]);
    apply_speed_trap(&mut speeds.fl, &v["FL"]);
    apply_speed_trap(&mut speeds.st, &v["ST"]);
}

fn apply_speed_trap(slot: &mut Option<SpeedTrap>, v: &Value) {
    if v.is_null() {
        return;
    }
    let st = slot.get_or_insert_with(SpeedTrap::default);
    merge_str(&mut st.value, &v["Value"]);
    if let Some(b) = coerce::bool(&v["PersonalFastest"]) {
        st.personal_best = b;
    }
    if let Some(b) = coerce::bool(&v["OverallFastest"]) {
        st.overall_best = b;
    }
}

fn apply_timing_app_data(state: &mut SessionState, p: &Value) {
    let Some(lines) = p["Lines"].as_object() else {
        return;
    };
    for (num, line) in lines {
        let stints = state.stints.entry(num.clone()).or_default();
        for (idx, sv) in indexed(&line["Stints"]) {
            ensure_len(stints, idx + 1);
            let stint = &mut stints[idx];
            merge_str(&mut stint.compound, &sv["Compound"]);
            if let Some(b) = coerce::bool(&sv["New"]) {
                stint.new = Some(b);
            }
            if let Some(v) = coerce::u32(&sv["TotalLaps"]) {
                stint.total_laps = Some(v);
            }
            if let Some(v) = coerce::u32(&sv["StartLaps"]) {
                stint.start_laps = Some(v);
            }
        }
    }
}

fn apply_car_data(state: &mut SessionState, p: &Value, offset_ms: u64) {
    let Some(entries) = p["Entries"].as_array() else {
        return;
    };
    for entry in entries {
        let Some(cars) = entry["Cars"].as_object() else {
            continue;
        };
        for (num, car) in cars {
            let ch = &car["Channels"];
            let t = state.car.entry(num.clone()).or_default();
            // Channel map: 0=RPM, 2=Speed, 3=nGear, 4=Throttle, 5=Brake, 45=DRS.
            if let Some(v) = coerce::i64(&ch["0"]) {
                t.rpm = Some(v as i32);
            }
            if let Some(v) = coerce::i64(&ch["2"]) {
                t.speed = Some(v as i32);
            }
            if let Some(v) = coerce::i64(&ch["3"]) {
                t.gear = Some(v as i32);
            }
            if let Some(v) = coerce::i64(&ch["4"]) {
                t.throttle = Some(v as i32);
            }
            if let Some(v) = coerce::i64(&ch["5"]) {
                t.brake = Some(v as i32);
            }
            if let Some(v) = coerce::i64(&ch["45"]) {
                t.drs = Some(v as i32);
            }
            t.offset_ms = Some(offset_ms);
        }
    }
}

fn apply_position(state: &mut SessionState, p: &Value, offset_ms: u64) {
    let Some(frames) = p["Position"].as_array() else {
        return;
    };
    for frame in frames {
        let Some(entries) = frame["Entries"].as_object() else {
            continue;
        };
        for (num, e) in entries {
            let pos = state.position.entry(num.clone()).or_default();
            merge_str(&mut pos.status, &e["Status"]);
            merge_f64(&mut pos.x, &e["X"]);
            merge_f64(&mut pos.y, &e["Y"]);
            merge_f64(&mut pos.z, &e["Z"]);
            pos.offset_ms = Some(offset_ms);
        }
    }
}

fn apply_race_control(state: &mut SessionState, p: &Value) {
    for (_, m) in indexed(&p["Messages"]) {
        state.race_control.push(RaceControlMessage {
            utc: coerce::str(&m["Utc"]),
            lap: coerce::u32(&m["Lap"]),
            category: coerce::str(&m["Category"]),
            message: coerce::str(&m["Message"]),
            flag: coerce::str(&m["Flag"]),
            scope: coerce::str(&m["Scope"]),
            sector: coerce::u32(&m["Sector"]),
            racing_number: coerce::str(&m["RacingNumber"]),
        });
    }
}

/// One commentary post from F1's live-blog (Monterosa), injected server-side as
/// a synthetic `Commentary` message (`{Title, Text, Utc}`).
fn apply_commentary(state: &mut SessionState, p: &Value) {
    let title = coerce::str(&p["Title"]);
    let message = coerce::str(&p["Text"]);
    if title.is_some() || message.is_some() {
        state.commentary.push(CommentaryMsg {
            utc: coerce::str(&p["Utc"]),
            title,
            message,
        });
    }
}

fn apply_team_radio(state: &mut SessionState, p: &Value) {
    for (_, c) in indexed(&p["Captures"]) {
        state.team_radio.push(TeamRadioClip {
            utc: coerce::str(&c["Utc"]),
            racing_number: coerce::str(&c["RacingNumber"]),
            path: coerce::str(&c["Path"]),
        });
    }
}

// ---- small helpers -------------------------------------------------------

/// Iterate a feed collection that may be either a JSON array or an object keyed
/// by numeric string indices. Yields `(index, &Value)` in index order.
fn indexed(v: &Value) -> Vec<(usize, &Value)> {
    match v {
        Value::Array(arr) => arr.iter().enumerate().collect(),
        Value::Object(map) => {
            let mut items: Vec<(usize, &Value)> = map
                .iter()
                .filter(|(k, _)| !k.starts_with('_'))
                .filter_map(|(k, v)| k.parse::<usize>().ok().map(|i| (i, v)))
                .collect();
            items.sort_by_key(|(i, _)| *i);
            items
        }
        _ => Vec::new(),
    }
}

fn ensure_len<T: Default + Clone>(vec: &mut Vec<T>, len: usize) {
    if vec.len() < len {
        vec.resize(len, T::default());
    }
}

/// Set `slot` from `v` only if `v` carries a usable string.
fn merge_str(slot: &mut Option<String>, v: &Value) {
    if let Some(s) = coerce::str(v) {
        *slot = Some(s);
    }
}

fn merge_f64(slot: &mut Option<f64>, v: &Value) {
    if let Some(f) = coerce::f64(v) {
        *slot = Some(f);
    }
}

/// Set a plain bool field only when the feed provides the value.
fn set_bool(slot: &mut bool, v: &Value) {
    if let Some(b) = coerce::bool(v) {
        *slot = b;
    }
}

/// Lenient coercion from the feed's loosely-typed JSON (numbers often arrive as
/// strings, booleans as `"1"`/`"0"`).
mod coerce {
    use serde_json::Value;

    pub fn str(v: &Value) -> Option<String> {
        match v {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::String(_) => None,
            Value::Null => None,
            other => Some(other.to_string()),
        }
    }

    pub fn f64(v: &Value) -> Option<f64> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    pub fn i64(v: &Value) -> Option<i64> {
        match v {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Value::String(s) => s
                .trim()
                .parse()
                .ok()
                .or_else(|| s.trim().parse::<f64>().ok().map(|f| f as i64)),
            _ => None,
        }
    }

    pub fn u32(v: &Value) -> Option<u32> {
        i64(v).and_then(|n| u32::try_from(n).ok())
    }

    pub fn bool(v: &Value) -> Option<bool> {
        match v {
            Value::Bool(b) => Some(*b),
            Value::Number(n) => n.as_i64().map(|i| i != 0),
            Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" => Some(true),
                "0" | "false" | "no" | "" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(topic: &str, offset_ms: u64, payload: Value) -> RawMessage {
        RawMessage {
            topic: topic.to_string(),
            payload,
            utc: None,
            offset_ms,
        }
    }

    #[test]
    fn parses_driver_list_and_skips_housekeeping() {
        let mut s = SessionState::default();
        apply(
            &mut s,
            &raw(
                "DriverList",
                0,
                json!({
                    "_kf": true,
                    "44": {"RacingNumber": "44", "Tla": "HAM", "TeamColour": "6CD3BF", "Line": 2}
                }),
            ),
        )
        .unwrap();
        assert_eq!(s.drivers.len(), 1);
        assert_eq!(s.drivers["44"].tla.as_deref(), Some("HAM"));
        assert_eq!(s.drivers["44"].line, Some(2));
    }

    #[test]
    fn timing_deltas_accumulate() {
        let mut s = SessionState::default();
        apply(
            &mut s,
            &raw(
                "TimingData",
                0,
                json!({"Lines": {"44": {"Position": "2", "GapToLeader": "+0.6"}}}),
            ),
        )
        .unwrap();
        // A later partial update must not wipe the position set earlier.
        apply(
            &mut s,
            &raw(
                "TimingData",
                1,
                json!({"Lines": {"44": {"GapToLeader": "+0.4"}}}),
            ),
        )
        .unwrap();
        let t = &s.timing["44"];
        assert_eq!(t.position, Some(2));
        assert_eq!(t.gap_to_leader.as_deref(), Some("+0.4"));
    }

    #[test]
    fn sector_segments_merge_by_index() {
        let mut s = SessionState::default();
        apply(
            &mut s,
            &raw(
                "TimingData",
                0,
                json!({"Lines": {"44": {"Sectors": {"0": {"Segments": {"2": {"Status": 2051}}}}}}}),
            ),
        )
        .unwrap();
        let seg = &s.timing["44"].sectors[0].segments;
        assert_eq!(seg.len(), 3);
        assert_eq!(seg[2].status, Some(2051));
    }

    #[test]
    fn car_data_channels_map_correctly() {
        let mut s = SessionState::default();
        apply(
            &mut s,
            &raw(
                "CarData",
                500,
                json!({"Entries": [{"Cars": {"1": {"Channels": {"0": 11200, "2": 288, "3": 7, "4": 100, "5": 0, "45": 1}}}}]}),
            ),
        )
        .unwrap();
        let c = &s.car["1"];
        assert_eq!(c.rpm, Some(11200));
        assert_eq!(c.speed, Some(288));
        assert_eq!(c.gear, Some(7));
        assert_eq!(c.drs, Some(1));
        assert_eq!(c.offset_ms, Some(500));
    }

    #[test]
    fn weather_coerces_string_numbers() {
        let mut s = SessionState::default();
        apply(
            &mut s,
            &raw(
                "WeatherData",
                0,
                json!({"AirTemp": "24.1", "Rainfall": "0"}),
            ),
        )
        .unwrap();
        assert_eq!(s.weather.air_temp, Some(24.1));
        assert_eq!(s.weather.rainfall, Some(false));
    }

    #[test]
    fn race_control_appends() {
        let mut s = SessionState::default();
        apply(
            &mut s,
            &raw(
                "RaceControlMessages",
                0,
                json!({"Messages": {"1": {"Message": "GREEN", "Flag": "GREEN"}}}),
            ),
        )
        .unwrap();
        assert_eq!(s.race_control.len(), 1);
        assert_eq!(s.race_control[0].flag.as_deref(), Some("GREEN"));
    }
}
