//! Emit the JSON Schema for the wire protocol to stdout.
//!
//! The web build pipes this into `json-schema-to-typescript` to regenerate
//! `web/src/types.gen.ts`, so the Rust types and the TS types can never drift.
//! Run with: `cargo run -p pitwall-schema --features schema-gen --bin export-schema`.

fn main() {
    let schema = schemars::schema_for!(pitwall_schema::ServerMessage);
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}
