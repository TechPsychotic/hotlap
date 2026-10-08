//! Replay engine: drives a [`Recording`] into an [`Engine`] on a virtual clock
//! with play / pause / seek / speed control.
//!
//! Spawned as a background task; callers steer it by sending [`ReplayControl`]
//! commands and observe progress via the engine's broadcast
//! [`ServerMessage::ReplayStatus`].

use std::sync::Arc;
use std::time::Duration;

use hotlap_schema::{RawMessage, ReplayControl, ReplayStatus, SessionState, SourceKind};
use tokio::sync::mpsc;
use tokio::time::{self, Instant};

use crate::engine::Engine;
use crate::parser;
use crate::recording::Recording;

/// Handle to a running replay task.
pub struct ReplayHandle {
    cmd_tx: mpsc::Sender<ReplayControl>,
    task: tokio::task::JoinHandle<()>,
}

impl ReplayHandle {
    /// A sender for issuing transport commands (clone freely to share with the
    /// server and TUI).
    pub fn control(&self) -> mpsc::Sender<ReplayControl> {
        self.cmd_tx.clone()
    }

    /// Wait for the replay task to finish (it runs until all control senders are
    /// dropped).
    pub async fn join(self) {
        let _ = self.task.await;
    }

    /// Stop the replay task immediately (used when switching sessions).
    pub fn abort(&self) {
        self.task.abort();
    }
}

/// Spawn a replay of `recording` into `engine`.
pub fn spawn(
    engine: Arc<Engine>,
    recording: Recording,
    source: SourceKind,
    initial_speed: f64,
    autoplay: bool,
) -> ReplayHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    let task = tokio::spawn(run(
        engine,
        recording,
        source,
        initial_speed,
        autoplay,
        cmd_rx,
    ));
    ReplayHandle { cmd_tx, task }
}

/// How often to emit a status update during continuous playback.
const STATUS_INTERVAL: Duration = Duration::from_millis(250);

async fn run(
    engine: Arc<Engine>,
    recording: Recording,
    source: SourceKind,
    initial_speed: f64,
    autoplay: bool,
    mut cmd_rx: mpsc::Receiver<ReplayControl>,
) {
    let mut t = Transport {
        engine: &engine,
        msgs: &recording.messages,
        duration_ms: recording.duration_ms,
        source,
        speed: initial_speed.max(0.01),
        playing: autoplay,
        playhead_ms: 0,
        cursor: 0,
    };
    t.publish();
    let mut last_status = Instant::now();

    loop {
        // Paused, or finished: block until a command (or exit if none ever come).
        if !t.playing || t.cursor >= t.msgs.len() {
            if t.cursor >= t.msgs.len() {
                t.playing = false;
                t.playhead_ms = t.duration_ms;
                t.publish();
            }
            match cmd_rx.recv().await {
                Some(cmd) => {
                    t.handle(cmd);
                    last_status = Instant::now();
                }
                None => break,
            }
            continue;
        }

        // Playing: wait until the next message's offset (scaled by speed), unless
        // a command arrives first.
        let target_offset = t.msgs[t.cursor].offset_ms;
        let wait = Duration::from_millis(
            ((target_offset.saturating_sub(t.playhead_ms)) as f64 / t.speed) as u64,
        );
        let deadline = Instant::now() + wait;

        tokio::select! {
            _ = time::sleep_until(deadline) => {
                t.playhead_ms = target_offset;
                let start = t.cursor;
                while t.cursor < t.msgs.len() && t.msgs[t.cursor].offset_ms == target_offset {
                    t.cursor += 1;
                }
                t.engine.apply_batch(&t.msgs[start..t.cursor]);
                if last_status.elapsed() >= STATUS_INTERVAL {
                    t.publish();
                    last_status = Instant::now();
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(cmd) => { t.handle(cmd); last_status = Instant::now(); }
                    None => break,
                }
            }
        }
    }
}

/// Mutable transport state, bundled so command handling has one home.
struct Transport<'a> {
    engine: &'a Engine,
    msgs: &'a [RawMessage],
    duration_ms: u64,
    source: SourceKind,
    speed: f64,
    playing: bool,
    playhead_ms: u64,
    cursor: usize,
}

