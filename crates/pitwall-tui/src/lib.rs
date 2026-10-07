//! ratatui terminal UI for Pitwall.
//!
//! A keyboard-driven dashboard rendering the same [`SessionState`] the web GUI
//! uses. It links [`pitwall_core::Engine`] in-process (no WebSocket): each frame
//! reads `engine.snapshot()`, and transport keys send [`ReplayControl`] over the
//! replay command channel.
//!
//! Keys: `space` play/pause · `←/→` seek ±10s · `[`/`]` slower/faster ·
//! `↑/↓` (or `j`/`k`) focus driver · `q` quit.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use pitwall_core::Engine;
use pitwall_schema::state::{Driver, SessionState, TimingDatum};
use pitwall_schema::{ReplayControl, ReplayStatus};
use ratatui::prelude::*;
use ratatui::widgets::canvas::{Canvas, Points};
use ratatui::widgets::{Block, Borders, Cell, Gauge, Padding, Paragraph, Row, Table, Wrap};
use ratatui::DefaultTerminal;
use tokio::sync::mpsc;

const SPEEDS: [f64; 6] = [0.25, 0.5, 1.0, 2.0, 4.0, 8.0];
const TRAIL_GRID: i64 = 55;

/// Run the TUI against an engine. Blocks until the user quits; call from a
/// blocking context (e.g. `tokio::task::spawn_blocking`).
pub fn run(engine: Arc<Engine>, ctrl: Option<mpsc::Sender<ReplayControl>>) -> Result<()> {
    let mut terminal = ratatui::init();
    let mut app = App::new(engine, ctrl);
    let res = app.run(&mut terminal);
    ratatui::restore();
    res
}

struct App {
    engine: Arc<Engine>,
    ctrl: Option<mpsc::Sender<ReplayControl>>,
    focus: usize,
    speed_idx: usize,
    trail: Vec<(f64, f64)>,
    trail_keys: HashSet<(i64, i64)>,
    quit: bool,
}

impl App {
    fn new(engine: Arc<Engine>, ctrl: Option<mpsc::Sender<ReplayControl>>) -> Self {
        Self {
            engine,
            ctrl,
            focus: 0,
            speed_idx: 2, // 1.0x
            trail: Vec::new(),
            trail_keys: HashSet::new(),
            quit: false,
        }
    }

    fn run(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        loop {
            let state = self.engine.snapshot();
            let status = self.engine.replay_status();
            self.accumulate_trail(&state);
            terminal.draw(|f| self.draw(f, &state, status.as_ref()))?;

            if event::poll(Duration::from_millis(80))? {
                if let Event::Key(k) = event::read()? {
                    if k.kind == KeyEventKind::Press {
                        self.on_key(k.code, k.modifiers, status.as_ref(), order(&state).len());
                    }
                }
            }
            if self.quit {
                return Ok(());
            }
        }
    }

    fn send(&self, c: ReplayControl) {
        if let Some(tx) = &self.ctrl {
            let _ = tx.blocking_send(c);
        }
    }

    fn on_key(
        &mut self,
        code: KeyCode,
        mods: KeyModifiers,
        status: Option<&ReplayStatus>,
        n: usize,
    ) {
        match code {
            KeyCode::Char('q') | KeyCode::Esc => self.quit = true,
            KeyCode::Char('c') if mods.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Char(' ') => {
                let playing = status.map(|s| s.playing).unwrap_or(false);
                self.send(if playing {
                    ReplayControl::Pause
                } else {
                    ReplayControl::Play
                });
            }
            KeyCode::Left => {
                let pos = status.map(|s| s.position_ms).unwrap_or(0);
                self.send(ReplayControl::Seek {
                    offset_ms: pos.saturating_sub(10_000),
                });
            }
            KeyCode::Right => {
                let pos = status.map(|s| s.position_ms).unwrap_or(0);
                self.send(ReplayControl::Seek {
                    offset_ms: pos + 10_000,
                });
            }
            KeyCode::Char('[') => {
                self.speed_idx = self.speed_idx.saturating_sub(1);
                self.send(ReplayControl::SetSpeed {
                    speed: SPEEDS[self.speed_idx],
                });
            }
            KeyCode::Char(']') => {
                self.speed_idx = (self.speed_idx + 1).min(SPEEDS.len() - 1);
                self.send(ReplayControl::SetSpeed {
                    speed: SPEEDS[self.speed_idx],
                });
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.focus = self.focus.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') if n > 0 => {
                self.focus = (self.focus + 1).min(n - 1);
            }
            _ => {}
        }
    }

