//! Decoding for the compressed feed topics (`CarData.z`, `Position.z`).
//!
//! These arrive as a base64 string whose bytes are **raw DEFLATE** (no zlib
//! header), matching how FastF1 decodes them
//! (`zlib.decompress(b64decode(x), -zlib.MAX_WBITS)`).

use base64::Engine;
use flate2::read::DeflateDecoder;
use std::io::Read;

use crate::{Error, Result};

/// Decode a base64 + raw-DEFLATE feed payload into a parsed JSON value.
pub fn inflate_z(payload: &str) -> Result<serde_json::Value> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| Error::Decode(format!("base64: {e}")))?;

    let mut decoder = DeflateDecoder::new(&bytes[..]);
    let mut out = String::new();
    decoder
        .read_to_string(&mut out)
        .map_err(|e| Error::Decode(format!("inflate: {e}")))?;

    Ok(serde_json::from_str(&out)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::DeflateEncoder, Compression};
    use std::io::Write;

    /// Build the same base64(raw-deflate(json)) shape the feed sends, so we can
    /// round-trip it back through `inflate_z`.
    fn encode_z(json: &str) -> String {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(json.as_bytes()).unwrap();
        let compressed = enc.finish().unwrap();
        base64::engine::general_purpose::STANDARD.encode(compressed)
    }

    #[test]
    fn round_trips_cardata_shape() {
        let json = r#"{"Entries":[{"Utc":"2023-05-28T13:00:00Z","Cars":{"44":{"Channels":{"0":11000,"2":310,"3":7,"4":100,"5":0,"45":1}}}}]}"#;
        let encoded = encode_z(json);
        let value = inflate_z(&encoded).unwrap();
        assert_eq!(value["Entries"][0]["Cars"]["44"]["Channels"]["2"], 310);
    }

    #[test]
    fn rejects_garbage() {
        assert!(inflate_z("not base64 @@@").is_err());
    }
}
