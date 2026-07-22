/**
 * Unit tests for the canonical SharedResourceCache (cacache-backed) and its
 * env-resolution / namespacing helpers.
 *
 * Uses real temp dirs so the content-addressable store, access-recency markers,
 * LRU prune, and cross-instance epoch are exercised at the filesystem level.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import cacache from 'cacache';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_CACHE_BYTES,
  SharedResourceCache,
  computeCacheNamespace,
  createSharedResourceCache,
  isAzureCacheEnabled,
  isAzureOffline,
  resolveCacheBaseDir,
  resolveMaxCacheBytes,
} from '../../../scripts/sprites/store/shared-cache.js';

const noop = (): void => {};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'crawler-shared-cache-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Sum of UNIQUE physical content (deduped by integrity) currently in `cacheDir`. */
async function uniqueContentBytes(cacheDir: string): Promise<number> {
  const entries = await cacache.ls(cacheDir);
  const bySize = new Map<string, number>();
  for (const entry of Object.values(entries)) {
    bySize.set(entry.integrity, entry.size ?? 0);
  }
  let total = 0;
  for (const size of bySize.values()) total += size;
  return total;
}

const markerPath = (cacheDir: string, key: string): string =>
  path.join(cacheDir, '.crawler', 'access', createHash('sha256').update(key).digest('hex'));

describe('computeCacheNamespace', () => {
  it('is deterministic and 16 hex chars', () => {
    const id = { host: 'acct.blob.core.windows.net', account: 'acct', container: 'runs' };
    const ns = computeCacheNamespace(id);
    expect(ns).toMatch(/^[0-9a-f]{16}$/);
    expect(computeCacheNamespace({ ...id })).toBe(ns);
  });

  it('isolates distinct account / container / host identities', () => {
    const base = { host: 'h', account: 'a', container: 'c' };
    const ns = computeCacheNamespace(base);
    expect(computeCacheNamespace({ ...base, account: 'other' })).not.toBe(ns);
    expect(computeCacheNamespace({ ...base, container: 'other' })).not.toBe(ns);
    expect(computeCacheNamespace({ ...base, host: 'other' })).not.toBe(ns);
  });
});

describe('resolveCacheBaseDir', () => {
  it('prefers CRAWLER_AZURE_CACHE_DIR', () => {
    expect(
      resolveCacheBaseDir({ CRAWLER_AZURE_CACHE_DIR: '/c', SPRITES_AZURE_CACHE_DIR: '/s' }),
    ).toBe('/c');
  });
  it('falls back to the legacy SPRITES_AZURE_CACHE_DIR alias', () => {
    expect(resolveCacheBaseDir({ SPRITES_AZURE_CACHE_DIR: '/s' })).toBe('/s');
  });
  it('uses $COPILOT_HOME/crawler/azure-resource-cache by default', () => {
    expect(resolveCacheBaseDir({ COPILOT_HOME: '/home/u/.copilot' }, () => '/home/u')).toBe(
      path.join('/home/u/.copilot', 'crawler', 'azure-resource-cache'),
    );
  });
  it('falls back to <homedir>/.copilot when COPILOT_HOME is unset', () => {
    expect(resolveCacheBaseDir({}, () => '/home/u')).toBe(
      path.join('/home/u', '.copilot', 'crawler', 'azure-resource-cache'),
    );
  });
});

