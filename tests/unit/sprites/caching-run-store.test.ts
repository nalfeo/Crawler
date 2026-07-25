/**
 * Unit tests for CachingRunStore over the SharedResourceCache.
 *
 * Uses a real temp LocalRunStore for the "inner" store and a real temp
 * SharedResourceCache dir so read-through, write-through, invalidation, list
 * snapshots, and the offline hard-gate are exercised at the filesystem level
 * with no mocks. Counting/throwing inner wrappers assert exactly which remote
 * operations happen (and, for warmed paths, that ZERO happen).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CachingRunStore, isCacheableKey } from '../../../scripts/sprites/store/caching-store.js';
import { SharedResourceCache } from '../../../scripts/sprites/store/shared-cache.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';
import { WORKFLOW_STATE_KEY } from '../../../scripts/sprites/sidecar/workflow-state.js';

const noop = (): void => {};

/**
 * Deterministically drains pending microtasks and one macrotask phase per
 * iteration (real, but fast, local fs I/O has a chance to settle) without
 * depending on wall-clock time. Used to let a fire-and-forget
 * stale-while-revalidate background refresh complete before asserting on its
 * effects. No `setTimeout`/real timers involved — `setImmediate` always fires
 * deterministically once the current phase's callbacks have run.
 */
async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Polls `predicate`, waiting a short REAL delay between attempts, until it
 * returns `true` or `maxAttempts` is exhausted. The SWR background refresh
 * performs genuine filesystem I/O (a cache write plus, for purges, a cache
 * remove) whose wall-clock completion time varies with disk/OS scheduling —
 * a fixed `flushAsync` tick count is not a reliable bound for it.
 *
 * A pure `setImmediate` loop (no real timer) does NOT reliably give that I/O
 * enough wall-clock time to complete: `setImmediate` callbacks fire as soon
 * as the event loop's check phase is reached, which can happen far faster
 * than pending fs work (cacache's `put`/`get.info`/`rm`) settles — especially
 * under sustained concurrent filesystem load, such as when CI's sharded
 * `sprites` vitest project (`--shard=N/4`, fork-based pool) runs many sprite
 * test files' processes concurrently against the same disk. Under that
 * contention, all `maxAttempts` ticks can elapse in microseconds of wall time
 * while the real fs work is still queued, which is exactly the ~50% CI flake
 * this helper caused for
 * 'bumps the mutation token before purging so a get() racing the purge
 * cannot resurrect the blob' (main-health flake, see docs/knowledge/handoffs).
 * A real (short) delay between attempts gives genuinely elapsed wall-clock
 * time for that queued work to drain, so the total real budget below
 * (attempts × delay) actually bounds how long we wait — not just how many
 * scheduler turns we burn through.
 */
async function waitUntil(
  predicate: () => Promise<boolean>,
  maxAttempts = 500,
  delayMs = 20,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return true;
    await delay(delayMs);
  }
  return false;
}

async function rmDirWithRetry(dir: string, attempts = 15, delayMs = 100): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await delay(delayMs);
    }
  }
}

/** Counts every operation and delegates to a real inner store. */
class CountingStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  gets = 0;
  has_ = 0;
  puts = 0;
  removes = 0;
  lists = 0;
  constructor(private readonly inner: RunStore) {}
  async put(key: string, data: Buffer): Promise<void> {
    this.puts++;
    return this.inner.put(key, data);
  }
  async get(key: string): Promise<Buffer> {
    this.gets++;
    return this.inner.get(key);
  }
  async has(key: string): Promise<boolean> {
    this.has_++;
    return this.inner.has(key);
  }
  async list(prefix: string): Promise<readonly string[]> {
    this.lists++;
    return this.inner.list(prefix);
  }
  async remove(key: string): Promise<void> {
    this.removes++;
    return this.inner.remove(key);
  }
  resolve(key: string): string {
    return this.inner.resolve(key);
  }
}

/** Simulates a totally unavailable Azure: every READ op throws (and is counted). */
class ThrowingStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  gets = 0;
  has_ = 0;
  lists = 0;
  async put(): Promise<void> {
    throw new Error('offline: put');
  }
  async get(key: string): Promise<Buffer> {
    this.gets++;
    throw new StoreNotFoundError(key);
  }
  async has(): Promise<boolean> {
    this.has_++;
    throw new Error('offline: has');
  }
  async list(): Promise<readonly string[]> {
    this.lists++;
    throw new Error('offline: list');
  }
  async remove(): Promise<void> {
    throw new Error('offline: remove');
  }
  resolve(key: string): string {
    return key;
  }
}

class RaceStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  private readonly values = new Map<string, Buffer>();
  readonly firstPutCommitted: Promise<void>;
  private readonly firstPutUnblocked: Promise<void>;
  private releaseFirstPut: (() => void) | null = null;
  private releaseFirstPutBarrier: (() => void) | null = null;
  private firstPutPromiseResolved = false;

  constructor() {
    this.firstPutCommitted = new Promise<void>((resolve) => {
      this.releaseFirstPut = resolve;
    });
    this.firstPutUnblocked = new Promise<void>((resolve) => {
      this.releaseFirstPutBarrier = resolve;
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.values.set(key, Buffer.from(data));
    if (!this.firstPutPromiseResolved && data.toString('utf8') === 'A') {
      this.firstPutPromiseResolved = true;
      this.releaseFirstPut?.();
      await this.firstPutUnblocked;
      return;
    }
  }

  unblockFirstPut(): void {
    this.releaseFirstPutBarrier?.();
  }

  async get(key: string): Promise<Buffer> {
    const value = this.values.get(key);
    if (!value) throw new StoreNotFoundError(key);
    return Buffer.from(value);
  }

  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  resolve(key: string): string {
    return key;
  }
}

/**
 * A two-put race store where BOTH puts pause after committing their data, so
 * the test can control which continuation runs first.  Used to simulate the
 * cross-instance scenario where A commits to Azure, B commits to Azure (B
 * wins as the authoritative value), but A's post-put cache-publication code
 * runs before B's — leaving stale bytes unless the `else` branch invalidates.
 */
class BothCommitRaceStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  private readonly values = new Map<string, Buffer>();
  readonly firstPutCommitted: Promise<void>;
  readonly secondPutCommitted: Promise<void>;
  private releaseFirst: (() => void) | null = null;
  private releaseFirstBarrier: (() => void) | null = null;
  private releaseSecond: (() => void) | null = null;
  private releaseSecondBarrier: (() => void) | null = null;
  private readonly firstPutUnblocked: Promise<void>;
  private readonly secondPutUnblocked: Promise<void>;
  private putCount = 0;

  constructor() {
    this.firstPutCommitted = new Promise<void>((resolve) => {
      this.releaseFirst = resolve;
    });
    this.secondPutCommitted = new Promise<void>((resolve) => {
      this.releaseSecond = resolve;
    });
    this.firstPutUnblocked = new Promise<void>((resolve) => {
      this.releaseFirstBarrier = resolve;
    });
    this.secondPutUnblocked = new Promise<void>((resolve) => {
      this.releaseSecondBarrier = resolve;
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.values.set(key, Buffer.from(data));
    const n = ++this.putCount;
    if (n === 1) {
      this.releaseFirst?.();
      await this.firstPutUnblocked;
    } else if (n === 2) {
      this.releaseSecond?.();
      await this.secondPutUnblocked;
    }
  }

  unblockFirstPut(): void {
    this.releaseFirstBarrier?.();
  }

  unblockSecondPut(): void {
    this.releaseSecondBarrier?.();
  }

  async get(key: string): Promise<Buffer> {
    const value = this.values.get(key);
    if (!value) throw new StoreNotFoundError(key);
    return Buffer.from(value);
  }

  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.values.keys()].filter((k) => k.startsWith(prefix));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  resolve(key: string): string {
    return key;
  }
}

/**
 * A store whose list() call counts invocations and then pauses until the
 * test manually releases a gate. Used to prove a background
 * stale-while-revalidate refresh does not block the caller: if `list()`
 * awaited this before returning, a test that never releases the gate would
 * hang until timeout.
 */
class GatedListStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  lists = 0;
  private release: (() => void) | null = null;
  private signalListStarted: (() => void) | null = null;
  readonly firstListStarted: Promise<void>;
  private readonly gate: Promise<void>;
  constructor(private readonly keys: readonly string[]) {
    this.firstListStarted = new Promise<void>((resolve) => {
      this.signalListStarted = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  releaseGate(): void {
    this.release?.();
  }
  async put(): Promise<void> {
    throw new Error('unused: put');
  }
  async get(key: string): Promise<Buffer> {
    throw new StoreNotFoundError(key);
  }
  async has(): Promise<boolean> {
    throw new Error('unused: has');
  }
  async list(): Promise<readonly string[]> {
    this.lists++;
    this.signalListStarted?.();
    this.signalListStarted = null;
    await this.gate;
    return this.keys;
  }
  async remove(): Promise<void> {
    throw new Error('unused: remove');
  }
  resolve(key: string): string {
    return key;
  }
}

/** A store that reports fewer keys than a prior listing, modeling an external removal. */
class ShrinkingStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  constructor(private readonly keys: readonly string[]) {}
  async put(): Promise<void> {
    throw new Error('unused: put');
  }
  async get(key: string): Promise<Buffer> {
    throw new StoreNotFoundError(key);
  }
  async has(): Promise<boolean> {
    return false;
  }
  async list(): Promise<readonly string[]> {
    return this.keys;
  }
  async remove(): Promise<void> {
    throw new Error('unused: remove');
  }
  resolve(key: string): string {
    return key;
  }
}

/**
 * Models an external Azure removal mid-flight: `list()` no longer reports a
 * given key, but `get()` for that exact key still succeeds — the same
 * "already in flight when the listing dropped it" window a real Azure
 * LIST/GET inconsistency could produce. Used to prove the background purge's
 * mutation-token bump (not `get()`'s own already-correct protocol) is what
 * closes the resurrection race, by racing a `get()` against a purge.
 */
class StaleGetShrinkingStore implements RunStore {
  readonly backend = 'azure-blob' as const;
  constructor(
    private readonly listedKeys: readonly string[],
    private readonly staleGetKey: string,
    private readonly staleGetBytes: Buffer,
  ) {}
  async put(): Promise<void> {
    throw new Error('unused: put');
  }
  async get(key: string): Promise<Buffer> {
    if (key === this.staleGetKey) return this.staleGetBytes;
    throw new StoreNotFoundError(key);
  }
  async has(): Promise<boolean> {
    return false;
  }
  async list(): Promise<readonly string[]> {
    return this.listedKeys;
  }
  async remove(): Promise<void> {
    throw new Error('unused: remove');
  }
  resolve(key: string): string {
    return key;
  }
}

const SHEET = 'iron-sword/run-abc/sheet-00.png';
const RAW = 'iron-sword/run-abc/raw/00.png';
const PROCESSED = 'iron-sword/run-abc/processed/00.png';
const SCORECARD = 'iron-sword/run-abc/processed/00.scorecard.json';
const SUMMARY = 'iron-sword/run-abc/summary.json';
const BRIEF = 'workflow-state/briefs/briefs/draft/iron-sword.yaml';
const ALL_ARTIFACTS = [SHEET, RAW, PROCESSED, SCORECARD, SUMMARY, BRIEF];

let innerDir: string;
let cacheDir: string;
let inner: CountingStore;
let cache: SharedResourceCache;
let store: CachingRunStore;

const newCache = (d: string): SharedResourceCache =>
  new SharedResourceCache({ cacheDir: d, maxBytes: 0, log: noop });

beforeEach(() => {
  innerDir = mkdtempSync(path.join(tmpdir(), 'crawler-caching-inner-'));
  cacheDir = mkdtempSync(path.join(tmpdir(), 'crawler-caching-cache-'));
  inner = new CountingStore(new LocalRunStore(innerDir));
  cache = newCache(cacheDir);
  store = new CachingRunStore({ inner, cache });
});

afterEach(async () => {
  await rmDirWithRetry(innerDir);
  await rmDirWithRetry(cacheDir);
});

describe('isCacheableKey', () => {
  it('caches every artifact category', () => {
    for (const key of ALL_ARTIFACTS) expect(isCacheableKey(key)).toBe(true);
  });
  it('excludes the mutable ETag-controlled workflow queue document', () => {
    expect(isCacheableKey(WORKFLOW_STATE_KEY)).toBe(false);
  });
});

describe('backend / resolve', () => {
  it('proxies backend tag and resolve() from inner', () => {
    expect(store.backend).toBe('azure-blob');
    expect(store.resolve(SHEET)).toBe(new LocalRunStore(innerDir).resolve(SHEET));
  });

  it('resolveForExternalRead delegates to inner.resolveForExternalRead when present', () => {
    const signed = (key: string): string => `https://signed.example.test/${key}?sig=abc`;
    const innerWithSas: RunStore = {
      backend: inner.backend,
      put: inner.put.bind(inner),
      get: inner.get.bind(inner),
      has: inner.has.bind(inner),
      list: inner.list.bind(inner),
      remove: inner.remove.bind(inner),
      resolve: inner.resolve.bind(inner),
      resolveForExternalRead: signed,
    };
    const wrapping = new CachingRunStore({ inner: innerWithSas, cache });
    expect(wrapping.resolveForExternalRead(SHEET)).toBe(signed(SHEET));
  });

  it('resolveForExternalRead falls back to resolve() when inner lacks the method', () => {
    // inner (CountingStore wrapping LocalRunStore) has no resolveForExternalRead.
    expect(store.resolveForExternalRead(SHEET)).toBe(store.resolve(SHEET));
  });
});

describe('read-through / write-through — all artifact categories', () => {
  it.each(ALL_ARTIFACTS)(
    'first get populates cache; second get is a cache hit (%s)',
    async (key) => {
      const data = Buffer.from(`bytes-for-${key}`);
      await inner.put(key, data);
      inner.puts = 0;

      expect(await store.get(key)).toEqual(data);
      expect(inner.gets).toBe(1);
      expect(await store.get(key)).toEqual(data);
      expect(inner.gets).toBe(1); // second read served from cache
    },
  );

  it('put mirrors into the cache so subsequent gets never hit inner', async () => {
    await store.put(PROCESSED, Buffer.from('proc'));
    expect(inner.puts).toBe(1);
    inner.gets = 0;
    expect(await store.get(PROCESSED)).toEqual(Buffer.from('proc'));
    expect(inner.gets).toBe(0);
  });

  it('has() short-circuits to true from the cache', async () => {
    await store.put(SUMMARY, Buffer.from('{}'));
    inner.has_ = 0;
    expect(await store.has(SUMMARY)).toBe(true);
    expect(inner.has_).toBe(0);
  });

  it('propagates StoreNotFoundError from inner on a genuine miss', async () => {
    await expect(store.get(SHEET)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('surfaces corrupt cache content as a miss and falls through to inner', async () => {
    const data = Buffer.from('fresh-from-azure');
    await inner.put(SHEET, data);
    await store.get(SHEET); // populate cache
    inner.gets = 0;
    // Corrupt the cached content so its integrity check fails.
    const info = await import('cacache').then((c) => c.default.get.info(cacheDir, `blob:${SHEET}`));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(info!.path, 'tampered');
    expect(await store.get(SHEET)).toEqual(data);
    expect(inner.gets).toBe(1); // corruption forced a re-fetch
  });
});

describe('mutable-key invalidation', () => {
  it('put replaces the cached value (not assumed immutable)', async () => {
    await store.put(SUMMARY, Buffer.from('v1'));
    expect(await store.get(SUMMARY)).toEqual(Buffer.from('v1'));
    await store.put(SUMMARY, Buffer.from('v2'));
    inner.gets = 0;
    expect(await store.get(SUMMARY)).toEqual(Buffer.from('v2'));
    expect(inner.gets).toBe(0); // served the replaced cache value
  });

  it('does not let an older cross-instance put overwrite a newer cache publication', async () => {
    const raceInner = new RaceStore();
    const a = new CachingRunStore({ inner: raceInner, cache: newCache(cacheDir) });
    const b = new CachingRunStore({ inner: raceInner, cache: newCache(cacheDir) });

    const stalePut = a.put(SHEET, Buffer.from('A'));
    await raceInner.firstPutCommitted;
    await b.put(SHEET, Buffer.from('B'));
    raceInner.unblockFirstPut();
    await stalePut;

    expect((await a.get(SHEET)).toString('utf8')).toBe('B');
    expect((await b.get(SHEET)).toString('utf8')).toBe('B');
  });

  it('invalidates cache when both inner writes commit before the older continuation can publish', async () => {
    // Scenario: A commits first, B commits second (B is authoritative in the inner
    // store). A's continuation runs before B's and would publish stale 'A' bytes.
    // The fix must detect the race and invalidate so readers fall through to inner.
    const raceInner = new BothCommitRaceStore();
    const a = new CachingRunStore({ inner: raceInner, cache: newCache(cacheDir) });
    const b = new CachingRunStore({ inner: raceInner, cache: newCache(cacheDir) });

    // Start A — it will pause inside inner.put after committing 'A'.
    const putA = a.put(SHEET, Buffer.from('A'));
    await raceInner.firstPutCommitted; // A committed 'A'; inner = 'A'

    // Start B — it will pause inside inner.put after committing 'B'.
    const putB = b.put(SHEET, Buffer.from('B'));
    await raceInner.secondPutCommitted; // B committed 'B'; inner = 'B' (winner)

    // Release A first so A's post-put continuation runs (A would naively publish 'A').
    raceInner.unblockFirstPut();
    await putA;

    // Release B so B's continuation runs and detects the race.
    raceInner.unblockSecondPut();
    await putB;

    // Both instances must read the authoritative 'B', not stale 'A'.
    expect((await a.get(SHEET)).toString('utf8')).toBe('B');
    expect((await b.get(SHEET)).toString('utf8')).toBe('B');
  });

  it('remove invalidates the cache before delegating to inner', async () => {
    await store.put(SHEET, Buffer.from('x'));
    await store.remove(SHEET);
    expect(inner.removes).toBe(1);
    expect(await store.has(SHEET)).toBe(false);
  });

  it('invalidates derived route snapshots when their source artifacts change', async () => {
    const routePrefix = 'iron-sword/run-abc';
    await store.setCachedResource(`route/brief/${routePrefix}`, Buffer.from('brief'));
    await store.setCachedResource(`route/slice-map/${routePrefix}/latest`, Buffer.from('latest'));
    await store.setCachedResource(
      `route/slice-map/${routePrefix}/sheet-00.png`,
      Buffer.from('sheet'),
    );

    await store.put(SUMMARY, Buffer.from('{}'));
    expect(await store.getCachedResource(`route/brief/${routePrefix}`)).toBeNull();
    expect(await store.getCachedResource(`route/slice-map/${routePrefix}/latest`)).toBeNull();
    expect(await store.getCachedResource(`route/slice-map/${routePrefix}/sheet-00.png`)).toBeNull();

    await store.setCachedResource(`route/slice-map/${routePrefix}/latest`, Buffer.from('latest'));
    await store.setCachedResource(
      `route/slice-map/${routePrefix}/sheet-00.png`,
      Buffer.from('sheet'),
    );
    await store.put(SHEET, Buffer.from('new-sheet'));
    expect(await store.getCachedResource(`route/slice-map/${routePrefix}/latest`)).toBeNull();
    expect(await store.getCachedResource(`route/slice-map/${routePrefix}/sheet-00.png`)).toBeNull();
  });

  it('retains per-run brief snapshot on summary updates, but removes it when the run is removed', async () => {
    const routePrefix = 'iron-sword/run-abc';
    await store.setCachedResource(`brief-snapshot/${routePrefix}`, Buffer.from('snapshot-v1'));
    await store.put(SUMMARY, Buffer.from('{"v":2}'));
    expect((await store.getCachedResource(`brief-snapshot/${routePrefix}`))?.toString()).toBe(
      'snapshot-v1',
    );
    await store.remove(SUMMARY);
    expect(await store.getCachedResource(`brief-snapshot/${routePrefix}`)).toBeNull();
  });

  it('invalidates all brief-derived snapshots when a durable brief changes', async () => {
    await store.setCachedResource('route/brief/a/run-1', Buffer.from('a'));
    await store.setCachedResource('route/slice-map/b/run-2/latest', Buffer.from('b'));
    await store.put(BRIEF, Buffer.from('updated brief'));
    expect(await store.getCachedResource('route/brief/a/run-1')).toBeNull();
    expect(await store.getCachedResource('route/slice-map/b/run-2/latest')).toBeNull();
  });
});

describe('workflow queue document bypasses the cache', () => {
  it('never caches get/has for the ETag-controlled queue key', async () => {
    await inner.put(WORKFLOW_STATE_KEY, Buffer.from('{"v":1}'));
    inner.gets = 0;
    inner.has_ = 0;
    await store.get(WORKFLOW_STATE_KEY);
    await store.get(WORKFLOW_STATE_KEY);
    await store.has(WORKFLOW_STATE_KEY);
    expect(inner.gets).toBe(2); // every read hits inner — no caching
    expect(inner.has_).toBe(1);
  });
});

describe('list snapshots', () => {
  it('serves an epoch-fresh snapshot instantly and revalidates in the background (SWR)', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.put(RAW, Buffer.from('b'));
    const first = await store.list('iron-sword/run-abc/');
    expect(first).toEqual(expect.arrayContaining([SHEET, RAW]));
    const listsAfterWarm = inner.lists;
    const second = await store.list('iron-sword/run-abc/');
    expect(second).toEqual(first);
    // The fast path returns the warmed snapshot without awaiting inner.list,
    // but still schedules a background refresh (proved non-blocking by the
    // dedicated 'does not await' test below) — so the counter still ticks up
    // by exactly one via that fire-and-forget refresh.
    expect(inner.lists).toBe(listsAfterWarm + 1);
    await flushAsync(); // let the background refresh settle before the next test
  });

  it('refreshes from inner after a mutation bumps the epoch', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/');
    const before = inner.lists;
    await store.put(RAW, Buffer.from('b')); // bumps epoch → snapshot stale
    const refreshed = await store.list('iron-sword/run-abc/');
    expect(inner.lists).toBe(before + 1);
    expect(refreshed).toEqual(expect.arrayContaining([SHEET, RAW]));
  });

  it('rethrows when the remote fails and no snapshot exists', async () => {
    const throwing = new ThrowingStore();
    const s = new CachingRunStore({ inner: throwing, cache: newCache(cacheDir) });
    await expect(s.list('never-listed/')).rejects.toThrow('offline: list');
  });

  it('falls back to a warmed snapshot when the remote later fails', async () => {
    // Warm the snapshot online.
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/');
    // A fresh instance whose inner is now unavailable still serves the snapshot.
    const throwing = new ThrowingStore();
    const s = new CachingRunStore({ inner: throwing, cache });
    const keys = await s.list('iron-sword/run-abc/');
    expect(keys).toEqual(expect.arrayContaining([SHEET]));
    expect(throwing.lists).toBe(1); // the fire-and-forget background refresh attempted the remote once
  });

  it('rejects a known-stale snapshot when the online remote fails', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/');
    cache.bumpEpoch();
    const throwing = new ThrowingStore();
    const s = new CachingRunStore({ inner: throwing, cache });
    await expect(s.list('iron-sword/run-abc/')).rejects.toThrow('offline: list');
  });

  it('keeps a warmed listing available offline after LRU pressure', async () => {
    const boundedCache = new SharedResourceCache({ cacheDir, maxBytes: 300, log: noop });
    const boundedStore = new CachingRunStore({ inner, cache: boundedCache });
    await boundedStore.put(SHEET, Buffer.alloc(100, 1));
    const warmed = await boundedStore.list('iron-sword/run-abc/');
    await boundedCache.set('pressure:1', Buffer.alloc(200, 2));
    await boundedCache.set('pressure:2', Buffer.alloc(200, 3));

    const offlineInner = new ThrowingStore();
    const offline = new CachingRunStore({
      inner: offlineInner,
      cache: new SharedResourceCache({ cacheDir, maxBytes: 300, log: noop }),
      offline: true,
    });
    expect(await offline.list('iron-sword/run-abc/')).toEqual(warmed);
    expect(offlineInner.lists).toBe(0);
  });

  it('does not await inner.list before returning when a fresh snapshot exists', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/'); // warm an epoch-fresh snapshot

    // The gate is never released during this await. If the fast path awaited
    // inner.list() before resolving (the old blocking behavior), this call
    // would hang until the test times out.
    const gated = new GatedListStore([SHEET]);
    const s = new CachingRunStore({ inner: gated, cache }); // shares the warmed snapshot on disk

    const keys = await s.list('iron-sword/run-abc/');
    expect(keys).toEqual(expect.arrayContaining([SHEET]));
    expect(gated.lists).toBe(1); // the background refresh did start (fire-and-forget)

    gated.releaseGate(); // let the still-pending background refresh finish cleanly
    await flushAsync();
  });

  it('dedupes concurrent background refreshes so inner.list runs at most once per window', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/'); // warm an epoch-fresh snapshot

    const gated = new GatedListStore([SHEET]);
    const s = new CachingRunStore({ inner: gated, cache });

    const [a, b, c] = await Promise.all([
      s.list('iron-sword/run-abc/'),
      s.list('iron-sword/run-abc/'),
      s.list('iron-sword/run-abc/'),
    ]);
    expect(a).toEqual(expect.arrayContaining([SHEET]));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(gated.lists).toBe(1); // 3 concurrent reads scheduled only ONE background refresh

    gated.releaseGate();
    await flushAsync();
  });

  it('swallows a background refresh error without rejecting the caller', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/'); // warm an epoch-fresh snapshot

    const logged: string[] = [];
    const spyCache = new SharedResourceCache({ cacheDir, maxBytes: 0, log: (m) => logged.push(m) });
    const throwing = new ThrowingStore();
    const s = new CachingRunStore({ inner: throwing, cache: spyCache }); // shares the warmed snapshot on disk

    const keys = await s.list('iron-sword/run-abc/'); // fast path: resolves instantly with the stale data
    expect(keys).toEqual(expect.arrayContaining([SHEET]));

    await flushAsync(); // let the background refresh fail and get swallowed
    expect(throwing.lists).toBe(1); // it really was attempted
    expect(logged.some((m) => m.includes('list refresh failed'))).toBe(true); // surfaced, not silently eaten
  });

  it('purges the blob cache entry for a key the background refresh no longer reports', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.put(RAW, Buffer.from('b'));
    await store.list('iron-sword/run-abc/'); // warm: [SHEET, RAW]

    const shrinking = new ShrinkingStore([SHEET]); // RAW is no longer reported by "Azure"
    const s = new CachingRunStore({ inner: shrinking, cache }); // shares the warmed snapshot + blob cache

    expect(await s.has(RAW)).toBe(true); // still blob-cached from the put() above

    const first = await s.list('iron-sword/run-abc/'); // fast path: stale [SHEET, RAW] instantly
    expect(first).toEqual(expect.arrayContaining([SHEET, RAW]));

    // The background refresh performs real cache I/O (snapshot rewrite +
    // blob purge); poll for its observable effect rather than assuming a
    // fixed tick count settles it.
    const purged = await waitUntil(async () => !(await s.has(RAW)));
    expect(purged).toBe(true); // purged from the blob cache

    const second = await s.list('iron-sword/run-abc/'); // snapshot now updated to [SHEET] only
    expect(second).toEqual([SHEET]);
  });

  it('purges derived HTTP-route response caches for a run the background refresh no longer reports', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.put(RAW, Buffer.from('b'));
    await store.put(SUMMARY, Buffer.from('{}'));
    await store.list('iron-sword/run-abc/'); // warm: [SHEET, RAW, SUMMARY]

    const routePrefix = 'iron-sword/run-abc';
    await store.setCachedResource(`route/brief/${routePrefix}`, Buffer.from('brief'));
    await store.setCachedResource(`route/slice-map/${routePrefix}/latest`, Buffer.from('latest'));

    // "Azure" no longer reports the run at all (summary.json is gone) — models
    // an external delete of the whole run, the same scenario the authoritative
    // remove() path already handles for a same-process caller. Without
    // invalidateDerivedResources() in the purge loop, a route handler's
    // cache-first fast path (server.ts getCachedResource) would keep serving
    // this stale response forever, since it never re-checks store.has().
    const shrinking = new ShrinkingStore([SHEET, RAW]);
    const s = new CachingRunStore({ inner: shrinking, cache }); // shares the warmed snapshot + derived caches

    const first = await s.list('iron-sword/run-abc/'); // fast path: stale listing still includes SUMMARY
    expect(first).toEqual(expect.arrayContaining([SUMMARY]));

    // invalidateDerivedResources() awaits its two removes sequentially (exact
    // route/brief key, then a route/slice-map/ prefix sweep), so poll for
    // BOTH together — checking them one after another would race the second
    // remove's own in-flight I/O and could flake.
    const purged = await waitUntil(async () => {
      const brief = await s.getCachedResource(`route/brief/${routePrefix}`);
      const sliceMap = await s.getCachedResource(`route/slice-map/${routePrefix}/latest`);
      return brief === null && sliceMap === null;
    });
    expect(purged).toBe(true);

    const second = await s.list('iron-sword/run-abc/'); // snapshot no longer reports the removed run
    expect(second).not.toContain(SUMMARY);
  });

  it('does not publish a stale refresh result when a mutation races the in-flight background list', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/'); // warm an epoch-fresh snapshot: [SHEET]

    const gated = new GatedListStore([SHEET]); // reports [SHEET] only once released
    const s = new CachingRunStore({ inner: gated, cache }); // shares the warmed snapshot + epoch file

    const fast = await s.list('iron-sword/run-abc/'); // fast path: instant, background refresh starts
    expect(fast).toEqual([SHEET]);
    expect(gated.lists).toBe(1); // the background inner.list() call has started and is now gated

    // A same-process mutation races the still-in-flight background refresh —
    // exactly the scenario the epoch-stable guard in refreshListSnapshot()
    // exists for.
    await store.put(RAW, Buffer.from('b')); // bumps the shared epoch to a new value

    gated.releaseGate(); // let the now-stale-relative-to-the-mutation inner.list() resolve
    await flushAsync();

    // The raced refresh must NOT have overwritten the snapshot with its
    // now-stale (RAW-less) result, and must NOT have purged RAW's freshly
    // written blob-cache entry — either would silently hide the run that was
    // just written while the refresh was in flight.
    expect(await s.has(RAW)).toBe(true);

    // Because the epoch moved past what the warmed snapshot recorded, the
    // NEXT list() call must take the (unchanged) blocking slow path and
    // re-fetch authoritatively — proving the raced result was discarded
    // rather than published.
    const next = await s.list('iron-sword/run-abc/');
    expect(gated.lists).toBe(2); // a second, authoritative inner.list() call was made
    expect(next).toEqual(expect.arrayContaining([SHEET]));
  });

  it('does not purge blob-cache entries when the background refresh snapshot write itself fails', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.put(RAW, Buffer.from('b'));
    await store.list('iron-sword/run-abc/'); // warm: [SHEET, RAW]

    // Simulates SharedResourceCache.set() failing for the snapshot write only
    // (e.g. lock contention, disk pressure) while blob writes still succeed —
    // 'list:' mirrors caching-store.ts's private LIST_PREFIX constant.
    class SnapshotWriteFailingCache extends SharedResourceCache {
      async set(
        key: string,
        data: Buffer,
        metadata?: Record<string, unknown>,
        expectedMutationToken?: string,
      ): Promise<boolean> {
        if (key.startsWith('list:')) return false;
        return super.set(key, data, metadata, expectedMutationToken);
      }
    }
    const failingCache = new SnapshotWriteFailingCache({ cacheDir, maxBytes: 0, log: noop });
    const shrinking = new ShrinkingStore([SHEET]); // RAW no longer reported by "Azure"
    const s = new CachingRunStore({ inner: shrinking, cache: failingCache }); // shares the disk snapshot + blobs

    const first = await s.list('iron-sword/run-abc/'); // fast path: stale [SHEET, RAW] instantly
    expect(first).toEqual(expect.arrayContaining([SHEET, RAW]));

    await flushAsync(); // let the background refresh attempt (and fail) its snapshot rewrite

    // The snapshot rewrite itself failed, so RAW's blob-cache entry must
    // survive — purging it here would hide a run the old (still epoch-fresh,
    // still-served) snapshot still points at.
    expect(await s.has(RAW)).toBe(true);
  });

  it('an authoritative list() blocks on inner.list even when a fresh snapshot exists', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.list('iron-sword/run-abc/'); // warm an epoch-fresh snapshot: [SHEET]

    // Enumerate-then-act callers (server.ts's archive/delete/clear-store
    // routes) pass { authoritative: true } because they need a
    // guaranteed-fresh key set before acting — unlike the default fast path
    // proven never to block in 'does not await inner.list before
    // returning...' above, this call must genuinely await inner.list().
    const gated = new GatedListStore([SHEET, RAW]); // "Azure" now also reports RAW
    const s = new CachingRunStore({ inner: gated, cache }); // shares the warmed snapshot + epoch file

    let resolved = false;
    const authoritative = s.list('iron-sword/run-abc/', { authoritative: true }).then((keys) => {
      resolved = true;
      return keys;
    });

    try {
      await gated.firstListStarted;
      expect(gated.lists).toBe(1); // inner.list() was genuinely invoked, not skipped
      expect(resolved).toBe(false); // ...and the call is genuinely blocked on it, not merely "also calling it"
    } finally {
      gated.releaseGate();
    }
    await expect(authoritative).resolves.toEqual(expect.arrayContaining([SHEET, RAW]));
    expect(resolved).toBe(true);
  });

  it('bumps the mutation token before purging so a get() racing the purge cannot resurrect the blob', async () => {
    const staleBytes = Buffer.from('stale-raw-bytes');

    // Write RAW directly to the inner store, bypassing the cache entirely —
    // this leaves the blob-cache entry ABSENT so the upcoming get() below
    // must take the read-through-fill path (a cache hit would short-circuit
    // before ever touching setIfAbsent, defeating the race this test drives).
    const rawInner = new (class implements RunStore {
      readonly backend = 'azure-blob' as const;
      async put(): Promise<void> {}
      async get(key: string): Promise<Buffer> {
        if (key === RAW) return staleBytes;
        throw new StoreNotFoundError(key);
      }
      async has(): Promise<boolean> {
        return true;
      }
      async list(): Promise<readonly string[]> {
        return [SHEET, RAW];
      }
      async remove(): Promise<void> {}
      resolve(key: string): string {
        return key;
      }
    })();
    const warmer = new CachingRunStore({ inner: rawInner, cache });
    await warmer.list('iron-sword/run-abc/'); // warm an epoch-fresh snapshot: [SHEET, RAW]

    // Gate setIfAbsent for RAW's blob-cache entry specifically, mirroring the
    // precedent 'does not republish stale read-through data after a
    // concurrent remove' test's exact override pattern — the gate sits
    // BEFORE super.setIfAbsent() so no lock is held while paused.
    let signalFillStarted!: () => void;
    const fillStarted = new Promise<void>((resolve) => {
      signalFillStarted = () => resolve();
    });
    let releaseFillGate!: () => void;
    const fillGate = new Promise<void>((resolve) => {
      releaseFillGate = () => resolve();
    });
    class BlockingCache extends SharedResourceCache {
      override async setIfAbsent(
        cacheKey: string,
        data: Buffer,
        metadata?: Record<string, unknown>,
        expectedMutationToken?: string,
      ): Promise<boolean> {
        if (cacheKey === `blob:${RAW}`) {
          signalFillStarted();
          await fillGate;
        }
        return super.setIfAbsent(cacheKey, data, metadata, expectedMutationToken);
      }
    }
    const blockingCache = new BlockingCache({ cacheDir, maxBytes: 0, log: noop });
    const tokenBeforeGet = blockingCache.readMutationToken(`blob:${RAW}`);

    // "Azure" no longer reports RAW — the background purge this triggers is
    // what must bump the mutation token before removing the (already-absent)
    // blob-cache entry, so the gated get() below can't resurrect it.
    const staleGet = new StaleGetShrinkingStore([SHEET], RAW, staleBytes);
    const s = new CachingRunStore({ inner: staleGet, cache: blockingCache });

    const inflightGet = s.get(RAW); // starts the read-through-fill; will pause at the gate
    await fillStarted;

    await s.list('iron-sword/run-abc/'); // fast path: schedules the background purge
    const bumped = await waitUntil(
      async () => blockingCache.readMutationToken(`blob:${RAW}`) !== tokenBeforeGet,
    );
    expect(bumped).toBe(true); // the purge bumped the token BEFORE the gated get() could commit its write

    releaseFillGate();
    await expect(inflightGet).resolves.toEqual(staleBytes); // get() still returns the bytes it fetched...
    expect(await s.has(RAW)).toBe(false); // ...but the bump correctly rejected its now-stale cache write
  });
});

