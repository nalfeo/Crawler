/**
 * Unit tests for the sprite sidecar domain adapter. Every network path uses an
 * injected fake `fetchImpl`, so these run with no live sidecar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_SIDECAR_FALLBACK,
  resolveSidecarBaseUrl,
  healthUrl,
  runsUrl,
  runSummaryUrl,
  runPostprocessUrl,
  sheetsUrl,
  sheetUrl,
  processedUrl,
  rawUrl,
  sliceMapUrl,
  candidateStatus,
  describeJudgeSkipReason,
  toJudgeSummary,
  toSensorResults,
  parseCandidateDetail,
  normalizeCandidate,
  normalizeCandidates,
  extractVariantIndices,
  normalizeSliceMap,
  createSidecarClient,
} from '../lib/sidecar-client.mjs';

const BASE = 'http://127.0.0.1:17790';
const EXPECTED_VERSION = '0.3.0-managed';

/** Build a fake fetch that maps URL substrings to canned responses. */
function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const r = routes[key];
    if (r instanceof Error) throw r;
    return {
      ok: r.status === undefined ? true : r.status >= 200 && r.status < 300,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: async () => r.json,
    };
  };
}

test('URL builders match the sidecar routes and encode segments', () => {
  assert.equal(healthUrl(BASE), `${BASE}/api/health`);
  assert.equal(runsUrl(BASE), `${BASE}/api/runs`);
  assert.equal(runsUrl(BASE, { promoted: 'promoted' }), `${BASE}/api/runs?promoted=promoted`);
  assert.equal(runsUrl(BASE, { promoted: 'all' }), `${BASE}/api/runs`);
  assert.equal(runSummaryUrl(BASE, 'b', 'r'), `${BASE}/api/runs/b/r`);
  assert.equal(runPostprocessUrl(BASE, 'b', 'r'), `${BASE}/api/runs/b/r/postprocess`);
  assert.equal(runPostprocessUrl(BASE, 'a b', 'r/1'), `${BASE}/api/runs/a%20b/r%2F1/postprocess`);
  assert.equal(sheetsUrl(BASE, 'b', 'r'), `${BASE}/api/runs/b/r/sheets`);
  assert.equal(sheetUrl(BASE, 'b', 'r', 'a b.png'), `${BASE}/api/runs/b/r/sheet/a%20b.png`);
  assert.equal(processedUrl(BASE, 'b', 'r', '00.png'), `${BASE}/api/runs/b/r/processed/00.png`);
  assert.equal(rawUrl(BASE, 'b', 'r', '00.png'), `${BASE}/api/runs/b/r/raw/00.png`);
  assert.equal(sliceMapUrl(BASE, 'b', 'r'), `${BASE}/api/runs/b/r/slice-map`);
  assert.equal(sliceMapUrl(BASE, 'b', 'r', 's.png'), `${BASE}/api/runs/b/r/slice-map?sheet=s.png`);
});

test('resolveSidecarBaseUrl honours the env override and trims a trailing slash', () => {
  assert.equal(
    resolveSidecarBaseUrl({ env: { VITE_SPRITES_SIDECAR_BASE_URL: 'http://host:9/' } }),
    'http://host:9',
  );
});

test('resolveSidecarBaseUrl derives a loopback URL from the workspace port', () => {
  const url = resolveSidecarBaseUrl({ workspacePath: process.cwd(), env: {} });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(!url.endsWith('/'));
});

test('LEGACY_SIDECAR_FALLBACK is the documented legacy port', () => {
  assert.equal(LEGACY_SIDECAR_FALLBACK, 'http://127.0.0.1:3010');
});

test('candidateStatus classifies the four states', () => {
  assert.deepEqual(candidateStatus({ combinedPassed: true }), { kind: 'pass', label: 'PASS' });
  assert.deepEqual(candidateStatus({ combinedPassed: false, passed: false }), {
    kind: 'sensor-failed',
    label: 'sensor fail',
  });
  assert.deepEqual(
    candidateStatus({ combinedPassed: false, passed: true, judge: { passed: false } }),
    {
      kind: 'judge-rejected',
      label: 'judge fail',
    },
  );
  assert.deepEqual(candidateStatus({ combinedPassed: false, passed: true, judge: null }), {
    kind: 'unjudged',
    label: 'not judged',
  });
});