    fn accumulate_trail(&mut self, state: &SessionState) {
        for p in state.position.values() {
            let (x, y) = match (p.x, p.y) {
                (Some(x), Some(y)) if x != 0.0 || y != 0.0 => (x, y),
                _ => continue,
            };
            let key = (
                (x / TRAIL_GRID as f64) as i64,
                (y / TRAIL_GRID as f64) as i64,
            );
            if self.trail_keys.insert(key) && self.trail.len() < 6000 {
                self.trail.push((x, y));
            }
        }
    }

    fn draw(&self, f: &mut Frame, state: &SessionState, status: Option<&ReplayStatus>) {
        let root = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(0),
            Constraint::Length(1),
        ])
        .split(f.area());

        self.draw_topbar(f, root[0], state, status);

        let cols = Layout::horizontal([Constraint::Percentage(58), Constraint::Percentage(42)])
            .split(root[1]);
        self.draw_timing(f, cols[0], state);

        let right = Layout::vertical([
            Constraint::Length(5),
            Constraint::Min(8),
            Constraint::Length(8),
            Constraint::Min(5),
        ])
        .split(cols[1]);
        self.draw_weather(f, right[0], state);
        self.draw_map(f, right[1], state);
        self.draw_telemetry(f, right[2], state);
        self.draw_racecontrol(f, right[3], state);

        self.draw_help(f, root[2]);
    }

    fn draw_topbar(
        &self,
        f: &mut Frame,
        area: Rect,
        state: &SessionState,
        status: Option<&ReplayStatus>,
    ) {
        let s = &state.session;
        let title = format!(
            " ▟ PITWALL  {}  {}",
            s.meeting_name.clone().unwrap_or_default(),
            s.session_name.clone().unwrap_or_default()
        );
        let (flag_label, flag_color) = flag_of(state);
        let lap = state
            .lap_count
            .as_ref()
            .map(|l| format!("L {}/{}", opt(l.current_lap), opt(l.total_laps)))
            .unwrap_or_default();
        let transport = status
            .map(|st| {
                format!(
                    "{}  {} / {}  {:.2}x",
                    if st.playing { "▶" } else { "❚❚" },
                    clock(st.position_ms),
                    clock(st.duration_ms.unwrap_or(0)),
                    st.speed
                )
            })
            .unwrap_or_default();

        let line = Line::from(vec![
            Span::styled(title, Style::new().fg(Color::White).bold()),
            Span::raw("  "),
            Span::styled(
                format!(" {flag_label} "),
                Style::new().bg(flag_color).fg(Color::Black),
            ),
            Span::raw("  "),
            Span::styled(lap, Style::new().fg(Color::Gray)),
            Span::raw("   "),
            Span::styled(transport, Style::new().fg(Color::Gray)),
        ]);
        f.render_widget(
            Paragraph::new(line).style(Style::new().bg(Color::Rgb(14, 19, 26))),
            area,
        );
    }

    fn draw_timing(&self, f: &mut Frame, area: Rect, state: &SessionState) {
        let order = order(state);
        let header = Row::new(
            ["P", "DRIVER", "GAP", "INT", "LAST", "BEST", "T", "PIT"]
                .into_iter()
                .map(|h| Cell::from(h).style(Style::new().fg(Color::DarkGray))),
        );
        let rows: Vec<Row> = order
            .iter()
            .enumerate()
            .map(|(i, num)| {
                let d = state.drivers.get(num).cloned().unwrap_or_default();
                let t = state.timing.get(num).cloned().unwrap_or_default();
                let tyre = state
                    .stints
                    .get(num)
                    .and_then(|v| v.last())
                    .and_then(|s| s.compound.clone())
                    .map(|c| c.chars().next().unwrap_or(' ').to_string())
                    .unwrap_or_default();
                let sel = i == self.focus;
                let row = Row::new(vec![
                    Cell::from(opt(t.position)),
                    driver_cell(&d, num),
                    Cell::from(if t.in_pit {
                        "IN PIT".to_string()
                    } else {
                        t.gap_to_leader.clone().unwrap_or_default()
                    }),
                    Cell::from(t.interval_to_ahead.clone().unwrap_or_default()),
                    lap_cell(&t, true),
                    lap_cell(&t, false),
                    Cell::from(tyre).style(Style::new().fg(tyre_color(state, num))),
                    Cell::from(opt(t.number_of_pit_stops)),
                ]);
                if sel {
                    row.style(Style::new().bg(Color::Rgb(30, 42, 58)))
                } else {
                    row
                }
            })
            .collect();

        let widths = [
            Constraint::Length(2),
            Constraint::Length(10),
            Constraint::Length(9),
            Constraint::Length(8),
            Constraint::Length(9),
            Constraint::Length(9),
            Constraint::Length(1),
            Constraint::Length(3),
        ];
        let table = Table::new(rows, widths)
            .header(header)
            .block(block("Timing Tower"));
        f.render_widget(table, area);
    }

    fn draw_weather(&self, f: &mut Frame, area: Rect, state: &SessionState) {
        let w = &state.weather;
        let (flag_label, flag_color) = flag_of(state);
        let text = vec![
            Line::from(vec![
                Span::raw("Track "),
                Span::styled(flag_label, Style::new().fg(flag_color).bold()),
                Span::raw(format!(
                    "   Air {}°  Track {}°",
                    fnum(w.air_temp),
                    fnum(w.track_temp)
                )),
            ]),
            Line::from(format!(
                "Humidity {}%  Wind {} m/s  {}",
                fnum(w.humidity),
                fnum(w.wind_speed),
                if w.rainfall == Some(true) {
                    "WET"
                } else {
                    "DRY"
                }
            )),
        ];
        f.render_widget(Paragraph::new(text).block(block("Conditions")), area);
    }

    fn draw_map(&self, f: &mut Frame, area: Rect, state: &SessionState) {
        let src: Vec<(f64, f64)> = if self.trail.len() > 20 {
            self.trail.clone()
        } else {
            state
                .position
                .values()
                .filter_map(|p| Some((p.x?, p.y?)))
                .collect()
        };
        let (mut minx, mut maxx, mut miny, mut maxy) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for &(x, y) in &src {
            minx = minx.min(x);
            maxx = maxx.max(x);
            miny = miny.min(y);
            maxy = maxy.max(y);
        }
        if !src.is_empty() {
            // pad a little
            let px = (maxx - minx) * 0.06 + 1.0;
            let py = (maxy - miny) * 0.06 + 1.0;
            minx -= px;
            maxx += px;
            miny -= py;
            maxy += py;
        } else {
            minx = -1.0;
            maxx = 1.0;
            miny = -1.0;
            maxy = 1.0;
        }

        let cars: Vec<(String, f64, f64, Color)> = state
            .position
            .iter()
            .filter_map(|(num, p)| {
                let (x, y) = (p.x?, p.y?);
                if x == 0.0 && y == 0.0 {
                    return None;
                }
                let d = state.drivers.get(num);
                Some((
                    num.clone(),
                    x,
                    y,
                    team_color(d.and_then(|d| d.team_colour.as_deref())),
                ))
            })
            .collect();
        let trail = self.trail.clone();

        let canvas = Canvas::default()
            .block(block("Track Map"))
            .x_bounds([minx, maxx])
            .y_bounds([miny, maxy])
            .marker(ratatui::symbols::Marker::Braille)
            .paint(move |ctx| {
                ctx.draw(&Points {
                    coords: &trail,
                    color: Color::DarkGray,
                });
                for (_num, x, y, color) in &cars {
                    ctx.draw(&Points {
                        coords: std::slice::from_ref(&(*x, *y)),
                        color: *color,
                    });
                }
            });
        f.render_widget(canvas, area);
    }

    fn draw_telemetry(&self, f: &mut Frame, area: Rect, state: &SessionState) {
        let order = order(state);
        let num = order.get(self.focus.min(order.len().saturating_sub(1)));
        let inner = block("Telemetry");
        let Some(num) = num else {
            f.render_widget(Paragraph::new("No data").block(inner), area);
            return;
        };
        let d = state.drivers.get(num).cloned().unwrap_or_default();
        let c = state.car.get(num).cloned().unwrap_or_default();
        let drs = matches!(c.drs, Some(8 | 10 | 12 | 14));

        let rows = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(inner.inner(area));
        f.render_widget(inner, area);

        let head = Line::from(vec![
            Span::styled(
                d.tla.clone().unwrap_or_else(|| num.clone()),
                Style::new().fg(team_color(d.team_colour.as_deref())).bold(),
            ),
            Span::raw(format!("  {}", d.full_name.clone().unwrap_or_default())),
            Span::raw("   "),
            Span::styled(
                if drs { "DRS" } else { "   " },
                Style::new().fg(Color::Green),
            ),
        ]);
        f.render_widget(Paragraph::new(head), rows[0]);
        f.render_widget(
            Paragraph::new(format!(
                "{:>4} km/h   gear {:>2}   {:>6} rpm",
                opt(c.speed),
                opt(c.gear),
                opt(c.rpm)
            )),
            rows[1],
        );
        f.render_widget(
            Gauge::default()
                .ratio((c.throttle.unwrap_or(0).clamp(0, 100) as f64) / 100.0)
                .gauge_style(Style::new().fg(Color::Green))
                .label(format!("THR {}", opt(c.throttle))),
            rows[2],
        );
        f.render_widget(
            Gauge::default()
                .ratio((c.brake.unwrap_or(0).clamp(0, 100) as f64) / 100.0)
                .gauge_style(Style::new().fg(Color::Red))
                .label(format!("BRK {}", opt(c.brake))),
            rows[3],
        );
    }

    fn draw_racecontrol(&self, f: &mut Frame, area: Rect, state: &SessionState) {
        let b = block("Race Control");
        let inner = b.inner(area);
        let n = inner.height as usize;
        let lines: Vec<Line> = state
            .race_control
            .iter()
            .rev()
            .take(n)
            .map(|m| {
                let color = rc_color(m.flag.as_deref());
                Line::from(vec![
                    Span::styled("▍", Style::new().fg(color)),
                    Span::raw(m.message.clone().unwrap_or_default()),
                ])
            })
            .collect();
        f.render_widget(
            Paragraph::new(lines).block(b).wrap(Wrap { trim: true }),
            area,
        );
    }

    fn draw_help(&self, f: &mut Frame, area: Rect) {
        let help = " space play/pause   ←/→ seek ±10s   [ ] speed   ↑/↓ driver   q quit ";
        f.render_widget(
            Paragraph::new(help).style(Style::new().fg(Color::DarkGray).bg(Color::Rgb(14, 19, 26))),
            area,
        );
    }
}

