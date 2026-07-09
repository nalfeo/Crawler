/**
 * Unit tests for the storage domain adapter (`lib/storage-client.mjs`). Every
 * network path uses an injected fake `fetchImpl`, so these run with no live
 * sidecar and NEVER touch a real blob — the destructive `archiveRuns`/`deleteRuns`
 * paths are verified by asserting the REQUEST SHAPE (method / URL / body), not by
 * destroying data (project rule #10 + the Slice E destructive-ops brief).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  storageRunsUrl,
  storageEnrichUrl,
  storageArchiveUrl,
  storageDeleteUrl,
  classifyStorageKey,
  validateStorageKeys,
  normalizeStorageRuns,
  normalizeEnrichment,
  createStorageClient,
} from '../lib/storage-client.mjs';

const BASE = 'http://127.0.0.1:17790';

/** A fake fetch that records every call and returns one canned response. */
function recordingFetch(response = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {}),
    };
  };
  return { impl, calls };
}

// --- URL builders -----------------------------------------------------------

test('URL builders match the sidecar storage routes and encode the query', () => {
  assert.equal(storageRunsUrl(BASE), `${BASE}/api/storage/runs`);
  assert.equal(storageRunsUrl(BASE, { scope: 'active' }), `${BASE}/api/storage/runs?scope=active`);
  assert.equal(
    storageRunsUrl(BASE, { scope: 'archive', search: 'a b' }),
    `${BASE}/api/storage/runs?scope=archive&search=a+b`,
  );
  // Empty search is omitted (matches the monolith / sidecar default).
  assert.equal(
    storageRunsUrl(BASE, { scope: 'active', search: '' }),
    `${BASE}/api/storage/runs?scope=active`,
  );
  assert.equal(storageEnrichUrl(BASE), `${BASE}/api/storage/runs/enrich`);
  assert.equal(storageArchiveUrl(BASE), `${BASE}/api/storage/runs/archive`);
  assert.equal(storageDeleteUrl(BASE), `${BASE}/api/storage/runs/delete`);
});

// --- Key classification (mirrors the sidecar safeJoin + split parsing) -------

test('classifyStorageKey accepts well-formed active + archive keys', () => {
  assert.equal(classifyStorageKey('brief/run'), 'active');
  assert.equal(classifyStorageKey('archive/brief/run'), 'archive');
});

test('classifyStorageKey rejects malformed / traversal / unsafe keys', () => {
  assert.equal(classifyStorageKey(''), null);
  assert.equal(classifyStorageKey('brief'), null); // too few parts
  assert.equal(classifyStorageKey('brief/run/extra'), null); // too many parts
  assert.equal(classifyStorageKey('archive/brief'), null); // archive needs brief/run
  assert.equal(classifyStorageKey('archive/brief/run/extra'), null);
  assert.equal(classifyStorageKey('../run'), null); // '..' segment
  assert.equal(classifyStorageKey('brief/..'), null);
  assert.equal(classifyStorageKey('archive/../run'), null);
  assert.equal(classifyStorageKey('bri\\ef/run'), null); // backslash escape
  assert.equal(classifyStorageKey('brief/ru\u0000n'), null); // NUL
  assert.equal(classifyStorageKey('./run'), null); // '.' segment
  assert.equal(classifyStorageKey(42), null); // non-string
  assert.equal(classifyStorageKey(null), null);
});

// --- Batch validation --------------------------------------------------------

test('validateStorageKeys rejects empty / non-array batches without partial forwarding', () => {
  assert.deepEqual(validateStorageKeys([], { allowArchive: true }), {
    ok: false,
    message: 'No keys provided.',
    invalidKeys: [],
  });
  assert.equal(validateStorageKeys('nope', { allowArchive: true }).ok, false);
  assert.equal(validateStorageKeys(undefined).ok, false);
});

test('validateStorageKeys for ARCHIVE is active-only (archive-prefixed keys are invalid)', () => {
  assert.deepEqual(validateStorageKeys(['b/r'], { allowArchive: false }), {
    ok: true,
    invalidKeys: [],
  });
  const res = validateStorageKeys(['b/r', 'archive/b/r'], { allowArchive: false });
  assert.equal(res.ok, false);
  assert.deepEqual(res.invalidKeys, ['archive/b/r']);
});

test('validateStorageKeys for DELETE accepts both scopes but still rejects malformed keys', () => {
  assert.deepEqual(validateStorageKeys(['b/r', 'archive/b2/r2'], { allowArchive: true }), {
    ok: true,
    invalidKeys: [],
  });
  const res = validateStorageKeys(['b/r', '../evil', 'x/y/z'], { allowArchive: true });
  assert.equal(res.ok, false);
  assert.deepEqual(res.invalidKeys, ['../evil', 'x/y/z']);
});

// --- Normalizers -------------------------------------------------------------

test('normalizeStorageRuns keeps only well-formed rows and defaults timestamp/summaryKey', () => {
  const runs = normalizeStorageRuns({
    runs: [
      { briefId: 'b', runId: 'r', timestamp: '2026-01-01', summaryKey: 'b/r/summary.json' },
      { briefId: 'b2', runId: 'r2' }, // missing timestamp/summaryKey
      { briefId: 42, runId: 'r3' }, // bad briefId — dropped
      null,
    ],
  });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], {
    briefId: 'b',
    runId: 'r',
    timestamp: '2026-01-01',
    summaryKey: 'b/r/summary.json',
  });
  assert.deepEqual(runs[1], { briefId: 'b2', runId: 'r2', timestamp: null, summaryKey: null });
});

