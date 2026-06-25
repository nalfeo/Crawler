/**
 * Shared request-timeout helpers for the Azure providers.
 *
 * Every provider (`azure-openai`, `azure-vision`, `azure-chat`,
 * `azure-chat-synth`) issues a single `fetch` with no upper time bound. A hung
 * Azure call — or a black-holed network — therefore blocks `generateOne`, and
 * with it the sidecar's *synchronous* generate request, indefinitely. That is
 * the silent "stuck generating forever" failure mode operators hit.
 *
 * Wrapping each request in `AbortSignal.timeout(ms)` turns an unbounded hang
 * into a fast, typed failure: the provider surfaces it as a (retryable)
 * `network`-kind error with a clear message instead of never returning.
 *
 * Pure + dependency-free so the parsing and detection logic is unit-testable.
 */

/** Default per-request ceiling. Image generation is the slow path. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

/** Floor below which an override is treated as a misconfiguration and ignored. */
export const MIN_PROVIDER_TIMEOUT_MS = 1_000;

/**
 * Resolve the per-request timeout (ms) from the environment.
 *
 * Reads `SPRITES_PROVIDER_TIMEOUT_MS`; falls back to `fallback` when the var is
 * unset, blank, non-numeric, or below {@link MIN_PROVIDER_TIMEOUT_MS}. A bad
 * value never silently disables the timeout — that would re-introduce the
 * exact hang this helper exists to prevent.
 */
export function resolveProviderTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): number {
  const raw = env['SPRITES_PROVIDER_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_PROVIDER_TIMEOUT_MS) return fallback;
  return Math.floor(n);
}

/**
 * True when a thrown error is the abort raised by `AbortSignal.timeout()`.
 *
 * `AbortSignal.timeout()` aborts `fetch` with a `DOMException` named
 * `'TimeoutError'`. Some runtimes surface a generic `'AbortError'` instead; the
 * only signal these providers attach is the timeout one, so treating both as a
 * timeout is safe and avoids runtime-specific brittleness.
 */
export function isTimeoutAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('name' in err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Build the human-readable message for a provider request that timed out.
 * `label` names the call site (e.g. `'Azure images/edits'`).
 */
export function providerTimeoutMessage(label: string, timeoutMs: number): string {
  return (
    `${label} timed out after ${timeoutMs}ms with no response. The request was ` +
    `aborted and may be retried. If long calls are expected, raise ` +
    `SPRITES_PROVIDER_TIMEOUT_MS.`
  );
}
