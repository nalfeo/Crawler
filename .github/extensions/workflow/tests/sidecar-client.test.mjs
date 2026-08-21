/**
 * Unit tests for the workflow extension's copy of the vendored sidecar client.
 *
 * Merged from the now-removed standalone Sprite Review canvas's suite when
 * Sprite Review's variant-inspection surface (judge/sensor normalizers,
 * slice-map, health-probe edge cases) was absorbed into this canvas — Workflow
 * is now the ONLY consumer of these normalizers, so it is also the only place
 * they are unit-tested. Importing `createSidecarClient` also proves the
 * `../../../../scripts/shared/...` import graph resolves from THIS extension's
 * on-disk location (a wrong relative depth would throw at import time).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_SIDECAR_FALLBACK,
  resolveSidecarBaseUrl,
  runsUrl,
  runSummaryUrl,
  sheetUrl,
  sliceMapUrl,
  acceptUrl,
  deleteManifestUrl,
  runPostprocessUrl,
  workflowStateUrl,
  workflowSynthesizeUrl,
  workflowBriefUrl,
  workflowPromoteUrl,
  workflowGenerateUrl,
  workflowMetadataUrl,
  workflowLatestRunUrl,
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
  JUDGE_AXES,
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
  assert.equal(
    deleteManifestUrl(BASE, 'goblin-archer-var-0'),
    `${BASE}/api/manifest/goblin-archer-var-0`,
  );
  assert.equal(deleteManifestUrl(BASE, 'a b'), `${BASE}/api/manifest/a%20b`);
  // The embedded Postprocess Debugger (`/postprocess/*` under this canvas)
  // reuses THIS client, so it needs the persist-postprocess URL builder too —
  // kept 1:1 with `postprocess/lib/sidecar-client.mjs`'s own copy.
  assert.equal(runPostprocessUrl(BASE, 'b', 'r'), `${BASE}/api/runs/b/r/postprocess`);
  assert.equal(runPostprocessUrl(BASE, 'a b', 'r/1'), `${BASE}/api/runs/a%20b/r%2F1/postprocess`);
});

test('client.urls.runPostprocess is wired to the same builder', () => {
  const client = createSidecarClient({ baseUrl: BASE, fetchImpl: async () => jsonResponse({}) });
  assert.equal(client.urls.runPostprocess('b', 'r'), runPostprocessUrl(BASE, 'b', 'r'));
});

test('workflow authoring client uses the sidecar workflow contracts and ETags', async () => {
  const calls = [];
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/state') && options.method === 'PUT')
        return jsonResponse({ ok: true, etag: 'next' });
      if (url.includes('/latest-run'))
        return jsonResponse({ run: { briefId: 'rusty-anvil', runId: 'run-1' } });
      if (url.endsWith('/state')) return jsonResponse({ state: { items: [] }, etag: 'before' });
      return jsonResponse({
        written: [],
        briefPath: 'briefs/draft/rusty-anvil.yaml',
        status: 'queued',
      });
    },
  });
  assert.equal(workflowStateUrl(BASE), `${BASE}/api/workflow/state`);
  assert.equal(workflowSynthesizeUrl(BASE), `${BASE}/api/workflow/synthesize`);
  assert.equal(workflowBriefUrl(BASE), `${BASE}/api/workflow/brief`);
  assert.equal(workflowPromoteUrl(BASE), `${BASE}/api/workflow/promote-brief`);
  assert.equal(workflowGenerateUrl(BASE), `${BASE}/api/workflow/generate`);
  assert.equal(workflowMetadataUrl(BASE), `${BASE}/api/workflow/metadata`);
  assert.equal(
    workflowLatestRunUrl(BASE, 'rusty anvil', '2026-08-21T00:00:00.000Z'),
    `${BASE}/api/workflow/latest-run?briefId=rusty%20anvil&requestedAt=2026-08-21T00%3A00%3A00.000Z`,
  );
  assert.deepEqual(await client.getWorkflowState(), { state: { items: [] }, etag: 'before' });
  await client.putWorkflowState({ items: [] }, 'before');
  const detailedRequest =
    'Eight-direction walk cycle: face every cardinal and diagonal direction; 32px readable silhouette, detailed rust texture.';
  await client.synthesizeWorkflow({ name: 'rusty-anvil', brief: detailedRequest });
  await client.saveWorkflowBrief('briefs/draft/rusty-anvil.yaml', 'name: rusty-anvil');
  await client.promoteWorkflowBrief('briefs/draft/rusty-anvil.yaml', 'prop', 'rusty-anvil');
  await client.generateWorkflow('briefs/draft/rusty-anvil.yaml');
  await client.generateWorkflowMetadata(['rusty-anvil']);
  assert.deepEqual(await client.latestWorkflowRun('rusty-anvil', '2026-08-21T00:00:00.000Z'), {
    briefId: 'rusty-anvil',
    runId: 'run-1',
  });
  assert.equal(calls[1].options.headers['If-Match'], 'before');
  assert.equal(calls[2].options.method, 'POST');
  assert.match(calls[2].options.body, /rusty-anvil/);
  assert.match(calls[2].options.body, /Eight-direction walk cycle/);
  assert.match(calls[2].options.body, /32px readable silhouette/);
  assert.equal(calls[3].options.method, 'PUT');
  assert.equal(calls[4].options.method, 'POST');
  assert.equal(calls[5].options.method, 'POST');
  assert.equal(calls[6].options.method, 'POST');
  assert.match(calls[6].options.body, /"minScore":70/);
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

test('unapproveVariant sends DELETE to /api/manifest/:variantId and returns the evicted entry', async () => {
  const calls = [];
  const evicted = {
    briefId: 'goblin-archer',
    spriteName: 'goblin-archer-var-0',
    assetPath: 'generated/goblin-archer-var-0.png',
    approvedAt: '2026-01-01T00:00:00.000Z',
    variantIndex: 0,
  };
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(evicted);
    },
  });

  const result = await client.unapproveVariant('goblin-archer-var-0');

  assert.equal(calls[0].url, `${BASE}/api/manifest/goblin-archer-var-0`);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.deepEqual(result, evicted);
});

test('unapproveVariant surfaces the sidecar error code on 404 not-found', async () => {
  const client = createSidecarClient({
    baseUrl: BASE,
    fetchImpl: async () =>
      jsonResponse(
        { error: 'not-found', message: 'Variant "missing-var-0" is not in the manifest.' },
        false,
        404,
      ),
  });

  await assert.rejects(
    () => client.unapproveVariant('missing-var-0'),
    (error) =>
      error.code === 'not-found' &&
      error.status === 404 &&
      /not in the manifest/.test(error.message),
  );
});

test('client.urls.deleteManifest is wired to the same builder', () => {
  const client = createSidecarClient({ baseUrl: BASE, fetchImpl: async () => jsonResponse({}) });
  assert.equal(
    client.urls.deleteManifest('goblin-archer-var-0'),
    deleteManifestUrl(BASE, 'goblin-archer-var-0'),
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
          worker: { running: true },
          issueIngester: { running: false },
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

// ---- Ported from the removed sprite-review canvas's suite -----------------
// (Workflow is now the only surface using these normalizers.)

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
  assert.ok(normalizeCandidate(summary.candidates[0]));
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
