//! JSON Merge Patch (RFC 7386).
//!
//! The engine keeps the full [`hotlap_schema::SessionState`] and, each time it
//! folds in new feed data, emits the **diff** as a merge patch. Clients apply
//! these patches to their own copy. Objects merge key-by-key; a `null` value
//! deletes a key; any non-object value (including arrays) replaces wholesale —
//! which is exactly the semantics we want for log arrays like race control.

use serde_json::{Map, Value};

/// Apply a merge patch to `target` in place (RFC 7386).
pub fn apply(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(patch_map) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            let target_map = target.as_object_mut().expect("just ensured object");
            for (key, patch_val) in patch_map {
                if patch_val.is_null() {
                    target_map.remove(key);
                } else {
                    let entry = target_map.entry(key.clone()).or_insert(Value::Null);
                    apply(entry, patch_val);
                }
            }
        }
        other => *target = other.clone(),
    }
}

/// Compute the minimal merge patch that transforms `old` into `new`.
///
/// Returns [`Value::Null`] when the two are already equal, so callers can cheaply
/// skip empty broadcasts.
pub fn diff(old: &Value, new: &Value) -> Value {
    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            let mut patch = Map::new();
            // Changed or added keys.
            for (key, new_val) in new_map {
                match old_map.get(key) {
                    Some(old_val) if old_val == new_val => {}
                    Some(old_val) => {
                        let sub = diff(old_val, new_val);
                        // A recursive object diff may be empty if nothing changed.
                        if !sub.is_null() {
                            patch.insert(key.clone(), sub);
                        }
                    }
                    None => {
                        patch.insert(key.clone(), new_val.clone());
                    }
                }
            }
            // Removed keys become explicit nulls.
            for key in old_map.keys() {
                if !new_map.contains_key(key) {
                    patch.insert(key.clone(), Value::Null);
                }
            }
            if patch.is_empty() {
                Value::Null
            } else {
                Value::Object(patch)
            }
        }
        _ if old == new => Value::Null,
        _ => new.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn apply_merges_nested_objects() {
        let mut target = json!({"car": {"44": {"speed": 100, "gear": 3}}});
        apply(&mut target, &json!({"car": {"44": {"speed": 280}}}));
        assert_eq!(target, json!({"car": {"44": {"speed": 280, "gear": 3}}}));
    }

    #[test]
    fn apply_null_deletes_key() {
        let mut target = json!({"a": 1, "b": 2});
        apply(&mut target, &json!({"b": null}));
        assert_eq!(target, json!({"a": 1}));
    }

    #[test]
    fn apply_replaces_arrays_wholesale() {
        let mut target = json!({"log": [1, 2]});
        apply(&mut target, &json!({"log": [1, 2, 3]}));
        assert_eq!(target, json!({"log": [1, 2, 3]}));
    }

    #[test]
    fn diff_is_null_when_equal() {
        let v = json!({"a": {"b": 1}});
        assert!(diff(&v, &v).is_null());
    }

    #[test]
    fn diff_emits_only_changed_keys() {
        let old = json!({"a": 1, "b": {"c": 2, "d": 3}});
        let new = json!({"a": 1, "b": {"c": 9, "d": 3}});
        assert_eq!(diff(&old, &new), json!({"b": {"c": 9}}));
    }

    #[test]
    fn diff_then_apply_round_trips() {
        let old = json!({"a": 1, "b": {"c": 2}, "e": 5});
        let new = json!({"a": 1, "b": {"c": 3, "f": 4}});
        let patch = diff(&old, &new);
        let mut reconstructed = old.clone();
        apply(&mut reconstructed, &patch);
        assert_eq!(reconstructed, new);
    }
}