test('describeJudgeSkipReason returns null once judged and messages otherwise', () => {
  assert.equal(describeJudgeSkipReason('over-cap', true), null);
  assert.match(describeJudgeSkipReason('over-cap', false), /top variants/);
  assert.match(describeJudgeSkipReason('judge-disabled', false), /disabled/);
  assert.match(describeJudgeSkipReason('anything-else', false), /run Judge/);
});

test('toJudgeSummary reads axis scores and defaults missing axes to 0', () => {
  assert.equal(toJudgeSummary(null), null);
  const s = toJudgeSummary({
    passed: true,
    minScore: 3,
    styleMatch: { score: 4 },
    briefMatch: { score: 3 },
    readability: {},
    rejectedBy: ['x', 5],
  });
  assert.deepEqual(s, {
    passed: true,
    minScore: 3,
    designLanguage: 0,
    referenceStyleMatch: 4,
    styleMatch: 4,
    briefMatch: 3,
    readability: 0,
    poseOrientation: 0,
    bossPresence: 0,
    presentation: 0,
    themeAdherence: 0,
    rejectedBy: ['x'],
  });
});

test('toSensorResults maps pixel arrays to counts and skips malformed rows', () => {
  const rows = toSensorResults([
    { sensor: 'palette', ok: false, reason: 'off-palette', pixels: [1, 2, 3] },
    { sensor: 'silhouette', ok: true },
    { nope: true },
  ]);
  assert.deepEqual(rows, [
    { sensor: 'palette', ok: false, reason: 'off-palette', pixelCount: 3 },
    { sensor: 'silhouette', ok: true, reason: null, pixelCount: null },
  ]);
});

test('parseCandidateDetail extracts per-axis rationale + provenance', () => {
  const { judge, judgeSkipReason } = parseCandidateDetail({
    judgeScorecard: {
      passed: false,
      minScore: 2,
      rejectedBy: ['readability'],
      styleMatch: { rationale: 'clean' },
      readability: { rationale: 'blurry' },
      modelDeployment: 'gpt-x',
      judgedAt: '2026-07-09',
    },
    judgeSkipReason: null,
  });
  assert.equal(judge.modelDeployment, 'gpt-x');
  assert.equal(judge.rationale.styleMatch, 'clean');
  assert.equal(judge.rationale.readability, 'blurry');
  assert.equal(judge.rationale.briefMatch, null);
  assert.equal(judgeSkipReason, null);
});

test('normalizeCandidate + normalizeCandidates merge views and sort by index', () => {
  const summary = {
    candidates: [
      { index: 2, score: 5, outOf: 6, passed: true, combinedPassed: true },
      {
        index: 1,
        score: 3,
        outOf: 6,
        passed: true,
        combinedPassed: false,
        judgeScorecard: { passed: false, minScore: 2, styleMatch: { score: 2 } },
        breakdown: [{ sensor: 'palette', ok: false, reason: 'x', pixels: [1] }],
        judgeSkipReason: null,
      },
    ],
  };
  const list = normalizeCandidates(summary);
  assert.equal(list[0].index, 1);
  assert.equal(list[1].index, 2);
  assert.equal(list[0].judge.styleMatch, 2);
  assert.equal(list[0].sensors[0].pixelCount, 1);
  assert.equal(list[1].judge, null);
});

test('extractVariantIndices dedupes and falls back to position', () => {
  assert.deepEqual(
    extractVariantIndices({ candidates: [{ index: 3 }, {}, { index: 3 }, { index: 5 }] }),
    [3, 1, 5],
  );
});

test('normalizeSliceMap returns a healthy map with cells', () => {
  const map = normalizeSliceMap({
    sheetW: 128,
    sheetH: 64,
    rows: 1,
    cols: 2,
    cellW: 64,
    cellH: 64,
    rowOffsets: [0],
    colOffsets: [0, 64],
    cells: [
      { index: 0, row: 0, col: 0, x0: 0, y0: 0, w: 64, h: 64, empty: false },
      { index: -1, row: 0, col: 1, x0: 64, y0: 0, w: 64, h: 64, empty: true },
    ],
    sheetFile: 's.png',
    algorithm: 'content-aware',
    emptyCellsApplied: true,
  });
  assert.equal(map.ok, true);
  assert.equal(map.emptyCellsApplied, true);
  assert.equal(map.cells.length, 2);
  assert.equal(map.cells[0].w, 64);
});

