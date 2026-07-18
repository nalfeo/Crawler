function assertAcyclic(value: unknown, stack: Set<object>): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (stack.has(value)) {
    throw new Error('canonicalJson: circular references are not supported');
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) {
        assertAcyclic(entry, stack);
      }
      return;
    }

    for (const key of Object.keys(value as object)) {
      assertAcyclic((value as Record<string, unknown>)[key], stack);
    }
  } finally {
    stack.delete(value);
  }
}

function sortedReplacer(_key: string, val: unknown): unknown {
  if (val === undefined) {
    throw new Error('canonicalJson: undefined values are not permitted in fingerprint input');
  }
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as object).sort()) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return val;
}

/**
 * Canonical JSON with lexicographically sorted object keys and stable array order.
 *
 * This intentionally mirrors `JSON.stringify` semantics for non-finite numbers and
 * non-plain objects (except for rejecting circular refs and undefined values).
 */
export function canonicalJson(value: unknown): string {
  assertAcyclic(value, new Set());
  const serialized = JSON.stringify(value, sortedReplacer);
  if (serialized === undefined) {
    throw new Error('canonicalJson: value is not JSON-serializable');
  }
  return serialized;
}
