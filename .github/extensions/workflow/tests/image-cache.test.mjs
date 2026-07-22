/**
 * Unit tests for the reusable image relay (pass-through), exercising the
 * VENDORED copy the extension loads; the drift test guarantees it is
 * byte-identical to canonical.
 *
 * Moved from the now-removed standalone Sprite Review canvas — Workflow
 * vendors a byte-identical copy of `lib/image-cache.mjs`.
 *
 * Since ADR 0065 the sidecar is the ONE authoritative cache. Extensions no
 * longer keep an isolated per-extension on-disk cache — this relay never writes
 * to disk. These tests assert that pass-through behavior and that no persistent
 * cache directory is created.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { createImageCache, resolveCopilotHome, resolveExtCacheDir } from '../lib/image-cache.mjs';

let root;
let cacheDir;
let cache;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'workflow-cache-'));
  cacheDir = path.join(root, 'cache');
  cache = createImageCache({ dir: cacheDir });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('resolveCopilotHome honours COPILOT_HOME then falls back to ~/.copilot', () => {
  assert.equal(resolveCopilotHome({ COPILOT_HOME: '/tmp/xyz' }), path.resolve('/tmp/xyz'));
  const fallback = resolveCopilotHome({});
  assert.ok(fallback.endsWith(path.join('.copilot')));
});

test('resolveExtCacheDir still composes the historical path (no longer written to)', () => {
  const dir = resolveExtCacheDir('workflow', { COPILOT_HOME: '/home/u/.copilot' });
  assert.equal(dir, path.resolve('/home/u/.copilot/extensions/workflow/cache'));
});

test('createImageCache is a disabled pass-through: no disk cache is created', () => {
  assert.equal(cache.enabled, false);
  assert.equal(cache.dir, '');
  // The provided dir must NOT be created — extensions own no persistent cache.
  assert.equal(existsSync(cacheDir), false);
});

test('entryPath always returns null (no on-disk entries)', () => {
  assert.equal(cache.entryPath(['sheet', 'goblin', 'run-1', '00.png']), null);
  assert.equal(cache.entryPath(['..', 'etc', 'passwd']), null);
});

test('get always misses and put never persists', async () => {
  const key = ['sheet', 'goblin', 'run-1', '00.png'];
  assert.equal(await cache.get(key), null);
  assert.equal(await cache.put(key, Buffer.from([1, 2, 3]), 'image/png'), false);
  assert.equal(await cache.get(key), null);
  assert.equal(existsSync(cacheDir), false);
});

test('fetchThrough relays a successful body as bytes without caching', async () => {
  const key = ['processed', 'rat', 'run-2', '01.png'];
  const payload = Buffer.from([10, 20, 30, 40]);
  const result = await cache.fetchThrough(
    key,
    () => new Response(payload, { headers: { 'content-type': 'image/png' } }),
  );
  assert.equal(result.hit, false);
  assert.equal(result.cached, false);
  assert.deepEqual(result.bytes, payload);
  assert.equal(result.contentType, 'image/png');

  // A subsequent call must fetch AGAIN — there is no local cache to hit.
  let called = false;
  const second = await cache.fetchThrough(key, () => {
    called = true;
    return new Response(payload, { headers: { 'content-type': 'image/png' } });
  });
  assert.equal(called, true);
  assert.equal(second.hit, false);
  assert.equal(existsSync(cacheDir), false);
});

test('fetchThrough passes a non-OK response straight through, uncached', async () => {
  const key = ['sheet', 'missing', 'run-3', '02.png'];
  const result = await cache.fetchThrough(key, () => new Response('nope', { status: 404 }));
  assert.equal(result.hit, false);
  assert.ok(result.response);
  assert.equal(result.response.status, 404);
});

test('fetchThrough passes a bodyless response through, uncached', async () => {
  const key = ['sheet', 'empty', 'run-4', '03.png'];
  const result = await cache.fetchThrough(key, () => new Response(null, { status: 204 }));
  assert.equal(result.hit, false);
  assert.ok(result.response);
});

test('a cache created with no dir behaves identically (transparent pass-through)', async () => {
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