test('normalizeSliceMap treats missing emptyCellsApplied as degraded', () => {
  const map = normalizeSliceMap({ sheetW: 10, sheetH: 10, cells: [] });
  assert.equal(map.ok, true);
  assert.equal(map.emptyCellsApplied, false);
});

test('normalizeSliceMap turns an error body into an ok:false map', () => {
  const map = normalizeSliceMap({ error: 'sheet-not-found' });
  assert.equal(map.ok, false);
  assert.equal(map.error, 'sheet-not-found');
  assert.deepEqual(map.cells, []);
});

test('client.listRuns / fetchSheets read the array payloads', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: fakeFetch({
      '/api/runs/b/r/sheets': { json: { files: ['a.png', 'b.png'] } },
      '/api/runs': { json: { runs: [{ briefId: 'b', runId: 'r', candidateCount: 4 }] } },
    }),
  });
  const runs = await client.listRuns();
  assert.equal(runs[0].candidateCount, 4);
  const sheets = await client.fetchSheets('b', 'r');
  assert.deepEqual(sheets, ['a.png', 'b.png']);
});

test('client.fetchSliceMap degrades (ok:false) on a non-2xx error body instead of throwing', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: fakeFetch({
      '/slice-map': { status: 404, statusText: 'Not Found', json: { error: 'sheet-not-found' } },
    }),
  });
  const map = await client.fetchSliceMap('b', 'r', 's.png');
  assert.equal(map.ok, false);
  assert.equal(map.error, 'sheet-not-found');
});

test('client.listRuns throws on a non-2xx response', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: fakeFetch({ '/api/runs': { status: 500, statusText: 'Boom', json: {} } }),
  });
  await assert.rejects(() => client.listRuns(), /Failed to load sidecar runs/);
});

test('probeHealth: up when the sidecar answers for the matching repo', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: fakeFetch({
      '/api/health': {
        json: {
          status: 'ok',
          repoRoot: '/repo/a',
          version: EXPECTED_VERSION,
          storeBackend: 'azure-blob',
          queueBackend: 'azure-queue',
          worker: { running: true },
          issueIngester: { running: true },
        },
      },
    }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'up');
  assert.equal(health.version, EXPECTED_VERSION);
  assert.equal(health.storeBackend, 'azure-blob');
});

test('probeHealth: down when azure queue controllers are not ready', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: fakeFetch({
      '/api/health': {
        json: {
          status: 'ok',
          repoRoot: '/repo/a',
          version: EXPECTED_VERSION,
          queueBackend: 'azure-queue',
          worker: { running: false },
          issueIngester: { running: true },
        },
      },
    }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
});

test('probeHealth: down when the sidecar version is stale', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: fakeFetch({
      '/api/health': {
        json: {
          status: 'ok',
          repoRoot: '/repo/a',
          version: '0.2.0-workflow',
          queueBackend: 'azure-queue',
          worker: { running: true },
          issueIngester: { running: true },
        },
      },
    }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
});

test('probeHealth: wrong-repo when the sidecar serves a different checkout', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: fakeFetch({ '/api/health': { json: { repoRoot: '/repo/b' } } }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'wrong-repo');
  assert.equal(health.repoRoot, '/repo/b');
  assert.equal(health.expectedRepoRoot, '/repo/a');
});

test('probeHealth: down on a network error', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: fakeFetch({ '/api/health': new Error('ECONNREFUSED') }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
});

test('probeHealth: down on a non-2xx health response', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    workspaceRoot: '/repo/a',
    fetchImpl: fakeFetch({ '/api/health': { status: 503, statusText: 'Unavailable', json: {} } }),
  });
  const health = await client.probeHealth();
  assert.equal(health.state, 'down');
  assert.equal(health.httpStatus, 503);
});
