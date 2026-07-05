/**
 * Unit tests for CachingRunStore + helpers.
 *
 * Uses a real temp directory for both the "inner" LocalRunStore and the
 * cache directory so the read-through, invalidate, and atomicity paths are
 * exercised at the filesystem level with no mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CachingRunStore,
  defaultAzureSheetCacheDir,
  isAzureCacheEnabled,
  isSheetKey,
  parseMaxCacheBytes,
} from '../../../scripts/sprites/store/caching-store.js';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { StoreNotFoundError, type RunStore } from '../../../scripts/sprites/store/types.js';

// A minimal counting wrapper so we can assert that repeat reads never hit
// the inner store when a cache entry exists.
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

const SHEET = 'iron-sword/run-abc/sheet-00.png';
const RAW = 'iron-sword/run-abc/raw/00.png';
const SUMMARY = 'iron-sword/run-abc/summary.json';

let innerDir: string;
let cacheDir: string;
let inner: CountingStore;
let store: CachingRunStore;

beforeEach(() => {
  innerDir = mkdtempSync(path.join(tmpdir(), 'crawler-cache-inner-'));
  cacheDir = mkdtempSync(path.join(tmpdir(), 'crawler-cache-outer-'));
  inner = new CountingStore(new LocalRunStore(innerDir));
  store = new CachingRunStore({ inner, cacheDir });
});

afterEach(() => {
  rmSync(innerDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('isSheetKey', () => {
  it('matches sheet-NN.png under briefId/runId/', () => {
    expect(isSheetKey('iron-sword/run-abc/sheet-00.png')).toBe(true);
    expect(isSheetKey('some-brief/run-XYZ/sheet-42.png')).toBe(true);
  });
  it('rejects non-sheet artifacts', () => {
    expect(isSheetKey('iron-sword/run-abc/raw/00.png')).toBe(false);
    expect(isSheetKey('iron-sword/run-abc/processed/00.png')).toBe(false);
    expect(isSheetKey('iron-sword/run-abc/summary.json')).toBe(false);
    expect(isSheetKey('sheet-00.png')).toBe(false);
    expect(isSheetKey('iron-sword/run-abc/subdir/sheet-00.png')).toBe(false);
  });
});

describe('CachingRunStore backend / resolve', () => {
  it('proxies backend tag from inner', () => {
    expect(store.backend).toBe('azure-blob');
  });
  it('resolve() forwards to inner', () => {
    expect(store.resolve(SHEET)).toBe(new LocalRunStore(innerDir).resolve(SHEET));
  });
});

describe('CachingRunStore get / put — sheet keys', () => {
  it('first get hits inner + populates cache; second get hits cache only', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await inner.put(SHEET, data);
    inner.puts = 0;

    const first = await store.get(SHEET);
    expect(first).toEqual(data);
    expect(inner.gets).toBe(1);

    const second = await store.get(SHEET);
    expect(second).toEqual(data);
    // Cache hit must NOT touch the inner store on the second read.
    expect(inner.gets).toBe(1);

    // Cache file lives under cacheDir with the same key layout.
    expect(existsSync(path.join(cacheDir, 'iron-sword', 'run-abc', 'sheet-00.png'))).toBe(true);
  });

  it('put mirrors into the cache so subsequent gets are cache hits', async () => {
    const data = Buffer.from('sheet-bytes');
    await store.put(SHEET, data);
    expect(inner.puts).toBe(1);

    const readback = await store.get(SHEET);
    expect(readback).toEqual(data);
    // Cache should have served this — inner.get never invoked.
    expect(inner.gets).toBe(0);
  });

  it('has() short-circuits to true when cache has the key', async () => {
    await store.put(SHEET, Buffer.from('x'));
    inner.has_ = 0;
    expect(await store.has(SHEET)).toBe(true);
    expect(inner.has_).toBe(0);
  });

  it('remove() invalidates cache before delegating', async () => {
    await store.put(SHEET, Buffer.from('x'));
    expect(existsSync(path.join(cacheDir, 'iron-sword', 'run-abc', 'sheet-00.png'))).toBe(true);

    await store.remove(SHEET);
    expect(existsSync(path.join(cacheDir, 'iron-sword', 'run-abc', 'sheet-00.png'))).toBe(false);
    expect(inner.removes).toBe(1);
    expect(await store.has(SHEET)).toBe(false);
  });

  it('propagates StoreNotFoundError from inner when key does not exist', async () => {
    await expect(store.get(SHEET)).rejects.toBeInstanceOf(StoreNotFoundError);
  });

  it('surfaces corrupt cache as a miss (falls through to inner)', async () => {
    const data = Buffer.from('fresh-from-azure');
    await inner.put(SHEET, data);
    // Simulate a torn / corrupt cache entry by writing a directory where the
    // file should be — statSync().isFile() will be false, so we should miss.
    const cachePath = path.join(cacheDir, 'iron-sword', 'run-abc');
    rmSync(cachePath, { recursive: true, force: true });
    // Instead: pre-write a directory at the cache file path.
    const filePath = path.join(cachePath, 'sheet-00.png');
    // mkdir + a stray file inside it makes filePath a directory.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(filePath, { recursive: true });

    const result = await store.get(SHEET);
    expect(result).toEqual(data);
    expect(inner.gets).toBe(1);
  });
});

describe('CachingRunStore get / put — non-sheet keys bypass cache', () => {
  it('non-sheet get always hits inner', async () => {
    const data = Buffer.from('raw-bytes');
    await inner.put(RAW, data);
    inner.gets = 0;

    await store.get(RAW);
    await store.get(RAW);
    expect(inner.gets).toBe(2);
    // Cache dir must stay empty for non-sheet keys.
    expect(existsSync(path.join(cacheDir, 'iron-sword', 'run-abc', 'raw', '00.png'))).toBe(false);
  });

  it('non-sheet put does not populate cache', async () => {
    await store.put(SUMMARY, Buffer.from('{}'));
    expect(existsSync(path.join(cacheDir, 'iron-sword', 'run-abc', 'summary.json'))).toBe(false);
  });

  it('non-sheet has() always delegates to inner', async () => {
    await store.put(RAW, Buffer.from('r'));
    inner.has_ = 0;
    await store.has(RAW);
    expect(inner.has_).toBe(1);
  });
});

describe('CachingRunStore list', () => {
  it('list() forwards to inner (never consults cache)', async () => {
    await inner.put(SHEET, Buffer.from('a'));
    await inner.put(RAW, Buffer.from('b'));
    const result = await store.list('iron-sword/run-abc/');
    expect(result).toContain(SHEET);
    expect(result).toContain(RAW);
    expect(inner.lists).toBe(1);
  });
});

describe('CachingRunStore custom shouldCache predicate', () => {
  it('honours a caller-supplied predicate (e.g. also cache raw PNGs)', async () => {
    const custom = new CachingRunStore({
      inner,
      cacheDir,
      shouldCache: (k) => k.endsWith('.png'),
    });
    await custom.put(RAW, Buffer.from('raw'));
    inner.gets = 0;
    await custom.get(RAW);
    expect(inner.gets).toBe(0);
  });
});

describe('CachingRunStore cache write safety', () => {
  it('cache write failure does not fail get()', async () => {
    const data = Buffer.from('data');
    await inner.put(SHEET, data);
    // Poison the cache dir by replacing it with a file — subsequent mkdir
    // under it will fail. The get() must still succeed with the inner bytes.
    rmSync(cacheDir, { recursive: true, force: true });
    writeFileSync(cacheDir, 'not-a-directory');
    const result = await store.get(SHEET);
    expect(result).toEqual(data);
  });

  it('cache write failure does not fail put()', async () => {
    rmSync(cacheDir, { recursive: true, force: true });
    writeFileSync(cacheDir, 'not-a-directory');
    await expect(store.put(SHEET, Buffer.from('x'))).resolves.toBeUndefined();
    // Inner still received the write.
    expect(await inner.has(SHEET)).toBe(true);
  });
});

describe('CachingRunStore path traversal guard', () => {
  it('normalises `..` segments so cache stays inside cacheDir', async () => {
    // `../` at the start of a key gets stripped by cachePath's guard.
    const evil = '../../etc/passwd';
    const dummyInner = new LocalRunStore(innerDir);
    const s = new CachingRunStore({
      inner: dummyInner,
      cacheDir,
      shouldCache: () => true,
    });
    await dummyInner.put(evil, Buffer.from('x'));
    await s.get(evil);
    // Anything written should be under cacheDir, never above it.
    expect(existsSync(path.join(cacheDir, 'etc', 'passwd'))).toBe(true);
  });
});

describe('defaultAzureSheetCacheDir', () => {
  it('respects SPRITES_AZURE_CACHE_DIR when set', () => {
    expect(
      defaultAzureSheetCacheDir(
        { SPRITES_AZURE_CACHE_DIR: '/custom/cache' },
        () => '/home/u',
        'linux',
      ),
    ).toBe('/custom/cache');
  });

  it('uses LOCALAPPDATA on win32', () => {
    const dir = defaultAzureSheetCacheDir(
      { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      () => 'C:\\Users\\u',
      'win32',
    );
    expect(dir).toContain('Crawler');
    expect(dir).toContain('sprite-sheets');
    expect(dir.startsWith('C:\\Users\\u\\AppData\\Local')).toBe(true);
  });

  it('falls back to XDG_CACHE_HOME on non-Windows', () => {
    const dir = defaultAzureSheetCacheDir({ XDG_CACHE_HOME: '/xdg' }, () => '/home/u', 'linux');
    expect(dir).toBe(path.join('/xdg', 'crawler', 'sprite-sheets'));
  });

  it('falls back to ~/.cache when nothing else is set', () => {
    const dir = defaultAzureSheetCacheDir({}, () => '/home/u', 'linux');
    expect(dir).toBe(path.join('/home/u', '.cache', 'crawler', 'sprite-sheets'));
  });

  it('ignores empty override / LOCALAPPDATA / XDG values', () => {
    const dir = defaultAzureSheetCacheDir(
      { SPRITES_AZURE_CACHE_DIR: '', LOCALAPPDATA: '', XDG_CACHE_HOME: '' },
      () => '/home/u',
      'linux',
    );
    expect(dir).toBe(path.join('/home/u', '.cache', 'crawler', 'sprite-sheets'));
  });
});

describe('isAzureCacheEnabled', () => {
  it('defaults to on', () => {
    expect(isAzureCacheEnabled({})).toBe(true);
  });
  it('respects explicit on', () => {
    expect(isAzureCacheEnabled({ SPRITES_AZURE_CACHE: 'on' })).toBe(true);
  });
  it.each(['off', 'OFF', '0', 'false', 'False'])('honours disable value %s', (v) => {
    expect(isAzureCacheEnabled({ SPRITES_AZURE_CACHE: v })).toBe(false);
  });
});

describe('parseMaxCacheBytes', () => {
  it('defaults to 2 GiB when unset', () => {
    expect(parseMaxCacheBytes({})).toBe(2 * 1024 * 1024 * 1024);
  });
  it('parses an explicit non-negative integer', () => {
    expect(parseMaxCacheBytes({ SPRITES_AZURE_CACHE_MAX_BYTES: '1048576' })).toBe(1048576);
  });
  it('treats 0 as unbounded (returns 0)', () => {
    expect(parseMaxCacheBytes({ SPRITES_AZURE_CACHE_MAX_BYTES: '0' })).toBe(0);
  });
  it('trims surrounding whitespace', () => {
    expect(parseMaxCacheBytes({ SPRITES_AZURE_CACHE_MAX_BYTES: '  2048  ' })).toBe(2048);
  });
  it.each(['', 'abc', '-5', '3.5', '1e6', '0x10', '  ', '9999999999999999999999'])(
    'falls back to the default for malformed value %j',
    (v) => {
      expect(parseMaxCacheBytes({ SPRITES_AZURE_CACHE_MAX_BYTES: v })).toBe(2 * 1024 * 1024 * 1024);
    },
  );
});

describe('CachingRunStore size-cap eviction', () => {
  const K1 = 'br/run-1/sheet-00.png';
  const K2 = 'br/run-2/sheet-00.png';
  const K3 = 'br/run-3/sheet-00.png';
  const K4 = 'br/run-4/sheet-00.png';
  const cachedPath = (key: string): string => path.join(cacheDir, ...key.split('/'));
  const chunk = (n: number): Buffer => Buffer.alloc(n, 1);

  it('evicts the oldest owned entries once the total exceeds the cap', async () => {
    const capped = new CachingRunStore({ inner, cacheDir, maxCacheBytes: 300 });
    await capped.put(K1, chunk(100));
    await capped.put(K2, chunk(100));
    await capped.put(K3, chunk(100));
    // All three fit exactly (300 <= 300): nothing evicted yet.
    expect(existsSync(cachedPath(K1))).toBe(true);

    // Make K1 the oldest, K3 the newest (deterministic mtime ordering).
    utimesSync(cachedPath(K1), 1000, 1000);
    utimesSync(cachedPath(K2), 2000, 2000);
    utimesSync(cachedPath(K3), 3000, 3000);

    // The 4th write pushes total to 400 > 300 → oldest (K1) is evicted.
    await capped.put(K4, chunk(100));

    expect(existsSync(cachedPath(K1))).toBe(false);
    expect(existsSync(cachedPath(K2))).toBe(true);
    expect(existsSync(cachedPath(K3))).toBe(true);
    expect(existsSync(cachedPath(K4))).toBe(true);
  });

  it('never evicts the just-written entry, even if it sorts oldest by mtime', async () => {
    const capped = new CachingRunStore({ inner, cacheDir, maxCacheBytes: 150 });
    await capped.put(K1, chunk(100));
    // Backdate the NEW write's target so K2 (written next, mtime≈now) looks
    // "older" than K1 — the exemption is by path identity, not mtime.
    const future = Math.floor(Date.now() / 1000) + 10_000;
    utimesSync(cachedPath(K1), future, future);

    await capped.put(K2, chunk(100)); // total 200 > 150

    // K2 is exempt (just written) so K1 is evicted despite its future mtime.
    expect(existsSync(cachedPath(K1))).toBe(false);
    expect(existsSync(cachedPath(K2))).toBe(true);
  });

  it('does not evict when unbounded (maxCacheBytes = 0)', async () => {
    const unbounded = new CachingRunStore({ inner, cacheDir, maxCacheBytes: 0 });
    for (const k of [K1, K2, K3, K4]) {
      await unbounded.put(k, chunk(1000));
    }
    for (const k of [K1, K2, K3, K4]) {
      expect(existsSync(cachedPath(k))).toBe(true);
    }
  });

  it('does not cache a single entry larger than the whole cap', async () => {
    const capped = new CachingRunStore({ inner, cacheDir, maxCacheBytes: 50 });
    const data = chunk(100);
    await capped.put(K1, data);
    // Oversized entry is never written to the cache…
    expect(existsSync(cachedPath(K1))).toBe(false);
    // …but the inner store still received it and reads still work.
    expect(await inner.has(K1)).toBe(true);
    expect(await capped.get(K1)).toEqual(data);
    // The failed-cache get must not have created a cache file either.
    expect(existsSync(cachedPath(K1))).toBe(false);
  });

  it('sweeps stale .tmp- staging files but keeps in-flight ones', async () => {
    const capped = new CachingRunStore({ inner, cacheDir, maxCacheBytes: 100_000 });
    const runDir = path.join(cacheDir, 'br', 'run-tmp');
    mkdirSync(runDir, { recursive: true });
    const stale = path.join(runDir, 'sheet-00.png.tmp-stale');
    const fresh = path.join(runDir, 'sheet-01.png.tmp-fresh');
    writeFileSync(stale, chunk(10));
    writeFileSync(fresh, chunk(10));
    const twoHoursAgoSec = Math.floor(Date.now() / 1000) - 2 * 3600;
    utimesSync(stale, twoHoursAgoSec, twoHoursAgoSec);

    // Any successful cacheable write triggers the housekeeping walk.
    await capped.put(K1, chunk(10));

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('does not delete unrelated files reached through a symlinked subdir', async () => {
    // Files the cache does not own must survive even if they live under a
    // symlink/junction inside the cache dir. Best-effort on platforms where
    // link creation is not permitted.
    const external = mkdtempSync(path.join(tmpdir(), 'crawler-cache-external-'));
    const secret = path.join(external, 'secret.bin');
    writeFileSync(secret, chunk(5000));
    let linked = false;
    try {
      symlinkSync(external, path.join(cacheDir, 'linked'), 'junction');
      linked = true;
    } catch {
      // Symlink/junction creation not permitted here — skip the link assertion.
    }

    const capped = new CachingRunStore({ inner, cacheDir, maxCacheBytes: 100 });
    await capped.put(K1, chunk(100));

    expect(existsSync(secret)).toBe(true);
    if (linked) {
      // Sanity: the external file is genuinely reachable through the link.
      expect(statSync(path.join(cacheDir, 'linked', 'secret.bin')).size).toBe(5000);
    }
    rmSync(external, { recursive: true, force: true });
  });
});
