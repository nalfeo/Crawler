/**
 * Unit tests for the reusable on-disk image cache (traversal safety, hit/miss,
 * content-type roundtrip, disabled degrade, and fetch-through pass-through),
 * using a throwaway temp dir. Exercises the VENDORED copy the extension loads;
 * the drift test guarantees it is byte-identical to canonical.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { createImageCache, resolveCopilotHome, resolveExtCacheDir } from '../lib/image-cache.mjs';

let root;
let cache;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sprite-review-cache-'));
  cache = createImageCache({ dir: path.join(root, 'cache') });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('resolveCopilotHome honours COPILOT_HOME then falls back to ~/.copilot', () => {
  assert.equal(resolveCopilotHome({ COPILOT_HOME: '/tmp/xyz' }), path.resolve('/tmp/xyz'));
  const fallback = resolveCopilotHome({});
  assert.ok(fallback.endsWith(path.join('.copilot')));
});

test('resolveExtCacheDir composes <home>/extensions/<name>/cache outside the worktree', () => {
  const dir = resolveExtCacheDir('sprite-review', { COPILOT_HOME: '/home/u/.copilot' });
  assert.equal(dir, path.resolve('/home/u/.copilot/extensions/sprite-review/cache'));
});

test('enabled cache creates its dir', () => {
  assert.equal(cache.enabled, true);
  assert.ok(existsSync(path.join(root, 'cache')));
});

test('entryPath rejects traversal, absolute, empty, and bad-charset segments', () => {
  assert.equal(cache.entryPath(['..', 'etc', 'passwd']), null);
  assert.equal(cache.entryPath(['sheet', '..', 'x']), null);
  assert.equal(cache.entryPath(['sheet', '', 'x']), null);
  assert.equal(cache.entryPath(['sheet', 'a/b', 'x']), null);
  assert.equal(cache.entryPath(['sheet', 'a\\b', 'x']), null);
  assert.equal(cache.entryPath([]), null);
  assert.equal(cache.entryPath('not-an-array'), null);
  // A valid key resolves under the cache root.
  const ok = cache.entryPath(['sheet', 'goblin', 'run-1', '00.png']);
  assert.ok(ok && ok.startsWith(path.resolve(root, 'cache')));
});

test('put then get roundtrips bytes + content-type', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const key = ['sheet', 'goblin', 'run-1', '00.png'];
  assert.equal(await cache.put(key, bytes, 'image/png'), true);
  const hit = await cache.get(key);
  assert.ok(hit);
  assert.deepEqual(hit.bytes, bytes);
  assert.equal(hit.contentType, 'image/png');
});

test('get returns null on miss', async () => {
  assert.equal(await cache.get(['sheet', 'ghost', 'run-9', '99.png']), null);
});

test('put rejects invalid keys and empty buffers without throwing', async () => {
  assert.equal(await cache.put(['..', 'x'], Buffer.from([1]), 'image/png'), false);
  assert.equal(await cache.put(['sheet', 'a', 'b', 'c.png'], Buffer.alloc(0), 'image/png'), false);
});

test('put leaves no .tmp files behind (atomic rename)', async () => {
  const dir = path.join(root, 'cache', 'sheet', 'goblin', 'run-1');
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('fetchThrough serves a cached HIT without calling fetchFn', async () => {
  const key = ['sheet', 'goblin', 'run-1', '00.png'];
  let called = false;
  const result = await cache.fetchThrough(key, () => {
    called = true;
    return new Response('x');
  });
  assert.equal(called, false);
  assert.equal(result.hit, true);
  assert.equal(result.contentType, 'image/png');
});

test('fetchThrough caches a successful MISS; the next call is a HIT', async () => {
  const key = ['processed', 'rat', 'run-2', '01.png'];
  const payload = Buffer.from([10, 20, 30, 40]);
  const miss = await cache.fetchThrough(
    key,
    () => new Response(payload, { headers: { 'content-type': 'image/png' } }),
  );
  assert.equal(miss.hit, false);
  assert.equal(miss.cached, true);
  assert.deepEqual(miss.bytes, payload);
  assert.equal(miss.contentType, 'image/png');

  const hit = await cache.fetchThrough(key, () => {
    throw new Error('should not fetch on a hit');
  });
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.bytes, payload);
});

test('fetchThrough passes a non-OK response straight through, uncached', async () => {
  const key = ['sheet', 'missing', 'run-3', '02.png'];
  const result = await cache.fetchThrough(key, () => new Response('nope', { status: 404 }));
  assert.equal(result.hit, false);
  assert.ok(result.response);
  assert.equal(result.response.status, 404);
  assert.equal(await cache.get(key), null); // not cached
});

test('fetchThrough passes a bodyless response through, uncached', async () => {
  const key = ['sheet', 'empty', 'run-4', '03.png'];
  const result = await cache.fetchThrough(key, () => new Response(null, { status: 204 }));
  assert.equal(result.hit, false);
  assert.ok(result.response);
  assert.equal(await cache.get(key), null);
});

test('invalid key still serves bytes via fetchThrough but does not cache', async () => {
  const payload = Buffer.from([7, 7, 7]);
  const result = await cache.fetchThrough(
    ['sheet', '..', 'x'],
    () => new Response(payload, { headers: { 'content-type': 'image/png' } }),
  );
  assert.equal(result.hit, false);
  assert.equal(result.cached, false);
  assert.deepEqual(result.bytes, payload);
});

test('a disabled cache (no dir) degrades to transparent pass-through', async () => {
  const disabled = createImageCache({});
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.entryPath(['sheet', 'a', 'b', 'c.png']), null);
  assert.equal(await disabled.get(['sheet', 'a', 'b', 'c.png']), null);
  assert.equal(
    await disabled.put(['sheet', 'a', 'b', 'c.png'], Buffer.from([1]), 'image/png'),
    false,
  );
  const payload = Buffer.from([1, 2]);
  const result = await disabled.fetchThrough(
    ['sheet', 'a', 'b', 'c.png'],
    () => new Response(payload, { headers: { 'content-type': 'image/png' } }),
  );
  assert.equal(result.hit, false);
  assert.equal(result.cached, false);
  assert.deepEqual(result.bytes, payload);
});