// ---- helpers -------------------------------------------------------------

fn block(title: &str) -> Block<'_> {
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::new().fg(Color::Rgb(42, 53, 66)))
        .title(Span::styled(
            format!(" {title} "),
            Style::new().fg(Color::Gray),
        ))
        .padding(Padding::horizontal(1))
}

fn order(state: &SessionState) -> Vec<String> {
    let mut nums: Vec<String> = state.timing.keys().cloned().collect();
    nums.sort_by_key(|n| state.timing.get(n).and_then(|t| t.position).unwrap_or(999));
    nums
}

fn team_color(hex: Option<&str>) -> Color {
    if let Some(h) = hex {
        if h.len() == 6 {
            if let (Ok(r), Ok(g), Ok(b)) = (
                u8::from_str_radix(&h[0..2], 16),
                u8::from_str_radix(&h[2..4], 16),
                u8::from_str_radix(&h[4..6], 16),
            ) {
                return Color::Rgb(r, g, b);
            }
        }
    }
    Color::Gray
}

fn tyre_color(state: &SessionState, num: &str) -> Color {
    let c = state
        .stints
        .get(num)
        .and_then(|v| v.last())
        .and_then(|s| s.compound.as_deref())
        .unwrap_or("");
    match c {
        "SOFT" => Color::Red,
        "MEDIUM" => Color::Yellow,
        "HARD" => Color::White,
        "INTERMEDIATE" => Color::Green,
        "WET" => Color::Blue,
        _ => Color::Gray,
    }
}

