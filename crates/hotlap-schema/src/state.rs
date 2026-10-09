//! The normalized session state — the clean, UI-friendly model that both
//! front-ends render. The parser folds raw feed deltas into this.
//!
//! Maps are keyed by **racing number** (as a string, e.g. `"44"`), matching the
//! feed's own keying. All fields are optional / defaulted so a partial feed (or
//! a session mid-replay) still produces a valid, renderable state.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Everything a client needs to render, in one normalized tree.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session: SessionInfo,
    pub clock: ExtrapolatedClock,
    pub lap_count: Option<LapCount>,
    pub track_status: TrackStatus,
    pub weather: WeatherData,

    /// Static-ish per-driver info (name, team, colour), keyed by racing number.
    pub drivers: BTreeMap<String, Driver>,
    /// Live timing per driver (gaps, sectors, laps, pit), keyed by racing number.
    pub timing: BTreeMap<String, TimingDatum>,
    /// Strategy/stint info per driver, keyed by racing number.
    pub stints: BTreeMap<String, Vec<Stint>>,
    /// Latest car telemetry per driver, keyed by racing number.
    pub car: BTreeMap<String, CarTelemetry>,
    /// Latest track position per driver, keyed by racing number.
    pub position: BTreeMap<String, Position>,

    /// Rolling race-control log, newest last.
    pub race_control: Vec<RaceControlMessage>,
    /// Broadcast-ticker commentary messages (the `TlaRcm` feed), newest last.
    pub commentary: Vec<CommentaryMsg>,
    /// Captured team-radio clips.
    pub team_radio: Vec<TeamRadioClip>,

    /// Current tyre compound per driver (from `CurrentTyres`).
    pub current_tyres: BTreeMap<String, CurrentTyre>,
    /// Per-driver track position at each lap (from `LapSeries`) — for a
    /// position-change chart.
    pub lap_series: BTreeMap<String, LapSeries>,
    /// Latest pit-lane time per driver (from `PitLaneTimeCollection`).
    pub pit_lane_times: BTreeMap<String, PitLaneTime>,
    /// Broadcast top-three (from `TopThree`).
    pub top_three: Vec<TopThreeLine>,
    /// Weather samples over the session (from `WeatherDataSeries`).
    pub weather_series: Vec<WeatherSample>,
    /// Live audio / commentary streams (from `AudioStreams`).
    pub audio_streams: Vec<AudioStream>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTyre {
    pub compound: Option<String>,
    pub new: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LapSeries {
    pub racing_number: Option<String>,
    /// Track position (as a string, e.g. `"3"`) at each lap index.
    pub lap_position: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PitLaneTime {
    /// Seconds spent in the pit lane, e.g. `"23.4"`.
    pub duration: Option<String>,
    pub lap: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopThreeLine {
    pub position: Option<String>,
    pub racing_number: Option<String>,
    pub tla: Option<String>,
    pub team_colour: Option<String>,
    pub lap_time: Option<String>,
    pub diff_to_ahead: Option<String>,
    pub diff_to_leader: Option<String>,
    pub overall_fastest: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WeatherSample {
    pub timestamp: Option<String>,
    pub weather: WeatherData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub name: Option<String>,
    pub language: Option<String>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommentaryMsg {
    pub utc: Option<String>,
    pub title: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub meeting_name: Option<String>,
    pub official_name: Option<String>,
    pub country: Option<String>,
    pub circuit: Option<String>,
    /// `Practice`, `Qualifying`, `Race`, `Sprint`, etc.
    pub session_type: Option<String>,
    pub session_name: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub gmt_offset: Option<String>,
    /// Feed session status: `Inactive`, `Started`, `Finished`, `Finalised`, ...
    pub status: Option<String>,
    pub year: Option<i32>,
    /// Archive path under `livetiming.formula1.com/static/`, used to build URLs
    /// for assets like team-radio audio clips.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtrapolatedClock {
    pub utc: Option<String>,
    /// Time remaining in the session, `HH:MM:SS`.
    pub remaining: Option<String>,
    /// Whether the client should keep counting the clock down locally.
    pub extrapolating: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LapCount {
    pub current_lap: Option<u32>,
    pub total_laps: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrackStatus {
    /// Raw status code (1=AllClear, 2=Yellow, 4=SC, 5=Red, 6=VSC, 7=VSC ending...).
    pub status: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WeatherData {
    pub air_temp: Option<f64>,
    pub track_temp: Option<f64>,
    pub humidity: Option<f64>,
    pub pressure: Option<f64>,
    pub wind_speed: Option<f64>,
    pub wind_direction: Option<f64>,
    /// `true`/`1` when it is raining.
    pub rainfall: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    pub racing_number: String,
    pub broadcast_name: Option<String>,
    /// Three-letter abbreviation, e.g. `HAM`.
    pub tla: Option<String>,
    pub full_name: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub team_name: Option<String>,
    /// Team colour as a hex string without `#`, e.g. `00D2BE`.
    pub team_colour: Option<String>,
    pub headshot_url: Option<String>,
    pub country_code: Option<String>,
    /// Starting/grid line order from the feed.
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimingDatum {
    pub position: Option<u32>,
    /// Gap to the leader, e.g. `+12.345` or `1L`.
    pub gap_to_leader: Option<String>,
    /// Interval to the car ahead.
    pub interval_to_ahead: Option<String>,
    pub last_lap_time: Option<LapTime>,
    pub best_lap_time: Option<LapTime>,
    /// The three sectors; each has segments (mini-sectors).
    pub sectors: Vec<Sector>,
    /// Speed-trap readings: I1, I2, FL (finish line), ST (speed trap).
    pub speeds: Speeds,
    pub number_of_laps: Option<u32>,
    pub number_of_pit_stops: Option<u32>,
    pub in_pit: bool,
    pub pit_out: bool,
    pub retired: bool,
    pub stopped: bool,
    /// Qualifying: knocked out of the current segment.
    pub knocked_out: bool,
    /// Current qualifying cut line status, when applicable.
    pub cut_off: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LapTime {
    pub value: Option<String>,
    pub personal_best: bool,
    pub overall_best: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sector {
    pub value: Option<String>,
    pub personal_best: bool,
    pub overall_best: bool,
    /// Mini-sector segments; status codes drive the purple/green/yellow colouring.
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    /// Mini-sector status: 0=none, 2048=yellow, 2049=green, 2051=purple, 2052=pit...
    pub status: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Speeds {
    pub i1: Option<SpeedTrap>,
    pub i2: Option<SpeedTrap>,
    pub fl: Option<SpeedTrap>,
    pub st: Option<SpeedTrap>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTrap {
    pub value: Option<String>,
    pub personal_best: bool,
    pub overall_best: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stint {
    /// Tyre compound: `SOFT`, `MEDIUM`, `HARD`, `INTERMEDIATE`, `WET`.
    pub compound: Option<String>,
    pub new: Option<bool>,
    pub laps: Option<u32>,
    pub start_laps: Option<u32>,
    pub total_laps: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CarTelemetry {
    pub rpm: Option<i32>,
    pub speed: Option<i32>,
    pub gear: Option<i32>,
    /// 0..=100
    pub throttle: Option<i32>,
    /// 0 or 100 (feed is effectively on/off), sometimes 0..=100.
    pub brake: Option<i32>,
    /// DRS code from the feed (0,1 off; 8,10,12,14 on/available).
    pub drs: Option<i32>,
    /// Source offset (ms) of this sample, for chart alignment.
    pub offset_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// `OnTrack`, `OffTrack`, `Pit`, ...
    pub status: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z: Option<f64>,
    pub offset_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RaceControlMessage {
    pub utc: Option<String>,
    pub lap: Option<u32>,
    pub category: Option<String>,
    pub message: Option<String>,
    pub flag: Option<String>,
    pub scope: Option<String>,
    pub sector: Option<u32>,
    pub racing_number: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TeamRadioClip {
    pub utc: Option<String>,
    pub racing_number: Option<String>,
    /// Path (relative to the feed's audio base) of the captured clip.
    pub path: Option<String>,
}
