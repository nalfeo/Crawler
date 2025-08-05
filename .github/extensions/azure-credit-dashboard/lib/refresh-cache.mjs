const CACHE_TTL_MS = 120_000;

/**
 * Creates a refresh-entry helper with injectable query function and clock so the
 * cache boundary, in-flight deduplication, failure cleanup, and abort behaviour
 * can be covered by unit tests without real Azure calls.
 *
 * @param {(config: object, signal: AbortSignal) => Promise<object>} queryFn
 * @param {() => number} [nowFn]
 */
export function createRefreshCache(queryFn, nowFn = () => Date.now()) {
  return async function refreshEntry(entry) {
    const ageMs = nowFn() - new Date(entry.data.updatedAt).getTime();
    if (ageMs < CACHE_TTL_MS) {
      return entry.data;
    }
    if (!entry.refreshPromise) {
      entry.refreshController = new AbortController();
      entry.refreshPromise = queryFn(entry.config, entry.refreshController.signal)
        .then((data) => {
          entry.data = data;
          return data;
        })
        .finally(() => {
          entry.refreshController = undefined;
          entry.refreshPromise = undefined;
        });
    }
    return entry.refreshPromise;
  };
}
