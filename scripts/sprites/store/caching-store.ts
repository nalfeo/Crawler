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
 * Semantics (ADR 0065)
 * --------------------
 *  - **Blob artifacts**: cache-first `get`/`has`; write-through `put`
 *    (authoritative inner write first, THEN cache replace); `remove` invalidates
 *    the cache before the authoritative delete so a failed delete can never
 *    leave a stale hit. Same-process mutations stay coherent. Artifacts are NOT
 *    assumed immutable — a `put` replaces the cached key.
 *  - **List snapshots**: a successful online `list` refreshes a first-class,
 *    eviction-protected snapshot. Online calls still consult the remote so
 *    external Azure writers cannot leave a locally "fresh" snapshot stale.
 *    Offline calls return the warmed snapshot with zero remote reads.
 *  - **Offline mode**: when Azure is forced unavailable, reads are served
 *    entirely from the cache and the inner store is NEVER contacted, so a warmed
 *    worktree loads exact bytes and listings with zero Azure read operations.
 *
 * Brief and slice-map routes also use this cache's derived-resource namespace
 * for exact response snapshots; listings come from pinned list snapshots.
 */

import { WORKFLOW_STATE_KEY } from '../sidecar/workflow-state.js';
import type { SharedResourceCache } from './shared-cache.js';
import { StoreNotFoundError, type RunStore } from './types.js';

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
      // Authoritative write first; only mirror into the cache once it succeeds.
      await this.inner.put(key, data);
      if (this.shouldCache(key)) {
        await this.cache.set(`${BLOB_PREFIX}${key}`, data);
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
    const hit = await this.cache.get(`${BLOB_PREFIX}${key}`);
    if (hit !== null) return hit.data;
    if (this.offline) throw new StoreNotFoundError(key);
    const data = await this.inner.get(key);
    // Use setIfAbsent for read-through fills: if a concurrent put already
    // cached the authoritative value for this key (same or cross instance),
    // do not overwrite it with this potentially stale fill.
    await this.cache.setIfAbsent(`${BLOB_PREFIX}${key}`, data);
    return data;
  }

  async has(key: string): Promise<boolean> {
    if (this.shouldCache(key) && (await this.cache.has(`${BLOB_PREFIX}${key}`))) return true;
    if (this.offline) return false;
    return this.inner.has(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    const snapshotKey = `${LIST_PREFIX}${prefix}`;
    const snapshot = await this.readSnapshot(snapshotKey);

    if (this.offline) {
      if (snapshot !== null) return snapshot.keys; // best-effort warmed fallback
      throw new StoreNotFoundError(`${LIST_PREFIX}${prefix} (offline, no snapshot)`);
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
      await this.cache.remove(`${BLOB_PREFIX}${key}`);
    }
    await this.inner.remove(key);
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
      await this.cache.removeByPrefix(`${DERIVED_PREFIX}route/brief/`);
      await this.cache.removeByPrefix(`${DERIVED_PREFIX}route/slice-map/`);
      return;
    }

    const parts = key.split('/');
    if (parts.length !== 3) return;
    const [briefId, runId, filename] = parts;
    if (!briefId || !runId || !filename) return;
    const routePrefix = `${briefId}/${runId}`;
    if (filename === 'summary.json') {
      await this.cache.remove(`${DERIVED_PREFIX}route/brief/${routePrefix}`);
      await this.cache.removeByPrefix(`${DERIVED_PREFIX}route/slice-map/${routePrefix}/`);
      // Clear the per-run immutable brief snapshot so it does not outlive the run.
      await this.cache.remove(`${DERIVED_PREFIX}brief-snapshot/${routePrefix}`);
      return;
    }
    if (/^sheet-\d+\.png$/i.test(filename)) {
      // Use removeByPrefix (not exact remove) so both the unfingerprinted base key
      // and all fingerprinted variants (e.g. `latest:<fp>`, `sheet-1.png:<fp>`)
      // are cleared atomically. Leaving any fingerprinted key would allow a
      // cache-first read to return stale geometry from the old PNG.
      await this.cache.removeByPrefix(`${DERIVED_PREFIX}route/slice-map/${routePrefix}/latest`);
      await this.cache.removeByPrefix(
        `${DERIVED_PREFIX}route/slice-map/${routePrefix}/${filename}`,
      );
    }
  }
}
