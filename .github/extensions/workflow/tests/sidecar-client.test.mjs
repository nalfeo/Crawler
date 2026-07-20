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
  createSidecarClient,
  JUDGE_AXES,
  toJudgeSummary,
} from '../lib/sidecar-client.mjs';

const BASE = 'http://127.0.0.1:3999';

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

  test('judge normalization exposes every current axis', () => {
    const raw = Object.fromEntries(
      JUDGE_AXES.map(({ key }, index) => [key, { score: (index % 5) + 1 }]),
    );
    raw.passed = true;
    raw.minScore = 1;
    raw.rejectedBy = ['pose_orientation'];
    const summary = toJudgeSummary(raw);
    for (const { key } of JUDGE_AXES) {
      assert.equal(typeof summary[key], 'number', `${key} should be normalized`);
    }
    assert.deepEqual(summary.rejectedBy, ['pose_orientation']);
  });
  await assert.rejects(() => client.listRuns(), /Failed to load sidecar runs/);
});