fn driver_cell<'a>(d: &Driver, num: &str) -> Cell<'a> {
    let tla = d.tla.clone().unwrap_or_else(|| num.to_string());
    Line::from(vec![
        Span::styled("▍", Style::new().fg(team_color(d.team_colour.as_deref()))),
        Span::styled(tla, Style::new().fg(Color::White).bold()),
    ])
    .into()
}

fn lap_cell<'a>(t: &TimingDatum, last: bool) -> Cell<'a> {
    let lt = if last {
        &t.last_lap_time
    } else {
        &t.best_lap_time
    };
    match lt {
        Some(l) => {
            let color = if l.overall_best {
                Color::Magenta
            } else if l.personal_best {
                Color::Green
            } else {
                Color::Gray
            };
            Cell::from(l.value.clone().unwrap_or_default()).style(Style::new().fg(color))
        }
        None => Cell::from(""),
    }
}

/// Current flag state label + colour from track status + race control.
fn flag_of(state: &SessionState) -> (&'static str, Color) {
    match state.track_status.status.as_deref() {
        Some("5") => ("RED FLAG", Color::Red),
        Some("4") => ("SAFETY CAR", Color::Rgb(255, 157, 47)),
        Some("6") | Some("7") => ("VSC", Color::Rgb(255, 157, 47)),
        Some("2") => {
            let dbl = state
                .race_control
                .iter()
                .rev()
                .find_map(|m| m.flag.as_deref().map(|f| f.to_uppercase()))
                .map(|f| f.contains("DOUBLE YELLOW"))
                .unwrap_or(false);
            if dbl {
                ("DOUBLE YELLOW", Color::Yellow)
            } else {
                ("YELLOW", Color::Yellow)
            }
        }
        _ => ("GREEN", Color::Green),
    }
}