impl Transport<'_> {
    fn handle(&mut self, cmd: ReplayControl) {
        match cmd {
            ReplayControl::Play => self.playing = true,
            ReplayControl::Pause => self.playing = false,
            ReplayControl::SetSpeed { speed } => self.speed = speed.max(0.01),
            ReplayControl::Seek { offset_ms } => self.seek(offset_ms),
        }
        self.publish();
    }

    /// Rebuild state up to `target` from scratch and resync all clients.
    ///
    /// For near-instant scrubbing, the high-rate telemetry/position topics
    /// (`CarData.z`, `Position.z`) are only applied for their latest message
    /// before `target` — the earlier ones are overwritten anyway, and skipping
    /// them avoids thousands of base64+inflate decodes per seek.
    fn seek(&mut self, target: u64) {
        let target = target.min(self.duration_ms);
        let mut state = SessionState::default();
        let mut last_car = None;
        let mut last_pos = None;
        let mut i = 0;
        while i < self.msgs.len() && self.msgs[i].offset_ms <= target {
            match self.msgs[i].base_topic() {
                "CarData" => last_car = Some(i),
                "Position" => last_pos = Some(i),
                _ => {
                    let _ = parser::apply(&mut state, &self.msgs[i]);
                }
            }
            i += 1;
        }
        if let Some(j) = last_car {
            let _ = parser::apply(&mut state, &self.msgs[j]);
        }
        if let Some(j) = last_pos {
            let _ = parser::apply(&mut state, &self.msgs[j]);
        }
        self.engine.reset_state(state);
        self.playhead_ms = target;
        self.cursor = i;
    }

    fn publish(&self) {
        self.engine.set_replay_status(ReplayStatus {
            source: self.source,
            playing: self.playing,
            speed: self.speed,
            position_ms: self.playhead_ms,
            duration_ms: Some(self.duration_ms),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hotlap_schema::ServerMessage;

    fn sample() -> Recording {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sample");
        Recording::load(&dir).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn plays_through_to_the_end() {
        let engine = Engine::new(1024);
        let rec = sample();
        let duration = rec.duration_ms;
        let handle = spawn(engine.clone(), rec, SourceKind::Replay, 1.0, true);

        // Walk the paused virtual clock forward in steps, yielding so the replay
        // task can apply each scheduled batch and arm its next timer.
        let mut elapsed = 0u64;
        while elapsed <= duration + 500
            && engine
                .snapshot()
                .timing
                .get("1")
                .and_then(|t| t.number_of_laps)
                != Some(2)
        {
            time::advance(Duration::from_millis(100)).await;
            tokio::task::yield_now().await;
            elapsed += 100;
        }

        let state = engine.snapshot();
        // By the end, VER should have a last lap time and two laps.
        assert_eq!(state.timing["1"].number_of_laps, Some(2));
        assert_eq!(
            state.timing["1"]
                .last_lap_time
                .as_ref()
                .unwrap()
                .value
                .as_deref(),
            Some("1:14.260")
        );
        // Car telemetry got through too.
        assert!(state.car.contains_key("44"));
        drop(handle);
    }

    #[tokio::test(start_paused = true)]
    async fn seek_rebuilds_state_and_snapshots() {
        let engine = Engine::new(1024);
        let rec = sample();
        let handle = spawn(engine.clone(), rec, SourceKind::Replay, 1.0, false);
        let ctrl = handle.control();

        let (_snap, mut rx) = engine.subscribe();
        // Seek to just past the first timing update (offset 500) but before lap 2.
        ctrl.send(ReplayControl::Seek { offset_ms: 1000 })
            .await
            .unwrap();
        tokio::task::yield_now().await;

        // Drain until we see the snapshot produced by the seek.
        let mut saw_snapshot = false;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMessage::Snapshot { state } = msg {
                assert_eq!(state.timing["44"].position, Some(2));
                // Lap 2 happens at offset 4800, after our seek target.
                assert_eq!(state.timing["1"].number_of_laps, Some(1));
                saw_snapshot = true;
            }
        }
        assert!(saw_snapshot, "seek should broadcast a snapshot");
        drop(handle);
    }
}
