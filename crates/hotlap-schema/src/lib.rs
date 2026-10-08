//! Shared data types for Hotlap.
//!
//! These types are the single source of truth for the data that flows from the
//! core out to every client (web GUI, TUI). They derive [`schemars::JsonSchema`]
//! so the web front-end's TypeScript types can be generated from them, keeping
//! Rust and TypeScript in lockstep (see the `export-schema` bin).

pub mod raw;
pub mod state;
pub mod wire;

pub use raw::RawMessage;
pub use state::SessionState;
pub use wire::{ClientMessage, ReplayControl, ReplayStatus, ServerMessage, SourceKind};