test('normalizeEnrichment returns an ARRAY and cannot smuggle a prototype key', () => {
  const list = normalizeEnrichment({
    enriched: [
      {
        briefId: '__proto__',
        runId: 'r',
        variantCount: 4,
        sheetFile: 'sheet-0.png',
        approvedCount: 2,
        firstApproved: { runId: 'r0', variantIndex: 3 },
        briefStored: true,
      },
      { briefId: 'b2', runId: 'r2' }, // sparse — defaults applied
    ],
  });
  assert.ok(Array.isArray(list), 'enrichment is transported as an array');
  assert.equal(list[0].briefId, '__proto__');
  assert.equal(list[0].approvedCount, 2);
  assert.deepEqual(list[0].firstApproved, { runId: 'r0', variantIndex: 3 });
  assert.deepEqual(list[1], {
    briefId: 'b2',
    runId: 'r2',
    variantCount: null,
    sheetFile: null,
    approvedCount: 0,
    firstApproved: null,
    briefStored: false,
  });
  // Object.prototype was not polluted by the '__proto__' briefId.
  assert.equal({}.polluted, undefined);
  // A non-array enriched payload degrades to [].
  assert.deepEqual(normalizeEnrichment({ enriched: { __proto__: { x: 1 } } }), []);
});

// --- Client construction -----------------------------------------------------

test('createStorageClient validates its inputs', () => {
  assert.throws(() => createStorageClient({}), /baseUrl/);
  assert.throws(() => createStorageClient({ baseUrl: BASE, fetchImpl: 123 }), /fetch/);
});

// --- Read paths --------------------------------------------------------------

test('listRuns issues a GET to the runs route and normalizes the payload', async () => {
  const { impl, calls } = recordingFetch({
    body: { scope: 'active', runs: [{ briefId: 'b', runId: 'r' }] },
  });
  const client = createStorageClient({ baseUrl: BASE, fetchImpl: impl });
  const runs = await client.listRuns({ scope: 'active', search: 'q' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/storage/runs?scope=active&search=q`);
  assert.equal((calls[0].init.method ?? 'GET').toUpperCase(), 'GET');
  assert.deepEqual(runs, [{ briefId: 'b', runId: 'r', timestamp: null, summaryKey: null }]);
});

test('listRuns throws on a non-2xx response', async () => {
  const { impl } = recordingFetch({ status: 500, body: {} });
  const client = createStorageClient({ baseUrl: BASE, fetchImpl: impl });
  await assert.rejects(() => client.listRuns({ scope: 'active' }), /HTTP 500/);
});

test('enrichRuns POSTs {scope, runs:[{briefId,runId}]}, stripping extra fields', async () => {
  const { impl, calls } = recordingFetch({ body: { scope: 'active', enriched: [] } });
  const client = createStorageClient({ baseUrl: BASE, fetchImpl: impl });
  await client.enrichRuns('active', [{ briefId: 'b', runId: 'r', extra: 'DROP' }]);
  assert.equal(calls[0].url, `${BASE}/api/storage/runs/enrich`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    scope: 'active',
    runs: [{ briefId: 'b', runId: 'r' }],
  });
});

// --- DESTRUCTIVE paths — assert REQUEST SHAPE only (never destroy data) ------

test('archiveRuns POSTs the exact keys batch to the archive route', async () => {
  const { impl, calls } = recordingFetch({ body: { ok: true, archived: ['b/r'], skipped: [] } });
  const client = createStorageClient({ baseUrl: BASE, fetchImpl: impl });
  const result = await client.archiveRuns(['b/r']);
  assert.equal(calls[0].url, `${BASE}/api/storage/runs/archive`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { keys: ['b/r'] });
  assert.deepEqual(result, { ok: true, archived: ['b/r'], skipped: [] });
});

test('deleteRuns POSTs the exact keys batch to the delete route', async () => {
  const { impl, calls } = recordingFetch({ body: { ok: true, deleted: ['b/r', 'archive/b2/r2'] } });
  const client = createStorageClient({ baseUrl: BASE, fetchImpl: impl });
  const result = await client.deleteRuns(['b/r', 'archive/b2/r2']);
  assert.equal(calls[0].url, `${BASE}/api/storage/runs/delete`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { keys: ['b/r', 'archive/b2/r2'] });
  assert.deepEqual(result, { ok: true, deleted: ['b/r', 'archive/b2/r2'] });
});

test('archiveRuns / deleteRuns surface the server message on a non-2xx response', async () => {
  const archive = recordingFetch({ status: 409, body: { message: 'degraded' } });
  await assert.rejects(
    () => createStorageClient({ baseUrl: BASE, fetchImpl: archive.impl }).archiveRuns(['b/r']),
    /storage archive failed: HTTP 409 \(degraded\)/,
  );
  const del = recordingFetch({ status: 502, body: { message: 'boom' } });
  await assert.rejects(
    () => createStorageClient({ baseUrl: BASE, fetchImpl: del.impl }).deleteRuns(['b/r']),
    /storage delete failed: HTTP 502 \(boom\)/,
  );
});
