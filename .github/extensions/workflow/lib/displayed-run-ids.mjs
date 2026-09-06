/**
 * Validate the identifiers used by displayed-run mutations.
 *
 * These values are also used as sidecar URL components and cache keys, so
 * whitespace-only identifiers must be rejected at the route boundary.
 */
export function readDisplayedRunIds(body) {
  if (!body || typeof body !== 'object') return null;
  const briefId = typeof body.briefId === 'string' ? body.briefId.trim() : '';
  const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
  if (!briefId || !runId) return null;
  return { briefId, runId };
}
