/**
 * run-view-cache.mjs — cache-first / background-revalidate orchestration for
 * the Workflow canvas's per-run sidecar view (candidates + sheets + slice-map
 * + health).
 *
 * WHY THIS EXISTS
 * ----------------
 * The sidecar's `CachingRunStore` (scripts/sprites/store/caching-store.ts)
 * already caches individual blob GETs read-through, but its `list()` (which
 * backs `GET /api/runs`) always makes a LIVE Azure call on every request — by
 * design, so an external Azure writer can never leave a stale "fresh" listing
 * cached. That means the FIRST network hop out of a freshly-opened canvas
 * instance can still take well over a second even when everything else is
 * warmed, which would otherwise force a blocking loading spinner on every open.
 *
 * This module removes that hop from the initial paint for any run the process
 * has ever successfully rendered: a warmed run view is replayed synchronously
 * (`stale: true`) with NO awaited network call, while a fresh copy is fetched
 * in the background and delivered via `onFresh` once ready. The cache is keyed
 * module-wide (by `{briefId, runId}`), not per canvas instance, so re-opening
 * the SAME run in a brand-new instance/surface — a different `instanceId`
 * entirely — still paints instantly from the shared snapshot: this is the
 * "same run warmed in another surface" contract.
 *
 * A cold miss (a target that has never been rendered) is the ONLY path that
 * awaits the network — that is the sole case that may show a blocking
 * spinner.
 *
 * STALENESS GUARD
 * ----------------
 * A background revalidation can complete well after the caller has since
 * moved on (picked a different run/sheet, or the canvas closed). `isCurrent()`
 * is re-evaluated at COMPLETION time (not just when the revalidation was
 * scheduled), so a slow/late fetch can never clobber a newer selection by
 * pushing its (now-stale) result — see `resolveCacheFirstState`'s doc comment.
 *
 * Fully dependency-injected (no fs/network/timer imports) so this is
 * unit-testable end-to-end with fake, manually-resolved promises and no live
 * sidecar or wall-clock waiting.
 *
 * @module workflow/run-view-cache
 */

/**
 * Create an empty, module-scope-shareable cache. Callers own the key shape
 * (Workflow uses `${briefId}::${runId}`).
 * @returns {{
 *   get: (key: string) => unknown | null,
 *   set: (key: string, value: unknown) => void,
 *   delete: (key: string) => void,
 *   has: (key: string) => boolean,
 * }}
 */
export function createRunViewCache() {
  const store = new Map();
  return {
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => {
      store.set(key, value);
    },
    delete: (key) => {
      store.delete(key);
    },
    has: (key) => store.has(key),
  };
}

/**
 * Resolve the state to serve THIS caller right now, applying the cache-first /
 * background-revalidate policy described in the module doc comment.
 *
 * @param {{
 *   cache: ReturnType<typeof createRunViewCache>,
 *   key: string | null,
 *   liveFetch: () => Promise<object>,
 *   isCurrent: () => boolean,
 *   onFresh: (fresh: object) => void | Promise<void>,
 *   onRevalidateError?: (err: unknown) => void,
 *   isRevalidating: () => boolean,
 *   setRevalidating: (value: boolean) => void,
 *   deriveWriteKey?: (fresh: object) => string | null,
 * }} args
 * @returns {Promise<object>} either the cached snapshot (`stale: true`),
 *   returned WITHOUT awaiting `liveFetch`, or the live result (`stale: false`)
 *   on a cold miss.
 *
 * `deriveWriteKey(fresh)` lets the caller compute the CACHE-WRITE key from the
 * live result itself, separately from the READ key (`key`). This matters when
 * `key` is only a best-effort GUESS at what a fetch with no explicit target
 * will resolve to (e.g. "whatever the caller last viewed" used to seed a bare
 * open with no requested run) — the live fetch may resolve to a DIFFERENT run
 * (e.g. "auto-select latest" picks something else), and writing that result
 * under the guessed read-key would corrupt an unrelated cache entry. Defaults
 * to `() => key` (write under the same key that was read) when omitted.
 */