describe('resolveMaxCacheBytes', () => {
  it('defaults to exactly 5 GiB', () => {
    expect(resolveMaxCacheBytes({})).toBe(5 * 1024 * 1024 * 1024);
    expect(DEFAULT_MAX_CACHE_BYTES).toBe(5 * 1024 * 1024 * 1024);
  });
  it('reads the canonical CRAWLER var', () => {
    expect(resolveMaxCacheBytes({ CRAWLER_AZURE_CACHE_MAX_BYTES: '1048576' })).toBe(1048576);
  });
  it('reads the legacy SPRITES alias', () => {
    expect(resolveMaxCacheBytes({ SPRITES_AZURE_CACHE_MAX_BYTES: '2048' })).toBe(2048);
  });
  it('prefers CRAWLER over the legacy alias', () => {
    expect(
      resolveMaxCacheBytes({
        CRAWLER_AZURE_CACHE_MAX_BYTES: '10',
        SPRITES_AZURE_CACHE_MAX_BYTES: '20',
      }),
    ).toBe(10);
  });
  it('treats 0 as unbounded', () => {
    expect(resolveMaxCacheBytes({ CRAWLER_AZURE_CACHE_MAX_BYTES: '0' })).toBe(0);
  });
  it.each(['', 'abc', '-5', '3.5', '1e6', '9999999999999999999999'])(
    'falls back to the default for malformed value %j',
    (v) => {
      expect(resolveMaxCacheBytes({ CRAWLER_AZURE_CACHE_MAX_BYTES: v })).toBe(
        DEFAULT_MAX_CACHE_BYTES,
      );
    },
  );
});

describe('isAzureCacheEnabled / isAzureOffline', () => {
  it('cache defaults on; honours off via either var', () => {
    expect(isAzureCacheEnabled({})).toBe(true);
    expect(isAzureCacheEnabled({ CRAWLER_AZURE_CACHE: 'off' })).toBe(false);
    expect(isAzureCacheEnabled({ SPRITES_AZURE_CACHE: '0' })).toBe(false);
  });
  it('offline defaults off; honours on via either var', () => {
    expect(isAzureOffline({})).toBe(false);
    expect(isAzureOffline({ CRAWLER_AZURE_OFFLINE: '1' })).toBe(true);
    expect(isAzureOffline({ SPRITES_AZURE_OFFLINE: 'true' })).toBe(true);
  });
});

