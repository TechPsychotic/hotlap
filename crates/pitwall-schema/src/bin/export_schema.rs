//! Emit the JSON Schema for the wire protocol to stdout.
//!
//! The web build pipes this into `json-schema-to-typescript` to regenerate
//! `web/src/types.gen.ts`, so the Rust types and the TS types can never drift.
//! Run with: `cargo run -p pitwall-schema --features schema-gen --bin export-schema`.

use pitwall_schema::{ClientMessage, ServerMessage};

/// Wrapper so a single schema document carries both directions of the protocol
/// (and, transitively, every type they reference).
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct Protocol {
    server: ServerMessage,
    client: ClientMessage,
}

fn main() {
    let schema = schemars::schema_for!(Protocol);
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}
