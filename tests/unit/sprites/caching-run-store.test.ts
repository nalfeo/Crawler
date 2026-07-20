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
import { CachingRunStore, isCacheableKey } from '../../../scripts/sprites/store/caching-store.js';
import { SharedResourceCache } from '../../../scripts/sprites/store/shared-cache.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';
import { WORKFLOW_STATE_KEY } from '../../../scripts/sprites/sidecar/workflow-state.js';

const noop = (): void => {};

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

afterEach(() => {
  rmSync(innerDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
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
  it('refreshes online listings so external writers cannot leave a fresh snapshot stale', async () => {
    await store.put(SHEET, Buffer.from('a'));
    await store.put(RAW, Buffer.from('b'));
    const first = await store.list('iron-sword/run-abc/');
    expect(first).toEqual(expect.arrayContaining([SHEET, RAW]));
    const listsAfterWarm = inner.lists;
    const second = await store.list('iron-sword/run-abc/');
    expect(second).toEqual(first);
    expect(inner.lists).toBe(listsAfterWarm + 1);
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
    expect(throwing.lists).toBe(1); // it tried the remote, then fell back
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

  it('offline list of an un-warmed prefix throws rather than hiding the gap', async () => {
    const offlineInner = new ThrowingStore();
    const b = new CachingRunStore({ inner: offlineInner, cache, offline: true });
    await expect(b.list('never/warmed/')).rejects.toBeInstanceOf(StoreNotFoundError);
    expect(offlineInner.lists).toBe(0);
  });
});
