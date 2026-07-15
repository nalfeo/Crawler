import assert from 'node:assert/strict';
import test from 'node:test';
import { createRefreshCache } from '../lib/refresh-cache.mjs';

function makeEntry(updatedAt, config = {}) {
  return { config, data: { updatedAt }, refreshPromise: undefined, refreshController: undefined };
}

function fixedNow(ms) {
  return () => ms;
}

test('returns cached data when age is below the 120 s TTL', async () => {
  const now = Date.now();
  const entry = makeEntry(new Date(now - 60_000).toISOString());
  let calls = 0;
  const refreshEntry = createRefreshCache(async () => {
    calls += 1;
    return { updatedAt: new Date().toISOString() };
  }, fixedNow(now));

  const result = await refreshEntry(entry);
  assert.equal(result, entry.data);
  assert.equal(calls, 0);
});

test('calls queryFn and updates entry when data is stale', async () => {
  const now = Date.now();
  const freshData = { updatedAt: new Date(now).toISOString(), value: 'new' };
  const entry = makeEntry(new Date(now - 180_000).toISOString());
  const refreshEntry = createRefreshCache(async () => freshData, fixedNow(now));

  const result = await refreshEntry(entry);
  assert.equal(result, freshData);
  assert.equal(entry.data, freshData);
});

test('deduplicates concurrent refresh calls (queryFn invoked once)', async () => {
  const now = Date.now();
  let calls = 0;
  let resolveQuery;
  const queryPromise = new Promise((resolve) => {
    resolveQuery = resolve;
  });
  const entry = makeEntry(new Date(now - 180_000).toISOString());
  const refreshEntry = createRefreshCache(async (_config, _signal) => {
    calls += 1;
    return queryPromise;
  }, fixedNow(now));

  const p1 = refreshEntry(entry);
  const p2 = refreshEntry(entry);
  const freshData = { updatedAt: new Date(now).toISOString() };
  resolveQuery(freshData);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1);
  assert.equal(r1, freshData);
  assert.equal(r2, freshData);
});

test('clears refreshPromise and refreshController after failure so next call retries', async () => {
  const now = Date.now();
  let calls = 0;
  const entry = makeEntry(new Date(now - 180_000).toISOString());
  const refreshEntry = createRefreshCache(async () => {
    calls += 1;
    throw new Error('transient');
  }, fixedNow(now));

  await assert.rejects(() => refreshEntry(entry), /transient/);
  assert.equal(entry.refreshPromise, undefined);
  assert.equal(entry.refreshController, undefined);
  assert.equal(calls, 1);

  // Second call after failure should trigger a new attempt
  await assert.rejects(() => refreshEntry(entry), /transient/);
  assert.equal(calls, 2);
});

test('passes an AbortSignal to queryFn and abort cancels the in-flight refresh', async () => {
  const now = Date.now();
  let capturedSignal;
  let resolveQuery;
  const entry = makeEntry(new Date(now - 180_000).toISOString());
  const refreshEntry = createRefreshCache(async (_config, signal) => {
    capturedSignal = signal;
    return new Promise((_resolve, reject) => {
      resolveQuery = reject;
    });
  }, fixedNow(now));

  const pendingRefresh = refreshEntry(entry);
  assert.ok(capturedSignal instanceof AbortSignal);

  entry.refreshController.abort(new Error('cancelled'));
  resolveQuery(new Error('cancelled'));

  await assert.rejects(() => pendingRefresh, /cancelled/);
});