describe('offline hard-gate: warm in A, read in B with Azure unavailable', () => {
  it('serves exact bytes + listing from a warmed cache with ZERO remote reads', async () => {
    // ── Warm worktree A (online) ──────────────────────────────────────────
    const bytesByKey = new Map<string, Buffer>();
    for (const key of ALL_ARTIFACTS) {
      const data = Buffer.from(`payload::${key}`);
      bytesByKey.set(key, data);
      await store.put(key, data); // write-through populates the shared cache
    }
    const warmList = await store.list(''); // capture a listing snapshot

    // ── Worktree B: separate instance, SAME shared cache, Azure unavailable ─
    const offlineInner = new ThrowingStore();
    const b = new CachingRunStore({
      inner: offlineInner,
      cache: newCache(cacheDir), // same physical cache dir, fresh instance
      offline: true,
    });

    for (const key of ALL_ARTIFACTS) {
      expect(await b.get(key)).toEqual(bytesByKey.get(key)); // exact bytes
      expect(await b.has(key)).toBe(true);
    }
    const offlineList = await b.list('');
    expect([...offlineList].sort()).toEqual([...warmList].sort()); // identical listing

    // The hard gate: not a single remote read operation occurred in B.
    expect(offlineInner.gets).toBe(0);
    expect(offlineInner.has_).toBe(0);
    expect(offlineInner.lists).toBe(0);
  });

  it('offline get of an un-warmed key misses without contacting the remote', async () => {
    const offlineInner = new ThrowingStore();
    const b = new CachingRunStore({ inner: offlineInner, cache, offline: true });
    await expect(b.get('never/warmed/sheet-00.png')).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(offlineInner.gets).toBe(0);
    expect(await b.has('never/warmed/sheet-00.png')).toBe(false);
    expect(offlineInner.has_).toBe(0);
  });

  it('does not republish stale read-through data after a concurrent remove', async () => {
    const key = SHEET;
    const initial = Buffer.from('v1');
    await inner.put(key, initial);
    await cache.remove(`blob:${key}`);

    let signalFillStarted!: () => void;
    const fillStarted = new Promise<void>((resolve) => {
      signalFillStarted = () => resolve();
    });
    let releaseFillGate!: () => void;
    const fillGate = new Promise<void>((resolve) => {
      releaseFillGate = () => resolve();
    });
    class BlockingCache extends SharedResourceCache {
      override async setIfAbsent(
        cacheKey: string,
        data: Buffer,
        metadata?: Record<string, unknown>,
        expectedMutationToken?: string,
      ): Promise<boolean> {
        if (cacheKey === `blob:${key}`) {
          signalFillStarted();
          await fillGate;
        }
        return super.setIfAbsent(cacheKey, data, metadata, expectedMutationToken);
      }
    }
    const blockingCache = new BlockingCache({ cacheDir, maxBytes: 0, log: noop });
    const raceStore = new CachingRunStore({ inner, cache: blockingCache });
    const inflightGet = raceStore.get(key);
    await fillStarted;
    await raceStore.remove(key);
    releaseFillGate();
    await expect(inflightGet).resolves.toEqual(initial);
    await expect(raceStore.has(key)).resolves.toBe(false);
    await expect(raceStore.get(key)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('offline list of an un-warmed prefix throws rather than hiding the gap', async () => {
    const offlineInner = new ThrowingStore();
    const b = new CachingRunStore({ inner: offlineInner, cache, offline: true });
    await expect(b.list('never/warmed/')).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(offlineInner.lists).toBe(0);
  });
});