describe('SharedResourceCache value API', () => {
  it('set/get roundtrips bytes and metadata', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    const bytes = Buffer.from([1, 2, 3, 4]);
    await cache.set('blob:a', bytes, { kind: 'sheet' });
    const hit = await cache.get('blob:a');
    expect(hit).not.toBeNull();
    expect(hit!.data).toEqual(bytes);
    expect(hit!.metadata).toEqual({ kind: 'sheet' });
  });

  it('get returns null on a miss', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    expect(await cache.get('blob:missing')).toBeNull();
    expect(await cache.has('blob:missing')).toBe(false);
  });

  it('remove invalidates a key', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    await cache.set('blob:a', Buffer.from('x'));
    expect(await cache.has('blob:a')).toBe(true);
    await cache.remove('blob:a');
    expect(await cache.has('blob:a')).toBe(false);
    expect(await cache.get('blob:a')).toBeNull();
  });

  it('remove compacts unreferenced physical content', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    await cache.set('blob:a', Buffer.from('unique-content'));
    const info = await cacache.get.info(dir, 'blob:a');
    expect(info).not.toBeNull();
    await cache.remove('blob:a');
    expect(existsSync(info!.path)).toBe(false);
  });

  it('surfaces corrupt content as a miss (integrity failure)', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    await cache.set('blob:a', Buffer.from('authentic-bytes'));
    const info = await cacache.get.info(dir, 'blob:a');
    expect(info).not.toBeNull();
    // Corrupt the stored content so its digest no longer matches the index SRI.
    writeFileSync(info!.path, 'tampered');
    expect(await cache.get('blob:a')).toBeNull();
  });

  it('treats keys as opaque — separators/`..` never escape the cache dir', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    const evil = 'blob:../../etc/passwd';
    const payload = Buffer.from('opaque');
    await cache.set(evil, payload);
    const hit = await cache.get(evil);
    expect(hit!.data).toEqual(payload);
    // The bytes live under the cache dir's content store, not at any traversed path.
    const entries = await cacache.ls(dir);
    for (const entry of Object.values(entries)) {
      expect(path.resolve(entry.path).startsWith(path.resolve(dir))).toBe(true);
    }
  });

  it('skips caching a single value larger than the whole budget', async () => {
    const cache = new SharedResourceCache({
      cacheDir: dir,
      maxBytes: 50,
      pruneThresholdBytes: 0,
      log: noop,
    });
    await cache.set('blob:big', Buffer.alloc(100, 1));
    expect(await cache.get('blob:big')).toBeNull();
  });

  it('setIfAbsent writes when the key is absent', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    const bytes = Buffer.from('first-value');
    await cache.setIfAbsent('blob:x', bytes);
    const hit = await cache.get('blob:x');
    expect(hit).not.toBeNull();
    expect(hit!.data).toEqual(bytes);
  });

  it('setIfAbsent is a no-op when the key already exists (first writer wins)', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    await cache.set('blob:x', Buffer.from('original'));
    await cache.setIfAbsent('blob:x', Buffer.from('replacement'));
    const hit = await cache.get('blob:x');
    expect(hit!.data.toString()).toBe('original');
  });

  it('concurrent setIfAbsent calls leave exactly the first-writer value', async () => {
    const a = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    const b = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    // Fire both without awaiting so they race.
    await Promise.all([
      a.setIfAbsent('blob:race', Buffer.from('writer-a')),
      b.setIfAbsent('blob:race', Buffer.from('writer-b')),
    ]);
    const hit = await a.get('blob:race');
    // One of the two values must have won; the content must be stable (not a mix).
    expect(['writer-a', 'writer-b']).toContain(hit!.data.toString());
  });

  it('setIfAbsent skips values larger than maxBytes', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 50, log: noop });
    await cache.set('blob:small', Buffer.from('small'));
    await cache.setIfAbsent('blob:big', Buffer.alloc(100, 1));
    expect(await cache.get('blob:big')).toBeNull();
    expect((await cache.get('blob:small'))?.data.toString()).toBe('small');
  });

  it('setIfAbsent repairs a dangling index entry by rewriting fresh content', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    await cache.set('blob:repair', Buffer.from('old'));
    const info = await cacache.get.info(dir, 'blob:repair');
    expect(info).not.toBeNull();
    rmSync(info!.path, { force: true });
    expect(await cache.get('blob:repair')).toBeNull();
    await cache.setIfAbsent('blob:repair', Buffer.from('new'));
    expect((await cache.get('blob:repair'))?.data.toString()).toBe('new');
  });
});

describe('SharedResourceCache list-invalidation epoch', () => {
  it('replaces the shared version with a fresh token on every bump', () => {
    const a = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    const b = new SharedResourceCache({ cacheDir: dir, maxBytes: 0, log: noop });
    expect(a.readEpoch()).toBe('');
    a.bumpEpoch();
    const first = b.readEpoch();
    expect(first).not.toBe('');
    b.bumpEpoch();
    expect(a.readEpoch()).not.toBe(first);
  });
});

