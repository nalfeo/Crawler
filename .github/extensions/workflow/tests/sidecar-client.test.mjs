/**
 * Unit tests for the workflow extension's copy of the vendored sidecar client.
 *
 * B1 uses only the READ / run-inspection surface (the read-only workflow-state +
 * asset-request helpers moved to the follow-up write slice B2, since a status
 * read with no controls is a half-feature). We cover the retained url builders
 * and `listRuns` here with a fake fetchImpl (no live sidecar); the shared
 * normalizers are covered by sprite-review's suite. Importing
 * `createSidecarClient` also proves the `../../../../scripts/shared/...` import
 * graph resolves from THIS extension's on-disk location (a wrong relative depth
 * would throw at import time).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runsUrl,
  runSummaryUrl,
  sheetUrl,
  sliceMapUrl,
  acceptUrl,
  createSidecarClient,
} from '../lib/sidecar-client.mjs';

const BASE = 'http://127.0.0.1:3999';
const EXPECTED_VERSION = '0.3.0-managed';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    headers: { get: () => 'application/json' },
  };
}

test('runsUrl omits the query by default and only adds a promoted filter when narrowed', () => {
  assert.equal(runsUrl(BASE), `${BASE}/api/runs`);
  // 'all' is the no-op default → no query param.
  assert.equal(runsUrl(BASE, { promoted: 'all' }), `${BASE}/api/runs`);
  assert.equal(runsUrl(BASE, { promoted: 'promoted' }), `${BASE}/api/runs?promoted=promoted`);
});

test('run/sheet/slice-map url builders encode their path + query segments', () => {
  assert.equal(runSummaryUrl(BASE, 'a b', 'r/1'), `${BASE}/api/runs/a%20b/r%2F1`);
  assert.equal(sheetUrl(BASE, 'b', 'r', 's 1.png'), `${BASE}/api/runs/b/r/sheet/s%201.png`);
  assert.equal(
    sliceMapUrl(BASE, 'b', 'r', 'sheet 1.png'),
    `${BASE}/api/runs/b/r/slice-map?sheet=sheet%201.png`,
  );
  // No sheet → bare slice-map endpoint (no query).
  assert.equal(sliceMapUrl(BASE, 'b', 'r'), `${BASE}/api/runs/b/r/slice-map`);
  assert.equal(acceptUrl(BASE, 'a b', 'r/1'), `${BASE}/api/runs/a%20b/r%2F1/accept`);
});

test('listRuns returns the runs array from the sidecar payload with no-store caching', async () => {
  const calls = [];
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ runs: [{ briefId: 'b', runId: 'r', candidateCount: 3 }] });
    },
  });
  const runs = await client.listRuns();
  assert.equal(calls[0].url, `${BASE}/api/runs`);
  assert.equal(calls[0].opts.cache, 'no-store');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].briefId, 'b');
  assert.equal(runs[0].candidateCount, 3);
});

test('listRuns degrades to [] when the payload has no runs array', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({ nope: true }),
  });
  assert.deepEqual(await client.listRuns(), []);
});

test('listRuns throws on a non-OK response', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async () => jsonResponse({}, false, 503),
  });
  await assert.rejects(() => client.listRuns(), /Failed to load sidecar runs/);
});

test('acceptVariant posts the selected index and returns durable queue state', async () => {
  const calls = [];
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        state: 'queued',
        existing: false,
        issueUrl: 'https://github.com/nalfeo/Crawler/issues/99',
      });
    },
  });

  const result = await client.acceptVariant('iron sword', 'run/1', 3);

  assert.equal(calls[0].url, `${BASE}/api/runs/iron%20sword/run%2F1/accept`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { variantIndex: 3 });
  assert.equal(result.state, 'queued');
});

test('acceptVariant surfaces the sidecar error code and actionable message', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      jsonResponse(
        { error: 'gh-failed', message: 'GitHub authentication expired; run gh auth login.' },
        false,
        502,
      ),
  });

  await assert.rejects(
    () => client.acceptVariant('iron-sword', 'run-1', 1),
    (error) =>
      error.code === 'gh-failed' && error.status === 502 && /gh auth login/.test(error.message),
  );
});

test('probeHealth stays down for a stale sidecar version', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: async () =>
      jsonResponse({
        status: 'ok',
        repoRoot: '/repo/a',
        version: '0.2.0-workflow',
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
      }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
});

test('probeHealth reports up for the current managed sidecar version', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: async () =>
      jsonResponse({
        status: 'ok',
        repoRoot: '/repo/a',
        version: EXPECTED_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
      }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'up');
  assert.equal(health.version, EXPECTED_VERSION);
});
