// RFC 7386 JSON Merge Patch — the client half of the delta protocol.
//
// Returns a NEW object, cloning only the branches that changed and sharing all
// untouched subtrees by reference. That reference stability is what lets React
// panels reading an unchanged slice skip re-rendering.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function mergePatch(target: Any, patch: Any): Any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  const base: Record<string, Any> =
    target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) {
      delete base[key];
    } else {
      base[key] = mergePatch(base[key], value);
    }
  }
  return base;
}
