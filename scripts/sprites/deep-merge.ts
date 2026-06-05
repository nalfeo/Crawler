/**
 * Recursive deep-merge for plain JSON-like objects.
 *
 * Used by the brief loader to layer overrides on top of per-type defaults.
 * Semantics, intentionally narrow:
 *  - Plain objects merge per-key. Override keys win when both sides have one.
 *  - Arrays REPLACE — they are never concatenated. An override's array fully
 *    replaces the defaults' array (this matters for `references`, where an
 *    author who supplies references almost always wants only those).
 *  - All other values (scalars, null, functions, class instances) are taken
 *    from the override side if present.
 *
 * Inputs are treated as immutable; the merged result is a fresh structure.
 */
export function deepMergeDefaults<T extends Record<string, unknown>>(
  defaults: T,
  override: Partial<T> | undefined,
): T {
  if (override === undefined) return cloneJson(defaults);
  const result: Record<string, unknown> = cloneJson(defaults) as Record<string, unknown>;
  for (const [key, ovValue] of Object.entries(override)) {
    if (ovValue === undefined) continue;
    const dfValue = result[key];
    if (isPlainObject(dfValue) && isPlainObject(ovValue)) {
      result[key] = deepMergeDefaults(
        dfValue as Record<string, unknown>,
        ovValue as Record<string, unknown>,
      );
    } else {
      result[key] = cloneJson(ovValue);
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  // structuredClone would also work but pulls in DOM lib types in older Node
  // configs; JSON round-trip is sufficient for brief/defaults shapes (no Dates,
  // RegExps, undefineds, etc.) and keeps this module dependency-free.
  return JSON.parse(JSON.stringify(value)) as T;
}
