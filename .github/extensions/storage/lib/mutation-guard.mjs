/**
 * mutation-guard — the SAFETY-CRITICAL decision logic for the DESTRUCTIVE
 * archive/delete routes, extracted from `extension.mjs` so it can be unit-tested.
 *
 * `extension.mjs` does a top-level `await joinSession(...)` (a live-session side
 * effect on import), so it cannot be imported from a test. Without this module
 * the token → validate-keys → health-gate ordering that stands between the iframe
 * and an IRREVERSIBLE Azure mutation would be entirely uncovered — a one-line
 * deletion of the health gate would pass CI green. Here the whole decision is a
 * pure, dependency-injected function whose ordering and refusals are asserted
 * deterministically (see `tests/mutation-guard.test.mjs`).
 *
 * These guards are STRICTER than the sidecar's own `/api/storage/*` routes and
 * than the monolith's path — never looser (project rule #12).
 *
 * @module storage/lib/mutation-guard
 */

import { validateStorageKeys } from './storage-client.mjs';

/**
 * Gate 1 — per-instance mutation token. Returns a 403 route result when the
 * header is missing/empty/mismatched, else `null` (pass).
 * @param {unknown} provided value of the `x-storage-mutation-token` header
 * @param {string} expected the instance's minted token
 * @returns {{ status: number, json: object } | null}
 */
export function mutationTokenError(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0 || provided !== expected) {
    return {
      status: 403,
      json: { error: 'forbidden', message: 'Missing or invalid mutation token.' },
    };
  }
  return null;
}

/**
 * Gate 2 — key validation (mirrors the sidecar's `safeJoin` parse). Returns a
 * 400 route result carrying `invalidKeys` when the batch is empty or any key is
 * malformed / out-of-scope, else `null` (pass). Archive passes `allowArchive:false`
 * (active-only, matching the monolith); delete passes `allowArchive:true`.
 * @param {unknown} keys
 * @param {{ allowArchive?: boolean }} [options]
 * @returns {{ status: number, json: object } | null}
 */
export function mutationKeysError(keys, options = {}) {
  const validation = validateStorageKeys(keys, options);
  if (!validation.ok) {
    return {
      status: 400,
      json: {
        error: 'invalid-keys',
        message: validation.message,
        invalidKeys: validation.invalidKeys,
      },
    };
  }
  return null;
}

/**
 * Gate 3 — sidecar health re-probe. Returns a 409 route result unless the sidecar
 * is `up` for THIS repo, else `null` (pass). `verb` ('archive' | 'delete') is only
 * used to phrase the refusal message identically to the monolith-era routes.
 * @param {{ state?: string } | null | undefined} health
 * @param {string} [verb]
 * @returns {{ status: number, json: object } | null}
 */
export function sidecarHealthError(health, verb = 'mutate') {
  if (!health || health.state !== 'up') {
    return {
      status: 409,
      json: {
        error: 'sidecar-degraded',
        message: `Sidecar is not healthy for this repo; refusing to ${verb}.`,
      },
    };
  }
  return null;
}

/**
 * Map a `readJsonBody` failure to a `{ status, json }` route result (413 for an
 * oversized body, else 400). Shared by the destructive routes and `/api/enrich`.
 * @param {{ statusCode?: number, message?: string } | unknown} err
 * @returns {{ status: number, json: object }}
 */
export function bodyErrorResult(err) {
  const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
  return { status, json: { error: 'bad-request', message: String(err?.message ?? err) } };
}

/**
 * Compose the destructive-op decision in the one safety-critical order that must
 * never regress:
 *
 *   token → (read body) → validate keys → health-gate → execute
 *
 * Every gate short-circuits to its route result, so a rejected request NEVER
 * reaches a later gate — in particular a bad token or malformed key batch never
 * probes health or calls `execute`, and a degraded sidecar never calls `execute`.
 * All I/O (`readBody`, `probeHealth`, `execute`) is injected, so the ordering and
 * every refusal are deterministically unit-testable with spies.
 *
 * @param {object} args
 * @param {unknown} args.token             `x-storage-mutation-token` header value
 * @param {string} args.expectedToken      the instance's minted token
 * @param {() => Promise<Record<string, unknown>>} args.readBody  size-capped JSON body reader (may throw `.statusCode`)
 * @param {boolean} args.allowArchive      true for delete (both scopes), false for archive (active-only)
 * @param {() => Promise<{ state?: string }>} args.probeHealth    sidecar repo-match health probe
 * @param {(keys: string[]) => Promise<object>} args.execute      the actual mutation (archiveRuns / deleteRuns)
 * @param {string} [args.verb]             'archive' | 'delete' — for error phrasing only
 * @returns {Promise<{ status?: number, json: object }>}
 */
export async function decideMutation({
  token,
  expectedToken,
  readBody,
  allowArchive,
  probeHealth,
  execute,
  verb,
}) {
  const label = verb || 'mutation';

  const tokErr = mutationTokenError(token, expectedToken);
  if (tokErr) return tokErr;

  let body;
  try {
    body = await readBody();
  } catch (err) {
    return bodyErrorResult(err);
  }

  const keys = Array.isArray(body?.keys) ? body.keys : [];
  const keysErr = mutationKeysError(keys, { allowArchive: allowArchive === true });
  if (keysErr) return keysErr;

  const health = await probeHealth();
  const healthErr = sidecarHealthError(health, label);
  if (healthErr) return healthErr;

  try {
    const result = await execute(keys);
    return { json: result };
  } catch (err) {
    return {
      status: 502,
      json: { error: `${label}-failed`, message: String(err?.message ?? err) },
    };
  }
}
