/**
 * Recursive deep-merge for plain JSON-like objects.
 *
 * Used by the brief loader to layer overrides on top of per-type defaults.
 * Semantics, intentionally narrow:
 *  - Plain objects merge per-key. Override keys win when both sides have one.
 *  - Arrays REPLACE — they are never concatenated. An override's array fully
 *    replaces the defaults' array (this matters for `references`, where an
 *    author who supplies references almost always wants only those).
 *  - All other JSON-serialisable scalars (strings, numbers, booleans, null)
 *    are taken from the override side if present.
 *
 * Non-JSON values (functions, class instances, Dates, RegExps, undefined)
 * are NOT supported: the helper clones via JSON round-trip, which silently
 * drops functions and converts class instances to plain objects. Briefs
 * and per-type defaults are authored as YAML/JSON, so this is fine in
 * practice — but if the merge ever needs to handle richer values, swap
 * `cloneJson` for `structuredClone`.
 *
 * Inputs are treated as immutable; the merged result is a fresh structure.
 */
export declare function deepMergeDefaults<T extends Record<string, unknown>>(
  defaults: T,
  override: Partial<T> | undefined,
): T;
//# sourceMappingURL=deep-merge.d.ts.map