export async function resolveCacheFirstState(args) {
  const {
    cache,
    key,
    liveFetch,
    isCurrent,
    onFresh,
    onRevalidateError,
    isRevalidating,
    setRevalidating,
    deriveWriteKey = () => key,
  } = args;

  const cached = key ? cache.get(key) : null;

  if (cached) {
    if (!isRevalidating()) {
      setRevalidating(true);
      // Fire-and-forget: intentionally NOT awaited — the cache-first response
      // below returns before this settles. `.then`/`.catch`/`.finally` run on a
      // later microtask/turn regardless of how long `liveFetch` takes.
      liveFetch()
        .then((fresh) => {
          const writeKey = deriveWriteKey(fresh);
          if (writeKey) cache.set(writeKey, fresh);
          if (isCurrent()) return onFresh(fresh);
          return undefined;
        })
        .catch((err) => onRevalidateError?.(err))
        .finally(() => setRevalidating(false));
    }
    // A revalidation is already in flight for this key (or was just started
    // above) — serve the (possibly still-stale) snapshot rather than piling up
    // a second concurrent live fetch.
    return { ...cached, stale: true };
  }

  // Cold miss: nothing to paint yet — this is the ONLY path that awaits the
  // network, and only for a target that has never been viewed before.
  const fresh = await liveFetch();
  const writeKey = deriveWriteKey(fresh);
  if (writeKey) cache.set(writeKey, fresh);
  return { ...fresh, stale: false };
}

/**
 * Apply a freshly-resolved background revalidation, guarding against a
 * selection/version change that happens DURING an async re-read of the
 * "static" half of the view model that the caller's `onFresh` performs
 * before mutating/pushing.
 *
 * WHY THIS EXISTS
 * ----------------
 * `resolveCacheFirstState`'s own `isCurrent()` re-check (above) only covers
 * the window up to the moment `onFresh` is invoked. Workflow's actual
 * `onFresh` then performs a SECOND async step of its own — re-reading the
 * static half of the view model (`getStatic(entry)`) right before composing
 * state, because a background revalidation can complete AFTER a
 * static-mutating action (e.g. accept-and-queue) has already
 * invalidated/rebuilt that static snapshot, and `isCurrent()` alone does not
 * track that (accept does not bump `selectionVersion`). But the inverse race
 * also exists: the entry's selection can change (bumping `selectionVersion`,
 * e.g. via a user click) WHILE that second `getStatic` await is in flight.
 * The `isCurrent()` check made just before this call started has by then
 * gone stale — nothing re-verified it, so the revalidation would still
 * mutate `entry.selected` and push a now-superseded "fresh" state over a
 * newer selection made in the meantime.
 *
 * This helper re-checks currentness with the caller-supplied `isCurrent`
 * IMMEDIATELY after the async re-read and before EITHER mutating or
 * pushing, and does neither when superseded.
 *
 * Fully dependency-injected (no fs/network/timer imports) so this is
 * unit-testable end-to-end with fake, manually-resolved promises.
 *
 * @param {{
 *   isCurrent: () => boolean,
 *   getStatic: () => Promise<unknown>,
 *   applyMutation: (currentStat: unknown) => void,
 *   pushState: (currentStat: unknown) => void | Promise<void>,
 * }} args
 * @returns {Promise<boolean>} `true` if the mutation/push were applied,
 *   `false` if superseded (no-op — neither `applyMutation` nor `pushState`
 *   is called).
 */
export async function applyFreshRevalidation({ isCurrent, getStatic, applyMutation, pushState }) {
  const currentStat = await getStatic();
  // Re-check AFTER the async re-read, right before any mutation/push — see
  // the doc comment above for why the check made when this call started is
  // not sufficient on its own.
  if (!isCurrent()) return false;
  applyMutation(currentStat);
  await pushState(currentStat);
  return true;
}
