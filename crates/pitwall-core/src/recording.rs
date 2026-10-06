//! Reading and writing recordings (`session.jsonl`).
//!
//! A recording is a newline-delimited stream of [`RawMessage`]s. Because it is
//! the *raw* feed, replaying it drives the exact same parser that rendered the
//! session live.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use pitwall_schema::RawMessage;

use crate::{Error, Result};

/// Standard file name for the message stream inside a recording directory.
pub const SESSION_FILE: &str = "session.jsonl";

/// A loaded recording, sorted by offset.
pub struct Recording {
    pub messages: Vec<RawMessage>,
    /// Offset of the last message, i.e. total session length in ms.
    pub duration_ms: u64,
}

impl Recording {
    /// Load from a recording directory (`<dir>/session.jsonl`) or a direct path
    /// to a `.jsonl` file.
    pub fn load(path: &Path) -> Result<Self> {
        let file = if path.is_dir() {
            path.join(SESSION_FILE)
        } else {
            path.to_path_buf()
        };
        let content = fs::read_to_string(&file)?;
        let mut messages = Vec::new();
        for (i, line) in content.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let msg: RawMessage = serde_json::from_str(line)
                .map_err(|e| Error::Decode(format!("{}:{}: {e}", file.display(), i + 1)))?;
            messages.push(msg);
        }
        messages.sort_by_key(|m| m.offset_ms);
        let duration_ms = messages.last().map(|m| m.offset_ms).unwrap_or(0);
        Ok(Self {
            messages,
            duration_ms,
        })
    }
}

/// Appends raw messages to `<dir>/session.jsonl` as they arrive (used by live
/// ingest so sessions can be replayed later).
pub struct Recorder {
    writer: BufWriter<File>,
}

impl Recorder {
    /// Create a recorder writing into `dir` (created if missing).
    pub fn create(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let file = File::create(dir.join(SESSION_FILE))?;
        Ok(Self {
            writer: BufWriter::new(file),
        })
    }

    /// Append one message.
    pub fn record(&mut self, msg: &RawMessage) -> Result<()> {
        serde_json::to_writer(&mut self.writer, msg)?;
        self.writer.write_all(b"\n")?;
        Ok(())
    }

    /// Flush buffered writes to disk.
    pub fn flush(&mut self) -> Result<()> {
        self.writer.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_the_bundled_sample() {
        // crates/pitwall-core -> ../../fixtures/sample
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sample");
        let rec = Recording::load(&dir).unwrap();
        assert!(rec.messages.len() >= 10, "sample should have content");
        assert_eq!(rec.duration_ms, 4800);
        assert_eq!(rec.messages[0].topic, "SessionInfo");
    }
}
