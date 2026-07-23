/**
 * CachingRunStore — the authoritative, cross-session read-through cache in
 * front of a remote RunStore (Azure Blob Storage in production).
 *
 * This wrapper is the SINGLE place the sprite pipeline caches remote resources.
 * The devtools sidecar constructs it once and serves every extension/canvas
 * proxy from it, so there is exactly one warmed physical copy per machine
 * regardless of how many worktrees, sessions, or extensions are reading. (The
 * per-extension image caches that used to exist are gone — see ADR 0065.)
 *
 * What is cached
 * --------------
 * Every blob artifact category is cached: downloaded sheets, raw/processed
 * variants, brief snapshots, metadata, judge output, scorecards, summaries, and
 * derived previews. The ONE exclusion is the mutable, ETag-controlled workflow
 * queue document (`workflow-state/queue.json`) — caching it read-through would
 * serve a stale concurrency token and break optimistic locking.
 *
 * Semantics (ADR 0065; list-snapshot semantics updated by
 * docs/knowledge/adr/2026-07-22-sprite-list-cache-swr.md)
 * --------------------
 *  - **Blob artifacts**: cache-first `get`/`has`; write-through `put`
 *    (authoritative inner write first, THEN cache replace); `remove` invalidates
 *    the cache before the authoritative delete so a failed delete can never
 *    leave a stale hit. Same-process mutations stay coherent. Artifacts are NOT
 *    assumed immutable — a `put` replaces the cached key.
 *  - **List snapshots (stale-while-revalidate)**: when a warmed snapshot's
 *    epoch matches the current list-invalidation epoch, `list` returns it
 *    IMMEDIATELY — no remote round-trip — and schedules a deduped, best-effort
 *    background refresh (`inner.list` + snapshot rewrite, guarded by the same
 *    epoch-stable check the blocking path already used). A same-process `put`/
 *    `remove` bumps the epoch first, so the very next `list` for that prefix
 *    still blocks on the remote until it resyncs — same-process
 *    read-your-writes coherence is preserved. Only a snapshot with NO epoch
 *    match (never loaded, or invalidated by a same-process mutation) takes the
 *    original blocking path. The accepted trade-off: a run mutated by a writer
 *    that bypasses this cache entirely (so the shared epoch is never bumped)
 *    may appear one background-refresh late, in exchange for instant
 *    cross-process/worktree cold-open listings. Callers that cannot tolerate
 *    that staleness — any workflow that enumerates keys via `list` and then
 *    acts on exactly that set, e.g. archive/delete/clear-store — MUST pass
 *    `{ authoritative: true }` (see {@link ListOptions}) to unconditionally
 *    skip the fast path and block on a fresh remote listing instead; the
 *    result still refreshes the snapshot on success so later fast-path reads
 *    benefit. The background refresh only purges (everything the
 *    authoritative `remove()` path would have cleared for a removed key —
 *    derived HTTP-route response caches, the blob-cache entry (mutation
 *    token bumped first, exactly like `remove()`, so a concurrent read-through
 *    fill racing the purge can't resurrect it), and that run's derived
 *    brief/slice-map caches — for keys the remote no longer reports) AFTER
 *    its own snapshot rewrite is confirmed written — a failed best-effort
 *    write leaves the old snapshot and everything it pointed at untouched, so
 *    a still-served listing never points at already-evicted data. Offline
 *    calls return the warmed snapshot with zero remote reads.
 *  - **Offline mode**: when Azure is forced unavailable, reads are served
 *    entirely from the cache and the inner store is NEVER contacted, so a warmed
 *    worktree loads exact bytes and listings with zero Azure read operations.
 *
 * Brief and slice-map routes also use this cache's derived-resource namespace
 * for exact response snapshots; listings come from pinned list snapshots.
 */

import { WORKFLOW_STATE_KEY } from '../sidecar/workflow-state.js';
import type { SharedResourceCache } from './shared-cache.js';
import { StoreNotFoundError, type ListOptions, type RunStore } from './types.js';

/** cacache key prefixes keep blob artifacts and list snapshots in disjoint namespaces. */
const BLOB_PREFIX = 'blob:';
const LIST_PREFIX = 'list:';
const DERIVED_PREFIX = 'derived:';

/**
 * Default cacheability predicate: cache every key EXCEPT the mutable,
 * ETag-controlled workflow queue document.
 */