fn rc_color(flag: Option<&str>) -> Color {
    match flag.map(|f| f.to_uppercase()) {
        Some(f) if f.contains("RED") => Color::Red,
        Some(f) if f.contains("YELLOW") => Color::Yellow,
        Some(f) if f.contains("GREEN") || f.contains("CLEAR") => Color::Green,
        Some(f) if f.contains("BLUE") => Color::Blue,
        _ => Color::DarkGray,
    }
}

fn clock(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}

fn fnum(v: Option<f64>) -> String {
    v.map(|x| format!("{x:.1}")).unwrap_or_else(|| "—".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pitwall_core::{Engine, Recording};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    #[test]
    fn renders_a_frame() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/monaco-2023-quali");
        let rec = Recording::load(&dir).unwrap();
        let engine = Engine::new(64);
        for m in rec.messages.iter().filter(|m| m.offset_ms <= 360_000) {
            engine.apply(m.clone());
        }
        let state = engine.snapshot();
        let app = App::new(engine, None);

        let mut terminal = Terminal::new(TestBackend::new(170, 48)).unwrap();
        terminal.draw(|f| app.draw(f, &state, None)).unwrap();
        let rendered = format!("{}", terminal.backend());

        assert!(rendered.contains("PITWALL"));
        assert!(rendered.contains("Timing Tower"));
        assert!(rendered.contains("VER"));
        // Uncomment locally to eyeball the layout: cargo test -p pitwall-tui -- --nocapture
        println!("{rendered}");
    }
}