describe('SharedResourceCache LRU prune', () => {
  it('evicts down to the cap counting UNIQUE content, and dedupes shared content', async () => {
    // cap holds 2×100B. pruneThreshold 0 → prune after every write.
    const cache = new SharedResourceCache({
      cacheDir: dir,
      maxBytes: 200,
      pruneThresholdBytes: 0,
      log: noop,
    });
    await cache.set('blob:1', Buffer.alloc(100, 1));
    await cache.set('blob:2', Buffer.alloc(100, 2));
    // Two keys, identical content → deduped to one physical blob (100B total).
    await cache.set('blob:3a', Buffer.alloc(100, 3));
    await cache.set('blob:3b', Buffer.alloc(100, 3));
    const total = await uniqueContentBytes(dir);
    expect(total).toBeLessThanOrEqual(200);
  });

  it('a cache HIT refreshes recency and changes the eviction victim', async () => {
    const cache = new SharedResourceCache({
      cacheDir: dir,
      maxBytes: 200,
      pruneThresholdBytes: 0,
      log: noop,
    });
    await cache.set('blob:1', Buffer.alloc(100, 1));
    await cache.set('blob:2', Buffer.alloc(100, 2));
    // Force blob:1 to look OLDER than blob:2 by backdating its access marker.
    utimesSync(markerPath(dir, 'blob:1'), 1000, 1000);
    utimesSync(markerPath(dir, 'blob:2'), 2000, 2000);
    // A hit on blob:1 refreshes its recency to now → blob:2 becomes the victim.
    await cache.get('blob:1');
    await cache.set('blob:3', Buffer.alloc(100, 3)); // pushes total to 300 > 200
    expect(await cache.has('blob:1')).toBe(true);
    expect(await cache.has('blob:3')).toBe(true);
    expect(await cache.has('blob:2')).toBe(false);
  });

  it('enforces the cap across two instances/writers on the same dir', async () => {
    const a = new SharedResourceCache({ cacheDir: dir, maxBytes: 300, log: noop });
    const b = new SharedResourceCache({ cacheDir: dir, maxBytes: 300, log: noop });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 === 0 ? a : b).set(`blob:${i}`, Buffer.alloc(100, i)),
      ),
    );
    expect(await uniqueContentBytes(dir)).toBeLessThanOrEqual(300);
  });

  it('protects pinned listing snapshots before evicting ordinary blobs', async () => {
    const cache = new SharedResourceCache({ cacheDir: dir, maxBytes: 160, log: noop });
    await cache.set('list:', Buffer.alloc(60, 1), { crawlerPinned: true });
    await cache.set('blob:old', Buffer.alloc(100, 2));
    await cache.set('blob:new', Buffer.alloc(100, 3));
    expect(await cache.has('list:')).toBe(true);
    expect(await cache.has('blob:new')).toBe(true);
    expect(await cache.has('blob:old')).toBe(false);
    expect(await uniqueContentBytes(dir)).toBeLessThanOrEqual(160);
  });

  it('never prunes when unbounded (maxBytes = 0)', async () => {
    const cache = new SharedResourceCache({
      cacheDir: dir,
      maxBytes: 0,
      pruneThresholdBytes: 0,
      log: noop,
    });
    for (let i = 0; i < 10; i++) await cache.set(`blob:${i}`, Buffer.alloc(1000, i));
    expect(await uniqueContentBytes(dir)).toBe(10_000);
  });
});

describe('createSharedResourceCache', () => {
  it('shares one physical root while isolating logical keys by remote namespace', async () => {
    const identity = { host: 'h', account: 'a', container: 'c' };
    const otherIdentity = { ...identity, account: 'other' };
    const cache = createSharedResourceCache({ identity, baseDir: dir, maxBytes: 300, log: noop });
    const other = createSharedResourceCache({
      identity: otherIdentity,
      baseDir: dir,
      maxBytes: 300,
      log: noop,
    });
    expect(cache.directory).toBe(dir);
    expect(other.directory).toBe(dir);
    await cache.set('blob:same-key', Buffer.from('first'));
    await other.set('blob:same-key', Buffer.from('second'));
    expect((await cache.get('blob:same-key'))?.data.toString()).toBe('first');
    expect((await other.get('blob:same-key'))?.data.toString()).toBe('second');
  });

  it('applies one global cap across distinct remote namespaces', async () => {
    const a = createSharedResourceCache({
      identity: { host: 'h', account: 'a', container: 'c' },
      baseDir: dir,
      maxBytes: 150,
      log: noop,
    });
    const b = createSharedResourceCache({
      identity: { host: 'h', account: 'b', container: 'c' },
      baseDir: dir,
      maxBytes: 150,
      log: noop,
    });
    await a.set('blob:a', Buffer.alloc(100, 1));
    await b.set('blob:b', Buffer.alloc(100, 2));
    expect(await uniqueContentBytes(dir)).toBeLessThanOrEqual(150);
  });
});