export function isCacheableKey(key: string): boolean {
  return key !== WORKFLOW_STATE_KEY;
}

/** Persisted list-snapshot shape: the epoch it was captured at plus the keys. */
interface ListSnapshot {
  readonly epoch: string;
  readonly keys: readonly string[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CachingRunStoreOptions {
  /** Store to delegate to (Azure in production; LocalRunStore in tests). */
  readonly inner: RunStore;
  /** Shared content-addressable cache (namespaced per remote identity). */
  readonly cache: SharedResourceCache;
  /** Which keys are cacheable. Defaults to {@link isCacheableKey}. */
  readonly shouldCache?: (key: string) => boolean;
  /**
   * When true, reads are served ONLY from the cache and the inner store is never
   * contacted (Azure forced unavailable). Writes still target the inner store.
   */
  readonly offline?: boolean;
}

export interface DerivedResourceCache {
  getCachedResource(key: string): Promise<Buffer | null>;
  setCachedResource(key: string, data: Buffer): Promise<void>;
  /** Write only if absent: used for immutable per-run snapshots and read-through fills. */
  setIfAbsentCachedResource(key: string, data: Buffer): Promise<void>;
}

export function hasDerivedResourceCache(store: RunStore): store is RunStore & DerivedResourceCache {
  const candidate = store as Partial<DerivedResourceCache>;
  return (
    typeof candidate.getCachedResource === 'function' &&
    typeof candidate.setCachedResource === 'function' &&
    typeof candidate.setIfAbsentCachedResource === 'function'
  );
}

export class CachingRunStore implements RunStore, DerivedResourceCache {
  readonly backend: RunStore['backend'];
  private readonly inner: RunStore;
  private readonly cache: SharedResourceCache;
  private readonly shouldCache: (key: string) => boolean;
  private readonly offline: boolean;
  /**
   * Per-key in-flight Promise: serializes concurrent same-key `put` calls so
   * that the cache always reflects the last-committed inner write. Without this
   * serialization, writer A (v1) could cache v1 AFTER writer B (v2) already
   * cached v2, leaving the cache stale relative to the authoritative store.
   *
   * Map entries are removed immediately after each put completes (see the
   * `finally` block in `put()`), so the map is bounded by the number of
   * concurrently in-flight puts for distinct keys. The sprite pipeline has a
   * small, bounded set of run artifact keys per run, so this does not grow
   * unboundedly in practice.
   */
  private readonly putInFlight = new Map<string, Promise<void>>();

  /**
   * Per-snapshot-key in-flight Promise: dedupes concurrent stale-while-
   * revalidate background refreshes so a burst of `list()` calls against the
   * same prefix triggers at most one `inner.list` per refresh window. Entries
   * are removed once the refresh settles (see `scheduleListRefresh`), so this
   * map is bounded by the number of distinct prefixes currently refreshing.
   */
  private readonly listRefreshInFlight = new Map<string, Promise<void>>();

  constructor(options: CachingRunStoreOptions) {
    this.inner = options.inner;
    this.backend = options.inner.backend;
    this.cache = options.cache;
    this.shouldCache = options.shouldCache ?? isCacheableKey;
    this.offline = options.offline ?? false;
  }

  async put(key: string, data: Buffer): Promise<void> {
    // Serialize same-key writes: wait for any in-flight put on this key to
    // complete first, then execute ours. This prevents a stale v1 from
    // overwriting a newer v2 that committed to both inner and cache first.
    const previous = this.putInFlight.get(key);
    const work = (async () => {
      if (previous !== undefined) await previous.catch(() => {});
      await this.invalidateDerivedResources(key);
      if (this.shouldCache(key)) {
        const cacheKey = `${BLOB_PREFIX}${key}`;
        // Snapshot the token BEFORE the authoritative write so we can detect a
        // cross-instance writer that committed while our inner.put was in-flight.
        // If any other process bumps the token in that window, our data is stale
        // relative to theirs and we must not overwrite their fresher cache entry.
        const tokenSnapshot = this.cache.readMutationToken(cacheKey);
        // Authoritative write first; only mirror into the cache once it succeeds.
        await this.inner.put(key, data);
        // Guard: only publish to cache when no concurrent writer claimed the key.
        if (this.cache.readMutationToken(cacheKey) === tokenSnapshot) {
          const publishToken = this.cache.bumpMutationToken(cacheKey);
          const cacheWriteOk = await this.cache.set(cacheKey, data, undefined, publishToken);
          if (!cacheWriteOk && this.cache.readMutationToken(cacheKey) === publishToken) {
            await this.cache.remove(cacheKey);
            this.cache.bumpMutationToken(cacheKey);
          }
        } else {
          // A concurrent cross-instance writer published while our inner.put was
          // in-flight. Their cache content may pre-date our authoritative commit
          // (e.g. they committed to the inner store BEFORE us but published to
          // cache BEFORE our post-put check). Invalidate so future reads fall
          // through to the authoritative store rather than serving stale bytes.
          await this.cache.remove(cacheKey);
          this.cache.bumpMutationToken(cacheKey);
        }
      } else {
        // Non-cacheable key: just do the authoritative write.
        await this.inner.put(key, data);
      }
      // A new/changed blob may change what listings return — invalidate snapshots.
      this.cache.bumpEpoch();
    })();
    this.putInFlight.set(key, work);
    try {
      await work;
    } finally {
      // Only evict if our promise is still current (a later put may have replaced it).
      if (this.putInFlight.get(key) === work) {
        this.putInFlight.delete(key);
      }
    }
  }

  async get(key: string): Promise<Buffer> {
    if (!this.shouldCache(key)) {
      if (this.offline) throw new StoreNotFoundError(key);
      return this.inner.get(key);
    }
    const cacheKey = `${BLOB_PREFIX}${key}`;
    const hit = await this.cache.get(cacheKey);
    if (hit !== null) return hit.data;
    if (this.offline) throw new StoreNotFoundError(key);
    const expectedMutationToken = this.cache.readMutationToken(cacheKey);
    const data = await this.inner.get(key);
    // Use setIfAbsent for read-through fills: if a concurrent put already
    // cached the authoritative value for this key (same or cross instance),
    // do not overwrite it with this potentially stale fill.
    await this.cache.setIfAbsent(cacheKey, data, undefined, expectedMutationToken);
    return data;
  }

  async has(key: string): Promise<boolean> {
    if (this.shouldCache(key) && (await this.cache.has(`${BLOB_PREFIX}${key}`))) return true;
    if (this.offline) return false;
    return this.inner.has(key);
  }

  async list(prefix: string, options?: ListOptions): Promise<readonly string[]> {
    const snapshotKey = `${LIST_PREFIX}${prefix}`;
    const snapshot = await this.readSnapshot(snapshotKey);

    if (this.offline) {
      if (snapshot !== null) return snapshot.keys; // best-effort warmed fallback
      throw new StoreNotFoundError(`${LIST_PREFIX}${prefix} (offline, no snapshot)`);
    }

    // Stale-while-revalidate fast path: an epoch-fresh warmed snapshot is
    // returned immediately (no remote round-trip) while a deduped background
    // refresh brings the snapshot up to date. A same-process put/remove bumps
    // the epoch first, so this only fires when nothing in THIS process has
    // invalidated the prefix since the snapshot was captured — the first-ever
    // load (no snapshot) and any post-mutation reload still take the blocking
    // path below, unchanged. Callers that need a guaranteed-fresh listing to
    // enumerate-then-act (archive/delete/clear-store workflows) pass
    // `{ authoritative: true }` to unconditionally skip this fast path.
    if (
      options?.authoritative !== true &&
      snapshot !== null &&
      snapshot.epoch === this.cache.readEpoch()
    ) {
      this.scheduleListRefresh(prefix, snapshotKey, snapshot.keys);
      return snapshot.keys;
    }

    try {
      const epochBefore = this.cache.readEpoch();
      const keys = await this.inner.list(prefix);
      const epochAfter = this.cache.readEpoch();
      if (epochBefore === epochAfter) {
        await this.cache.set(
          snapshotKey,
          Buffer.from(JSON.stringify({ epoch: epochAfter, keys } satisfies ListSnapshot), 'utf8'),
          { crawlerPinned: true },
        );
      }
      return keys;
    } catch (err) {
      // Remote unavailable: fall back to a warmed snapshot if we have one; never
      // hide a real error behind an empty listing when we have nothing cached.
      if (snapshot !== null && snapshot.epoch === this.cache.readEpoch()) return snapshot.keys;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    await this.invalidateDerivedResources(key);
    // Invalidate first so an inner-remove failure never leaves a stale hit that
    // outlives the authoritative delete.
    if (this.shouldCache(key)) {
      const cacheKey = `${BLOB_PREFIX}${key}`;
      const cacheInvalidateOk = await this.cache.remove(cacheKey);
      if (!cacheInvalidateOk) this.cache.bumpMutationToken(cacheKey);
    }
    await this.inner.remove(key);
    if (this.shouldCache(key)) {
      const cacheKey = `${BLOB_PREFIX}${key}`;
      this.cache.bumpMutationToken(cacheKey);
      await this.cache.remove(cacheKey);
    }
    await this.removePerRunSnapshotOnRunRemoval(key);
    this.cache.bumpEpoch();
  }

  resolve(key: string): string {
    return this.inner.resolve(key);
  }

  async getCachedResource(key: string): Promise<Buffer | null> {
    return (await this.cache.get(`${DERIVED_PREFIX}${key}`))?.data ?? null;
  }

  async setCachedResource(key: string, data: Buffer): Promise<void> {
    await this.cache.set(`${DERIVED_PREFIX}${key}`, data);
  }

  async setIfAbsentCachedResource(key: string, data: Buffer): Promise<void> {
    await this.cache.setIfAbsent(`${DERIVED_PREFIX}${key}`, data);
  }

  /**
   * Fire-and-forget background refresh for the stale-while-revalidate fast
   * path in `list()`. Deduped per snapshot key so a burst of reads against the
   * same prefix only triggers one `inner.list` call per refresh window; safe
   * to call unconditionally from `list()` since it no-ops if a refresh for
   * this key is already in flight.
   */
  private scheduleListRefresh(
    prefix: string,
    snapshotKey: string,
    previousKeys: readonly string[],
  ): void {
    if (this.listRefreshInFlight.has(snapshotKey)) return;
    const task = this.refreshListSnapshot(prefix, snapshotKey, previousKeys).catch(
      (err: unknown) => {
        // Never let a background refresh failure surface as an unhandled
        // rejection or reject a caller — the caller already got the stale
        // snapshot synchronously. Just log so the failure is observable.
        this.cache.logOperational(`list refresh failed for ${snapshotKey}: ${errMsg(err)}`);
      },
    );
    this.listRefreshInFlight.set(snapshotKey, task);
    void task.finally(() => {
      // Only evict if our promise is still current (a later refresh may have
      // already replaced it after this one was scheduled).
      if (this.listRefreshInFlight.get(snapshotKey) === task) {
        this.listRefreshInFlight.delete(snapshotKey);
      }
    });
  }

  /**
   * Performs the actual remote listing + snapshot rewrite for a background
   * refresh, mirroring the epoch-stable guard the blocking path already used
   * so a mutation racing the refresh can't publish an out-of-date snapshot.
   * Also purges, for every key the remote no longer reports, everything the
   * authoritative `remove()` path would have cleared: derived HTTP-route
   * response caches (brief/slice-map JSON, via `invalidateDerivedResources`),
   * the blob-cache entry, and that run's per-run brief-snapshot/
   * slice-map-fingerprint caches ("cache purging" — best-effort; a later
   * `put` self-heals if this ever misses).
   *
   * Purge only runs after a CONFIRMED snapshot rewrite (`cache.set` returned
   * true). `set()` is best-effort and can fail (full disk, lock contention);
   * purging entries whose only record of removal is a snapshot that never
   * actually got written would leave the old (still epoch-fresh, still
   * served) listing pointing at now-evicted data — the opposite of the
   * "snapshot correctness first" priority this refresh exists for.
   */
  private async refreshListSnapshot(
    prefix: string,
    snapshotKey: string,
    previousKeys: readonly string[],
  ): Promise<void> {
    const epochBefore = this.cache.readEpoch();
    const keys = await this.inner.list(prefix);
    const epochAfter = this.cache.readEpoch();
    if (epochBefore !== epochAfter) return; // a same-process mutation raced us; it already invalidated
    const snapshotWritten = await this.cache.set(
      snapshotKey,
      Buffer.from(JSON.stringify({ epoch: epochAfter, keys } satisfies ListSnapshot), 'utf8'),
      { crawlerPinned: true },
    );
    if (!snapshotWritten) return; // best-effort write failed: leave the old snapshot/blobs alone
    const freshKeys = new Set(keys);
    for (const removedKey of previousKeys) {
      if (!freshKeys.has(removedKey)) {
        // Mirrors the authoritative remove() path so a run deleted by another
        // process doesn't leave stale derived caches behind: cached HTTP route
        // responses (brief/slice-map JSON) first, then the blob-cache entry,
        // then that run's per-run brief-snapshot/slice-map-fingerprint caches.
        // Without invalidateDerivedResources here, a route handler's
        // cache-first fast path (server.ts getCachedResource) would keep
        // serving a stale `route/brief/<briefId>/<runId>` response forever
        // for a run Azure no longer reports.
        await this.invalidateDerivedResources(removedKey);
        const blobCacheKey = `${BLOB_PREFIX}${removedKey}`;
        // Bump the mutation token BEFORE removing, mirroring remove()'s own
        // tail exactly: a concurrent get() may have captured the pre-purge
        // token and be mid-flight on inner.get() for this same key. Without
        // the bump, that get()'s later setIfAbsent(..., expectedMutationToken)
        // call would still match and could resurrect the just-purged blob
        // into the cache with no future self-healing path (the diff-based
        // purge only catches a key's one-time previousKeys→freshKeys
        // transition, so it would never be reconsidered for removal again).
        this.cache.bumpMutationToken(blobCacheKey);
        await this.cache.remove(blobCacheKey);
        await this.removePerRunSnapshotOnRunRemoval(removedKey);
      }
    }
  }

  private async readSnapshot(snapshotKey: string): Promise<ListSnapshot | null> {
    const entry = await this.cache.get(snapshotKey);
    if (entry === null) return null;
    try {
      const parsed = JSON.parse(entry.data.toString('utf8')) as ListSnapshot;
      if (
        typeof parsed?.epoch === 'string' &&
        Array.isArray(parsed.keys) &&
        parsed.keys.every((k) => typeof k === 'string')
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null; // corrupt snapshot → miss
    }
  }

  private async invalidateDerivedResources(key: string): Promise<void> {
    if (key.startsWith('workflow-state/briefs/')) {
      const ok1 = await this.cache.removeByPrefix(`${DERIVED_PREFIX}route/brief/`);
      const ok2 = await this.cache.removeByPrefix(`${DERIVED_PREFIX}route/slice-map/`);
      // On failure the shared cache poisons affected keys so they are not served
      // from stale data; bump the epoch so listing snapshots are also invalidated.
      if (!ok1 || !ok2) this.cache.bumpEpoch();
      return;
    }

    const parts = key.split('/');
    if (parts.length !== 3) return;
    const [briefId, runId, filename] = parts;
    if (!briefId || !runId || !filename) return;
    const routePrefix = `${briefId}/${runId}`;
    if (filename === 'summary.json') {
      const ok1 = await this.cache.remove(`${DERIVED_PREFIX}route/brief/${routePrefix}`);
      const ok2 = await this.cache.removeByPrefix(
        `${DERIVED_PREFIX}route/slice-map/${routePrefix}/`,
      );
      if (!ok1 || !ok2) this.cache.bumpEpoch();
      return;
    }
    if (/^sheet-\d+\.png$/i.test(filename)) {
      // Use removeByPrefix (not exact remove) so both the unfingerprinted base key
      // and all fingerprinted variants (e.g. `latest:<fp>`, `sheet-1.png:<fp>`)
      // are cleared atomically. Leaving any fingerprinted key would allow a
      // cache-first read to return stale geometry from the old PNG.
      const ok1 = await this.cache.removeByPrefix(
        `${DERIVED_PREFIX}route/slice-map/${routePrefix}/latest`,
      );
      const ok2 = await this.cache.removeByPrefix(
        `${DERIVED_PREFIX}route/slice-map/${routePrefix}/${filename}`,
      );
      if (!ok1 || !ok2) this.cache.bumpEpoch();
    }
  }

  private async removePerRunSnapshotOnRunRemoval(key: string): Promise<void> {
    const parts = key.split('/');
    if (parts.length !== 3) return;
    const [briefId, runId, filename] = parts;
    if (!briefId || !runId || filename !== 'summary.json') return;
    await this.cache.remove(`${DERIVED_PREFIX}brief-snapshot/${briefId}/${runId}`);
    await this.cache.remove(`${DERIVED_PREFIX}slice-map-fingerprint/${briefId}/${runId}`);
  }
}
